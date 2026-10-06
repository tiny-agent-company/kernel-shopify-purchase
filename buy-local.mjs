// One real purchase on a Shopify store from a browser you run yourself (the Chrome on this machine,
// driven by Playwright), paid with the user's Agentcard Vault card. The shopping leg is Playwright
// (what your agent would do); the payment leg is the Agentcard SDK.
// Guide: https://docs.agentcard.sh/guides/complete-a-purchase-on-a-shopify-store-with-your-own-browser
import { chromium } from 'playwright-core';
import { VaultClient, attachToPlaywright } from '@agent-cards/sdk';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const env = (name, fallback) => { const v = process.env[name] ?? fallback; if (v === undefined || v === '') throw new Error(`set ${name}`); return v; };
const PRODUCT = env('PRODUCT_URL');
const MERCHANT = env('MERCHANT');
const USER_ID = env('AGENTCARD_USER_ID');
const BUYER = {
  email: env('BUYER_EMAIL'), first: env('BUYER_FIRST'), last: env('BUYER_LAST'),
  address1: env('BUYER_ADDRESS1'), address2: process.env.BUYER_ADDRESS2 ?? '', city: env('BUYER_CITY'), state: env('BUYER_STATE', 'California'), zip: env('BUYER_ZIP'),
};
const store = new URL(PRODUCT).origin;

