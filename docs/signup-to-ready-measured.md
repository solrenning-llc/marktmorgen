# From sign-up to a store ready to sell, measured (251 [ST4], unit 1, 11 November 2026)

**What this is.** A record of what a new creator must do today. Each step was measured by walking the real code, not estimated. `tests/signup-to-ready-walk.test.ts` walks the routes in order:
- on the in-memory database;
- with the email provider (Amazon SES) and Stripe simulated;
- with nothing real called, and no account, payment or message.

The test fails when this record stops matching what the walk measures.

**How a step and a required field are counted.**
- One step is one thing the person does on this site that sends a request.
- A field counts as required only when the walk proves it. Either the same request without the field is refused, or the form the person uses marks it required, so the browser will not send it empty.

Fields the person may leave empty are not counted.

## The steps

| Step | What the person does | Required fields |
| --- | --- | --- |
| 1 | Ask for a sign-in link | `email` |
| 2 | Open the link and confirm | none |
| 3 | Claim the store | `handle` |
| 4 | Add the first product | `title`, `price` |
| 5 | Give it something to deliver | `link` |
| 6 | Start Stripe's onboarding | `country` |
| 7 | Choose a plan (closed today) | none |

In total: **7 actions** and **6 required fields** on this site.

What the walk found:
- **No account form and no password.** The emailed link (or its 6-digit code) creates the account and signs in. The link works once.
- **The store's name is optional (unit 2).** The server always took the store's address as its name when none was given (`freshStore`). The studio's form still required it, which made one more field to fill before anything else. Since unit 2 the form says the name is optional and what an empty one becomes, and it can be changed any time. The address is still required.
- **A product added by hand is published at once.** There is no separate publish step. A separate publish step exists only for the hidden drafts the AI store setup makes (`firstOfferPublishedAt`, docs/ht5-store-activation.md).
- **It sells only once it has something to deliver, and that is a second action (unit 3).** `canSellProduct` needs a file or a link (`handsOver`). The add step does not take one: the product's own row gives a link (`action: "link"`) or a file afterwards. Step 5 measures the link; a file is the same one action through its upload door.
- **Stripe's own pages come after step 6.** They hold identity checks and payout details, and their number of steps belongs to Stripe. This site cannot shorten them and does not count them.
- **The checkout cannot be turned on today.** `PLANS_ON_SALE` is false (lib/opening.ts), so step 7 answers `billing=not-open` before it reads any field. The store cannot sell (`canSell` is false: it needs a paid plan, and the tax, Article 9a and commercial gates stay closed). Its fields are not counted, because they cannot be measured while it is closed.

## What was not measured

- **A person's time.** It is not measured here: a synthetic walk shows the steps and fields, not how long a person takes to read and type. That needs real people (item 202). Until then, no public page may state a time or claim ease of setup (VR, item 251's own rule).
- **Stripe's onboarding** (outside this site; see above).
- **The optional help along the way:**
  - the AI store setup;
  - the studio checklist (details, photo and color, a recovery address or passkey, sharing the address);
  - the bio, summary and delivery file of a product.

  None is required to reach a published product.

## Steps that could be shortened later (no change in this unit)

Each one is for a later unit, which must keep every protection:
- the email ownership proof (one-time link or code, 15 minutes);
- the bot check, rate limits and same-site check on the sign-in request;
- the terms and privacy links;
- the publish checks (`fast_money`, `outline_left`);
- Stripe's identity checks;
- every sales gate.

The candidates:
1. **Fold the store address into sign-in.** When the address was typed on the home page, the link already carries it (`handle-prefill`, VS1). After the link opens, the studio still shows the address form, filled in, to confirm. Claiming from the confirm step would save one step. It needs the same address checks and a clear way to change it.
2. **Take the delivery in the add step.** Today a product needs a second action, step 5, before it can sell: the add step takes no link or file. Taking it in the same step, optional and said plainly to be needed to sell, would save that action. Nothing would change in how a link is checked.

Coordination: the Marktmorgen Path (`lib/path-rules.ts`) and 219 [OP5] use the same first steps. Any change to the order above is checked against them in its own unit.

## Acessibilidade

A record and a test only: no page, component or email changes. Steps and decisions of the main task (sign-up to a first product ready to sell): 7 actions and 6 required fields, measured (unit 2 made the store's name optional; unit 3 measured the delivery step the first record left out).
