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
| Stripe Atlas partner address offer | not on stripe.com/atlas (13 Nov 2026: no address partner named; "You also don't need a US address or Social Security number to incorporate") | unknown | unknown | unknown | unknown | unknown | unknown | fails (unknown) |
| Stable (usestable.com), Grow | $59/month billed monthly; $49/month billed yearly ($588/year). 50% off Grow "for businesses with under $1 million in annual revenue or those using a Stable address to incorporate" (duration of the discount not stated) | "Stable addresses are not PO boxes … all Stable addresses are real street addresses" (e.g. "5227 North 7th St ####, Phoenix, AZ 85014"). Whether it is a CMRA: **not stated** | **not stated** | scan, ship, shred included; auto-scan included; forwarding "anywhere in the world" at shipping cost; 30 pieces/month (monthly) or 360/year (yearly), then $3 a piece | **none on the page**; it recommends Stripe Atlas ("Stable customers get $200 off") and says the address can be used "when forming an LLC … in states like Delaware" | **none on the page** | at least $588/year (yearly) or $708/year (monthly), before any discount; registered agent +$25/month a state if bought there; Form 1583 and its cost unknown | fails (Stripe and bank acceptance unknown; CMRA/1583 unknown) |
| iPostal1 | unknown | unknown | unknown | unknown | unknown | unknown | unknown | fails (unknown) |
| Anytime Mailbox | unknown | unknown | unknown | unknown | unknown | unknown | unknown | fails (unknown) |
| Earth Class Mail | unknown | unknown | unknown | unknown | unknown | unknown | unknown | fails (unknown) |
| Opus Virtual Offices | banner on www.opusvirtualoffices.com, 13 Nov 2026: "only $99/mo. for a COMPLETE virtual office solution including a professional business address" (banner, not a plan page; fees and taxes unknown) | unknown | unknown | unknown | unknown | unknown | unknown | fails (unknown) |
| Regus virtual office | unknown | unknown | unknown | unknown | unknown | unknown | unknown | fails (unknown) |

## Sources read (13 Nov 2026)

- https://www.usestable.com/pricing (plain request, 200): plan prices from the page's own data (`"monthly":"$59"`, `"yearly":"$49"` for Grow; `$99`/`$83` for Scale) and its FAQ ("What is the actual address? Is it a PO box?", "Can I use a Stable address for LLC incorporation in states like Delaware or Wyoming?").
- https://stripe.com/atlas (200).

## Blocked sources

On 13 Nov 2026 the hosts were opened for this session, but: Stripe's support articles (support.stripe.com/questions/verifying-your-business-address, which-address-should-i-use-for-atlas-incorporation, connect-address-validation) are rendered by scripts from `b.stripecdn.com` and `js.stripe.com`, which the proxy refuses, so their text is empty even in a headless browser; `www.ipostal1.com` answers 403 to a plain request; a browser-like fetch of supplier pages was not permitted in this session. **Stripe's exact P.O. box / virtual-address policy is therefore still not read from an official page**; the requirement above is as the owner reported Stripe's e-mail (SR5). Finishing this study needs a session that can read them. The way in is the owner adding exactly these hosts to the environment's network allowlist (see "Next step"). Nothing here was guessed in their place.

## Next step

1. Read each supplier's pricing page and terms (dated), the USPS Form 1583 page, and Stripe's support page on business addresses (`support.stripe.com`), with these hosts reachable.
2. Fill the table. Mark an option as meeting the requirement only with a dated source for every column.
3. Then the one-page recommendation for the owner: the cheapest option that meets every requirement, and the safest one if Stripe's acceptance stays uncertain.

No price, limit, commission, gate or flag is changed by this document.
