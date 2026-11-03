624 [SZ8](23): a ready cart link for posts and emails, with a discount code that applies itself.

- **Unit 1** (`lib/cart-checkout.ts`, `app/api/store/cart/route.ts`): the code a link brought to the store (`?code=`, remembered a week by lib/code-link.ts) now goes on a cart's checkout as it already did on one product's: looked up on the creator's own Stripe (`livePromotionId`), applied only when nothing else was taken off (a sale, the cart deal, a fair price), never stacked; when Stripe refuses it for this cart (a minimum, first order only, other products) the checkout opens with the box instead. What may come off for the platform share is unchanged: an applied code is one of the store's own codes, already counted by `codesMayTakeOff`.
- **Unit 2** (`components/cart-link-builder.tsx`, one line in `app/studio/page.tsx`): "A link to a ready cart" beside "Buy more, save more", shown only where a cart is offered: pick 2 to 4 products a cart takes (listed, paid, sold once, not coming soon: `cartLinkProducts`) and, if wanted, a code; the link (`?restore=…&code=…`, read by the store page and the checkout as they are) is made in the browser, nothing saved.

- **Unit 3** (`lib/short-link-rules.ts`, `components/short-links.tsx`, the builder): a short link for one post may go to a ready cart (two to four of the store's products, each once, and optionally a code of a link code's shape), through the same `/l/<code>` redirect, tagged with the post like any short link; the builder makes one with the post's name and place, and the Short links list says where it goes.

No price, limit, commission, flag or gate changed; no new Stripe object; no new kind of stored record (a short link keeps its target as before).

## Tests
`tests/cart-link-code.test.ts` (15, stand-in Stripe: applied, unknown, none, one discount at a time, refused then the box; the builder's link read back by the same readers; its markup) and `tests/short-link-cart.test.ts` (8, through the real `/l/<code>` redirect), plus every cart test and the short links test, code-link, e5 money readers, accessibility inventory and statement, US English; typecheck, lint, public data.

## Acessibilidade
- Criteria checked: 1.3.1 (a section named by its heading; products in a `fieldset` with a `legend`; the code field labeled, its help tied with `aria-describedby`, `aria-invalid` when its shape is wrong); 4.1.3 (the link area is `aria-live="polite"`, and says what is missing before the link exists); 2.5.5 (rows and button at least 44 px); 3.3.1/3.3.3 (the wrong code shape is said with what a code is); 3.1.5 (plain words; what happens to a code that is not live).
- Method: `renderToStaticMarkup` in the test and diff reading; no screen reader or browser run.
- Not covered: contrast and forced-colors not measured (existing classes only); no test with people (item 202).
- Steps/decisions for the main task (share a cart): before, not possible; after, pick products (2–4), optionally type a code, copy.

## VR
State: tested in a PR. The builder appears only in a store that offers a cart, and the link it makes is read by the pages that exist today.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxxg2hUJABFFutG88Tb
