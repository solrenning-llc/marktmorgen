# 439 [FC2]: the cheapest acceptable US business address (13 November 2026)

**State: incomplete. No option is recommended yet.** The suppliers' own pages could not be read from the environment this study ran in (see "Blocked sources"). A price or an acceptance this study could not read is unknown, and unknown fails; it is never taken as zero or as "accepted".

Documents only. No account was created, no form was filled, no supplier or Stripe was contacted, nothing was bought.

## The requirement (binding, AGENTS.md SR5, applied from the owner's report of Stripe's answer of 27 Oct 2026)

- A **real US business street address**, never a P.O. box.
- The registered agent's address should not be the operating address (not recommended).
- A virtual office is not guaranteed to be accepted; if automatic verification fails, the account goes to manual review.
- Stripe Atlas partners offer a discounted US address. No quote or acceptance may be presumed.
- The US bank account must be in the LLC's exact name.

## What was read from official pages (13 Nov 2026, UTC)

| Source | Read on | What it says |
| --- | --- | --- |
| https://stripe.com/atlas | 13 Nov 2026 | "Atlas costs $500, including Delaware filing fees and your first year of registered agent service." "After the first year, registered agent service costs $100 per year." |
| https://docs.stripe.com/connect/required-verification-information | 13 Nov 2026 | Downloaded, but the address rules are not in the server-rendered text. **Not verified here.** |

## Candidates (all unknown until read)

| Option | Monthly / yearly price | Physical street address (not P.O. box; CMRA?) | USPS Form 1583 | Scan / forward | Stripe acceptance evidence | US bank acceptance (non-resident LLC) | Full mandatory cost | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Stripe Atlas partner address offer | unknown | unknown | unknown | unknown | unknown | unknown | unknown | fails (unknown) |
| Stable (usestable.com) | unknown | unknown | unknown | unknown | unknown | unknown | unknown | fails (unknown) |
| iPostal1 | unknown | unknown | unknown | unknown | unknown | unknown | unknown | fails (unknown) |
| Anytime Mailbox | unknown | unknown | unknown | unknown | unknown | unknown | unknown | fails (unknown) |
| Earth Class Mail | unknown | unknown | unknown | unknown | unknown | unknown | unknown | fails (unknown) |
| Opus Virtual Offices | unknown | unknown | unknown | unknown | unknown | unknown | unknown | fails (unknown) |
| Regus virtual office | unknown | unknown | unknown | unknown | unknown | unknown | unknown | fails (unknown) |

## Blocked sources

Requests from this environment to these hosts failed (HTTP proxy 403 or no connection) on 13 Nov 2026: `support.stripe.com`, `usestable.com`, `www.ipostal1.com`, `www.anytimemailbox.com`, `www.earthclassmail.com`, `www.opusvirtualoffices.com`, `www.regus.com`, `faq.usps.com`. Finishing this study needs a session that can read them. The way in is the owner adding exactly these hosts to the environment's network allowlist (see "Next step"). Nothing here was guessed in their place.

## Next step

1. Read each supplier's pricing page and terms (dated), the USPS Form 1583 page, and Stripe's support page on business addresses (`support.stripe.com`), with these hosts reachable.
2. Fill the table. Mark an option as meeting the requirement only with a dated source for every column.
3. Then the one-page recommendation for the owner: the cheapest option that meets every requirement, and the safest one if Stripe's acceptance stays uncertain.

No price, limit, commission, gate or flag is changed by this document.
