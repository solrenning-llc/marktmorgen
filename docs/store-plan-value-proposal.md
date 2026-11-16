# More value on the Store plan at no cost: PROPOSAL (250 [ST3], 11 November 2026)

**PROPOSAL.** Nothing in this document changes a feature, a price, a limit, a flag or a gate. Changing any of it needs the owner's decision. `PLANS_ON_SALE` stays false.

The question (queue item 250 [ST3]) is this. Take each feature that today exists only on Studio and Scale. Does it have a variable cost for Marktmorgen? If not, should Store get it too? The owner's rule of 18 October 2026 is to give "o ultra máximo de coisas que os clientes percebem como alto valor e que não têm custo para ele", without losing profit.

How it was read:
- the code on `main` on 11 November 2026: `lib/plan.ts` `hasPro`/`canUse`, and every per-plan table named below;
- the cost model `lib/receiving-costs.ts` and the cost registry `tests/plan-cost-registry.ts`.

`tests/store-plan-value-proposal.test.ts` fails when a figure here stops matching the code.

## What only Studio and Scale have today

Store is the `creator` tier. `hasPro()` is true only for `pro` (Studio) and `scale` (Scale).

| Feature | Where it is decided | Studio | Scale | Variable cost for Marktmorgen |
| --- | --- | --- | --- | --- |
| Emails to the list a month (broadcasts, sequences, review requests, community announcements) | `lib/plan.ts` `canUse(…, "email")`, `monthlyEmails` | 7,000 | 10,000 | **Yes.** Each email is a paid send. |
| AI writing jobs a month | `lib/ai-rules.ts` `AI_MONTHLY` | 40 | 80 | **Yes.** Each job is a model call, funded from the AI budget (`lib/ai-spend-policy.ts`). |
| Short AI answers to visitors a month | `lib/answers-rules.ts` `ANSWERS_MONTHLY` | 250 | 400 | **Yes.** Each answer is a model call. |
| Active workflows at once | `lib/flow-limits.ts` `ACTIVE_FLOWS_BY_TIER` | 10 | 20 | **Yes.** Each run is database commands (`WORST_COMMANDS_PER_RUN`). |
| New workflow runs a day | `lib/flow-limits.ts` `DAILY_RUNS_BY_TIER` | 18 | 29 | **Yes.** Same reason. |
| Team event types (scheduling with several hosts) | `lib/team-scheduling-rules.ts` `TEAM_LIMITS` | 5 | 10 | **Yes.** It reads each host's calendar. The code's own note says this was taken off Store on 18 October 2026 to make room for Store's worst month. |
| The store's own domain | `lib/plan.ts` `canUse(…, "domain")`, `lib/domains.ts` | Yes | Yes | **Unknown, so not zero (rule 24).** A domain is added through the hosting provider's API (`lib/domains.ts`). No dated official price per domain for the account in use was read, and no ceiling for it exists in `tests/plan-cost-registry.ts`. |
| No "Made with Marktmorgen" line at the foot of the store (`look.badge` off) | `lib/plan.ts` `canUse(…, "branding")`, `app/api/store/look/route.ts` | Yes | Yes | **None found.** Hiding a line of text runs no service. `lib/plan.ts` says the same: it "costs us nothing to run". |

Per-plan limits that every plan has (visits, orders, storage, video hours, data room, studio requests, store emails and the rest) are not features that only Studio and Scale have. Raising them on Store is a change to Store's limits, and every one of them has a cost per use. They are left out, as the item asks.

## The one feature with no cost to run: removing the line at the foot

**What Store would gain.** A creator could sell from a page with no Marktmorgen name at the foot. No claim is made here about how competitors price it: none was read with a dated official source for this proposal (VR, item 7).

**What it would cost.** Nothing to run. What it gives up is not a cost but income:
- **Acquisition.** The line at the foot is how a store brings Marktmorgen its next creator. That is why the code keeps it on Store (`lib/plan.ts`: "a store that would rather not carry it is buying back the thing it would otherwise have paid us in"). No figure says how many creators arrive through it today: nothing is on sale yet, so there is no data.
- **A reason to move up.** Branding is one of the three things the plan card says Studio adds (email, domain, branding; `components/home-parts.tsx`). Without it, Studio would add only email and the domain, plus AI, workflows and team scheduling.

**What could not be measured.** It is not possible to measure here whether giving branding to Store would bring more sales and fewer cancellations than the creators and upgrades it would cost. There are no customers yet, so no sales figure exists. Guessing one would break VR and "unknown is never zero".

## Recommendation (the owner decides)

1. **Keep every feature that has a cost (emails, AI, answers, workflows, team scheduling) where it is.** Each has a cost per use, Store's price covers Store's own worst month, and moving them would change Store's margin. Any such change goes through the margin rule (MR) first.
2. **Keep the domain where it is until its cost is known.** It could be considered for Store later, once a dated official price per domain and a ceiling in `tests/plan-cost-registry.ts` exist.
3. **Branding: no change now.** It is the only Studio-only feature with no cost to run. It is also the one that pays for itself through acquisition and upgrades, which cannot be measured before sales open. Once the monthly report shows real figures (MR item 3), the owner can compare two numbers: creators who arrive through the line at the foot, and Store creators who move up to Studio. A smaller, reversible step, if the owner prefers to act sooner: a lighter line at the foot on Store (smaller, or only on the checkout's thank-you page), never removed entirely. That is also a decision for the owner, and nothing is built for it.

No feature, price, limit, commission, flag or gate changes because of this document.

## Acessibilidade

A document only: no page, component or email changes. Steps and decisions of the main task: 0 → 0.