fs.mkdirSync('shots-local', { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const shot = (page, name) => page.screenshot({ path: `shots-local/${name}.png` }).then(() => log('shot', name)).catch(() => {});

// 1. Your own browser: the Google Chrome installed on this machine, launched by Playwright. HEADED=1 shows the window.
//    Service workers off on the context: the SDK cannot see a request a worker owns.
// BROWSER_CHANNEL=chrome launches the Google Chrome on this machine; unset, Playwright's own Chromium (npx playwright-core install chromium).
const channel = process.env.BROWSER_CHANNEL;
const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: process.env.HEADED !== '1' });
log('browser', browser.version(), process.env.HEADED === '1' ? 'headed' : 'headless');
let settled = false;
let paymentAttempted = false;
try {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // 2. Shop: product → cart → checkout. The store's cookie notice sits over the checkout button.
  await page.goto(PRODUCT, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await shot(page, '01-product');
  await page.locator('form[action="/cart/add"] button[type=submit]').first().click();
  await page.waitForTimeout(3000);
  await page.goto(`${store}/cart`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const cookie = page.locator('button:has-text("Decline"), button:has-text("Accept")').first();
  if (await cookie.isVisible().catch(() => false)) await cookie.click();
  await shot(page, '02-cart');
  await page.getByRole('button', { name: /check ?out/i }).filter({ visible: true }).first().click();
  await page.waitForURL(/\/checkouts\//, { timeout: 60000 });
  await page.waitForTimeout(5000);

  // 3. Contact, payment method, billing address. Read the total after the address: tax depends on it.
  await page.fill('#email', BUYER.email);
  const optIn = page.locator('#marketing_opt_in');
  if (await optIn.isChecked().catch(() => false)) await optIn.uncheck({ force: true }).catch(() => {});
  await page.locator('#basic-creditCards').check({ force: true }).catch(() => page.getByText(/credit card/i).first().click());
  await page.waitForTimeout(2500);
  const field = (name) => page.locator(`[name=${name}]:visible`).first();
  await field('countryCode').selectOption({ label: 'United States' }).catch(() => {});
  await field('firstName').fill(BUYER.first);
  await field('lastName').fill(BUYER.last);
  await field('address1').fill(BUYER.address1);
  if (BUYER.address2) await field('address2').fill(BUYER.address2).catch(() => {});
  await field('city').fill(BUYER.city);
  await field('zone').selectOption({ label: BUYER.state }).catch(() => {});
  await field('postalCode').fill(BUYER.zip);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(4000);
  // Shop Pay recognises some emails and opens a code prompt over the page; close it.
  if (await page.getByText(/Confirm it.s you/i).first().isVisible().catch(() => false)) {
    await page.locator('[aria-label="Close"]').filter({ visible: true }).first().click().catch(() => page.keyboard.press('Escape'));
    await page.waitForTimeout(1500);
  }
  const readTotal = async () => {
    const m = (await page.locator('body').innerText().catch(() => '')).match(/Total\s*USD\s*\$([0-9]+\.[0-9]{2})/);
    return m ? Math.round(parseFloat(m[1]) * 100) : null;
  };
  await page.waitForLoadState('networkidle').catch(() => {});
  let totalCents = await readTotal();
  for (let i = 0; i < 5; i++) { await page.waitForTimeout(2000); const again = await readTotal(); if (again === totalCents) break; totalCents = again; }
  if (totalCents == null) throw new Error('the checkout shows no total yet; not attaching, not paying');
  log('total on the page:', totalCents, 'cents');
  await shot(page, '03-checkout-filled');

  // 4. Attach the Vault before anything touches the card fields.
  const vault = new VaultClient({ clientId: env('AGENTCARD_CLIENT_ID'), clientSecret: env('AGENTCARD_CLIENT_SECRET') });
  await vault.syncRegistry();
  let payClickedAt = null;
  const checkout = await attachToPlaywright(page, {
    vault,
    user: USER_ID,
    merchant: MERCHANT,
    ...(totalCents ? { amount: totalCents, currency: 'usd' } : {}),
    pageAmount: async () => { const c = await readTotal(); return c ? { amount: c, currency: 'usd' } : undefined; },
    timeoutMs: 15 * 60 * 1000,
    payClickedAt: () => payClickedAt,
    onApprovalUrl: (url) => {
      log('APPROVAL LINK (send it to the user, never to the agent):', url);
      // APPROVAL_LINK_COMMAND is how you reach the user: a shell command run with the link in $APPROVAL_URL
      // (a text, a push, a message in your product's thread). Without it the link is only printed.
      if (process.env.APPROVAL_LINK_COMMAND) execFile('/bin/sh', ['-c', process.env.APPROVAL_LINK_COMMAND], { env: { ...process.env, APPROVAL_URL: url } }, (err) => log(err ? 'approval link command failed: ' + err.message : 'approval link delivered'));
      fs.writeFileSync('shots-local/approval-url.txt', url + '\n'); },
    onStateChange: (s) => log(`state=${s.status}${s.reason ? ` reason=${s.reason}` : ''}${s.authorizationId ? ` auth=${s.authorizationId}` : ''}`),
    onEvent: (e) => log('event', e.type, e.detail ? JSON.stringify(e.detail).slice(0, 160) : ''),
    resolveMerchantResult: async () => {
      const body = await page.locator('body').innerText().catch(() => '');
      const order = body.match(/Confirmation\s*#\s*([A-Z0-9]+)/i) ?? body.match(/Order\s*#\s*([A-Z0-9]+)/i);
      if (order && /You.ve paid for your order|Your order is confirmed/.test(body)) return { status: 'completed', orderId: order[1] };
      if (/There was a problem|declined|could not be processed/i.test(body)) return { status: 'failed' };
      return { status: 'pending' };
    },
  });
  log('attached');

  // 5. A placeholder card in Shopify's card iframes (each holds a hidden honeypot input ahead of the real one), then Pay now, once.
  const cardField = (prefix) => page.frameLocator(`iframe[name^="card-fields-${prefix}-"]`).locator('input:not([data-honeypot-field])').filter({ visible: true }).first();
  const typeInto = async (prefix, value) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const input = cardField(prefix);
      await input.click({ timeout: 15000 });
      await input.fill('');
      await input.pressSequentially(value, { delay: 40 });
      await page.waitForTimeout(400);
      if ((await input.inputValue().catch(() => '')).replace(/\s/g, '').length >= value.length - 2) return;
    }
    throw new Error(`could not fill the card ${prefix} field`);
  };
  await typeInto('number', env('PLACEHOLDER_CARD_NUMBER', '4242424242424242'));
  await typeInto('expiry', '1234');
  await typeInto('verification_value', '123');
  await typeInto('name', `${BUYER.first} ${BUYER.last}`);
  await shot(page, '04-placeholder-card');
  const pay = page.locator('#checkout-pay-button, button[aria-label="Pay now"]').filter({ visible: true }).first();
  await pay.scrollIntoViewIfNeeded();
  payClickedAt = Date.now();
  paymentAttempted = true;
  await pay.click({ timeout: 60000 });
  log('Pay now clicked');
  await page.waitForTimeout(6000);
  await shot(page, '05-after-pay-click');

  // 6. Wait for the approval and the merchant's answer, then reconcile. Never click Pay again.
  const deadline = Date.now() + 16 * 60 * 1000;
  let merchantSince = null;
  while (Date.now() < deadline) {
    const s = checkout.getState();
    if (['awaiting_merchant', 'ready_to_submit', 'outcome_unknown'].includes(s.status)) merchantSince ??= Date.now();
    if (/\/thank[_-]?you|\/post-purchase|\/orders\//.test(page.url())) break;
    if (merchantSince && Date.now() - merchantSince > 150000) break;
    if (['cancelled', 'declined', 'timed_out', 'failed', 'unsupported', 'completed'].includes(s.status)) break;
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);
  await shot(page, '06-merchant-result');
  let result = await checkout.reconcile();
  for (let i = 0; i < 10 && !['completed', 'failed', 'declined'].includes(result.status); i++) { await page.waitForTimeout(15000); result = await checkout.reconcile(); }
  // The merchant has not answered yet: the page is the only place the answer will appear, so the browser stays open and
  // this process keeps asking every fifteen seconds until the result settles, with no clock on it. While a new card request
  // is paused on the user (awaiting_approval), reconcile has nothing to read, so the loop waits instead. Never click Pay again.
  const isSettled = (r) => ['completed', 'failed', 'declined', 'timed_out', 'cancelled'].includes(r.status);
  while (!isSettled(result)) {
    const state = checkout.getState();
    if (['declined', 'timed_out', 'cancelled', 'failed'].includes(state.status)) { result = state; break; }
    if (state.status === 'awaiting_approval') log('a new card request is waiting on the user');
    else { result = await checkout.reconcile().catch(() => result); log('merchant answer pending; browser kept open'); }
    await page.waitForTimeout(15000);
  }
  log(`${result.status}  ${result.orderId ? 'order #' + result.orderId : ''} ${result.reason ?? ''} ${result.authorizationId ?? ''}`.trim());
  fs.writeFileSync('shots-local/result.json', JSON.stringify({ result, finalUrl: page.url() }, null, 2));
  settled = isSettled(result);
} finally {
  await browser.close().catch(() => {});
  log('browser closed');
}
