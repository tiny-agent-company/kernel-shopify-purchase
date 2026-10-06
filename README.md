# kernel-shopify-purchase

One real purchase on a Shopify store, paid with the user's card in the [Agentcard Vault](https://docs.agentcard.sh/vault/quickstart), two ways:

- `buy.mjs`: from a [Kernel](https://kernel.sh) browser. The guide [Complete a purchase on a Shopify store with Kernel](https://docs.agentcard.sh/guides/complete-a-purchase-on-a-shopify-store-with-kernel) was captured from it.
- `buy-local.mjs`: from a browser you run yourself, the Chrome on your machine driven by Playwright (`npm run buy:local`; `HEADED=1` shows the window). The guide [Complete a purchase on a Shopify store with your own browser](https://docs.agentcard.sh/guides/complete-a-purchase-on-a-shopify-store-with-your-own-browser) was captured from it.

```bash
npm install
cp .env.example .env   # fill it in
set -a; source .env; set +a
npm run buy
```

The script prints the approval link and runs `APPROVAL_LINK_COMMAND` with it in `$APPROVAL_URL` when that is set, which is how it reaches the user; they approve with Face ID on their phone, the real card pays, and the script prints the merchant's confirmation number. Screenshots of every step land in `shots/`.

It needs production Agentcard credentials: the sandbox pauses the card request but sends no approval link and charges nothing.
