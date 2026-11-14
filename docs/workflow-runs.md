# Workflows: branches, goals, limits and run history

Added 17 October 2026 on top of the existing sequence engine (`lib/flows.ts`); there is no second engine. Covers ClickFunnels audit capabilities F21 (behavior triggers), F22 (actions and handoffs), F23 (branching and goals) and F24 (execution history).

## What a creator can build

- **Triggers** (and, since the pipelines change, **a deal entering a stage** of one of the store's pipelines when the team makes or moves it there: docs/crm-pipelines.md): joins the list, gets a product, first purchase, label given by another workflow, sends a form, finishes a course, and two new ones: **opens a course for the first time** (`lib/course-finish.ts`, `noteIfOpened`) and **abandoned checkout** (`lib/checkout-sweep.ts`, `startAbandonedWorkflows`). An abandoned-checkout run starts only when the buyer checked Stripe's promotional-consent box on that checkout (`consent.promotions === "opt_in"`, the same evidence `lib/checkout-recovery.ts` already requires) and is on the creator's list and mailable (`enroll`). It starts once per checkout, never for the demo store, and the workflow must have a purchase goal.
- **Steps:** email (through the existing `sendTo`, so every email is reserved from the monthly allowance before it is sent), wait only, give/take off a label, start another workflow, set a field, move a deal to a stage, **make a teammate responsible for the person's open deal** (owner or a teammate with the "orders" permission, checked on save and again at run time), write a note, email the owner, tell the store's webhooks (the existing signed `sequence.step` event, its endpoints and retry ceiling).
- **Branches:** a step's condition can skip, end, or **jump to a later step**; any step can go **next** to a later step or end. Routes only go forward (`lib/flow-paths.ts`, `checkRoutes`), so a run never loops and visits each step at most once.
- **Goals:** bought anything, got one product, or **carries a label**. Checked before every step.
- **Preview:** `previewRun` shows the exact path for a sample contact (typed in, or read from one person on the list). It is the same routing code the scheduled job uses, it simulates the workflow's own label steps, and it sends or saves nothing.
- **Explicit activation:** a new workflow is saved paused whatever the request says; switching on is `flow-activate` from the workflow's card, shown after the preview. "Keep sending it" from a sent email is an explicit switch on and passes `activate`.

## Run history and uncertain outcomes

`lib/flow-runs.ts` keeps one record per (workflow, person) for up to 400 days, or until it is erased (below): status, current step and an event list capped by `MAX_RUN_EVENTS`. Before an email is handed to the sender or an action runs, the attempt is claimed with `HSETNX` on the run (`attempted`). The outcome then clears it: `confirmed`, `failed`, or `deferred` (allowance, daily sending room, pause: nothing was sent and the step is queued again). When the provider may have taken an email but the answer was lost (`sendTo` now returns those addresses as `uncertain`), or an action's write cannot be confirmed, the attempt stays open and the run is **held**. A run that finds its own attempt still open, because a job stopped between the attempt and the outcome, is held too. Nothing held is retried by itself. The studio lists held runs, and the creator chooses once (`resolveHeldRun`, only one `HDEL` wins): it went through, continue; try again, which may deliver twice; or end the run.

The next step is queued before the attempt is cleared. If clearing fails, the next step finds the attempt open and holds the run instead of repeating anything.

### Counted four ways, and bounded (18 October 2026)

A run's history in the studio counts its effects four ways, kept apart (`lib/run-effects.ts`, computed in the browser from the events the history already returned, so it costs nothing to show): **attempted**, **confirmed**, **failed** and **uncertain**. An attempt with no outcome written yet is uncertain, never done, and so is an uncertain step the creator marked as gone through: the choice is shown beside it, and it stays counted as uncertain because nobody but the creator said it happened.

What a run keeps is bounded by construction, not by trimming what the job writes (`lib/flow-runs.ts`):

- **Events a run keeps: at most `MAX_RUN_EVENTS` (62).** A run visits each step at most once and each visit writes at most an attempt and its outcome, or a skip, so without the creator it writes at most 2 + 2 × 20 = 42. A step that has to wait (the month's emails ran out, no room to send, the deals board could not be read) takes its attempt back out of the history (`LREM` of that exact event), so a month of waiting writes nothing; until 18 October 2026 every try wrote a new "attempted", which grew the history past what the data room was charged for (`runBytes`). Each choice the creator makes for a held run keeps only the latest `KEPT_AFTER_CHOICE` (20) events, which leaves room for everything the run can still write; the history then says its earliest events are no longer kept.
- **Runs a workflow keeps: at most `MAX_RUNS_KEPT_PER_FLOW` (11,600 since 18 October 2026, when the runs a day went down; 16,000 before).** A person starts a workflow at most once while the start is remembered (400 days), and a store starts at most its plan's runs a day across all workflows (29 on Scale). The index is never trimmed, so every run in it can still be erased.
- **Days: 400** after the run ends (`RUN_KEEP_SECONDS`), or until it is erased (below).

Cost: no new command on the job's path. A wait's `LREM` takes the place of the event it used to write; the creator's choice adds one `LTRIM`, once per choice. `tests/workflow-run-history.test.ts` checks the counting rules, a step tried again twelve times while waiting, and thirty "try it again" choices on one run.

## Waits, retries and stop rules (18 October 2026, audit row F23)

A step that cannot go yet **waits** and is tried again by itself (`lib/flow-retry.ts`). Until 18 October 2026 a wait was tried again every 10 minutes or 6 hours for as long as its cause lasted, with nothing counting it: unbounded database work that was not in `WORST_COMMANDS_PER_RUN`. Now:

- A wait whose end is known is tried **once, at that end**: the month's emails a minute after the store's allowance window turns, the company's daily room just after the next UTC day, a pause on the store's email a minute after it ends.
- Anything else (the sending service's ceiling, a new list's portion, a read that did not answer, the deals board, email not configured) is tried again after a delay that grows threefold: 10 minutes, 30, 90, 4.5 hours, 13.5 hours, then a day.
- Every wait is counted on the run (`waits`, and `waitAt` for when the current step began waiting). A run waits **`MAX_WAITS_PER_RUN` (3) times** at the most, all steps together, and one step **`MAX_WAIT_DAYS_PER_STEP` (35) days**. One wait past that, or a count that cannot be read, and the run **stops** at that step with nothing done, written as failed with the reason, and it leaves the queue.
- The creator's **"Try it again"** on a held run is taken **`MAX_RETRIES_BY_YOU` (1) time** per run (`retries` on the run). After that the studio offers only "It went through: continue" and "End this run", and says why.

**Stop rules, explicit.** `lib/flow-stop-rules.ts` lists every way a run of a workflow stops. From the workflow itself: its goal, each condition that ends the run, each step that goes to the end, and its last step. From the engine: leaving the list; a pause, a removed step or email leaving the plan; a refused email; the wait bounds; and the hold with its one retry. The studio shows the list under the preview, before the workflow is switched on. Each rule is one the job enforces, and the job makes no stop that is not on the list.

**The preview** is the same routing code as the job (`previewRun`), run in the browser on the sample. It sends nothing, saves nothing and runs no database command (`tests/workflow-retries.test.ts` counts them: zero).

**Cost.** One wait costs at most `WAIT_COMMANDS_PER_TRY` (32) commands for a batch of one person: measured 21 for a wait on the day's room and 30 for the month's emails. `WORST_COMMANDS_PER_RUN` now counts every step, the one creator retry (one more step) and every wait: 8 + 21 × 15 + 3 × 32 = 419, from 308. To keep each plan's worst month at or under what it was, without touching a price, the new runs a day went down from 25, 40 and 10 to 18 (Studio), 29 (Scale) and 7 (trial). `tests/spend-floor.test.ts` keeps its $0.25 and $1 of room on every plan.

**Steps that change places (14 November 2026).** People wait in the queue by a step's position. A save that changes positions (a step added in between, removed or moved; `positionsChanged` in `lib/flows.ts`) marks the workflow with `layoutAt`; words, delays, conditions or a step added at the end do not. Anyone queued before that mark is not sent anything: the run is held with a note saying why, and the held runs screen offers "Send step N now", "Skip step N" or "End this run" (`resolveHeldRun`). Before this, the step at the old position was sent: a step was skipped or an email arrived twice. For such a workflow the sender reads each run's last move with the row and the lease entry: one more command a person a step, so `QUEUE_COMMANDS_PER_STEP` goes from 7 to 8 and `WAIT_COMMANDS_PER_TRY` from 32 to 33 (`lib/flow-limits.ts`), and `docs/margin-alignment-2026-10-18.md` was regenerated with them.

**Not bounded by a count:** a step put back because the attempt itself could not be written, or because the job failed before it, is tried again in 10 minutes. Both need the store to fail, and a count kept in that same store cannot be read then either.

## Erasure

The run index (`nl:wf:runs:<flowId>`) lists every run of the last 400 days; it is not trimmed, so every record can be found and deleted. Three paths erase:

- **One person** (`forgetWorkflowPerson`, studio action `flow-forget`, the "Erase … from every workflow" button in a run's history): for each of the store's workflows (at most 20), it deletes the run record (which holds the address), its history, its index and held entries, the start record, and any of their steps still waiting in the queue or its lease, under every address the store has had and at every step position. The deletion counts only when every reply comes back; otherwise the studio says it could not be confirmed. The person's row on the creator's list is not part of this; there is no in-code contact deletion yet (see below).
- **A workflow removed** (`removeFlow`): every run of that workflow, with the same keys per person, plus its index and counters.
- **A store deleted** (`app/api/store/stores`, `forgetStoreWorkflows`): every workflow's runs as above, the store's held list and the workflows themselves.

The abandoned-checkout claim (`nl:wf:abandoned:<checkout session id>`, 2 days) holds the Stripe session id, never an address. `tests/workflow-branching.test.ts` erases a person mid-run and checks that no key or value outside their list row (`nl:store:leads:*` and their unsubscribe token) mentions their address or its key, and that their waiting step never goes out. It also checks the workflow-removal and store-deletion paths.

## Limits (enforced in code, shown in the studio)

| | Store | Studio | Scale | Trial |
|---|---|---|---|---|
| Workflows kept | email not on plan | 20 | 20 | 20 |
| Steps per workflow | | 20 | 20 | 20 |
| Switched on at once | 0 | 10 | 20 | 3 |
| New runs per UTC day, all workflows | 0 | 18 | 29 | 7 |
| Waits per run, all steps | | 3 | 3 | 3 |
| Days one step may wait | | 35 | 35 | 35 |
| "Try it again" on a held run | | 1 | 1 | 1 |

Runs past the daily ceiling are refused before any record is written, their start claim is given back, and the refusals are counted and shown. A store that moves to a smaller plan keeps its workflows; only the oldest switched-on ones up to the new limit start new runs. The limits are in `CURRENT_COMMERCIAL_TERMS.workflows`, so changing any of them invalidates an earlier margin review.

## Cost reasoning

Emails draw on the existing monthly allowance and its supplier reservation; nothing here adds an email that bypasses it. Owner notices use the platform sender once per group of people. Webhook events reuse the store's endpoints (at most 5) and the existing seven-try retry ceiling. The non-email cost is Redis commands. `WORST_COMMANDS_PER_RUN` (8 to start, plus 20 steps × (9 history + 6 queue/contact) = 308) is a review ceiling, not a measured average. At Upstash's published $0.20 per 100,000 commands (baseline doc C06), the daily run ceilings first set (300 and 600) gave about $5.73 a month for Studio and $11.46 for Scale, which neither plan's worst month could carry paid by the year. Since 17 October 2026 they were 25 and 40 (10 in the free trial): $0.48 and $0.76 a month (25 or 40 × 31 × 308 commands). Since 18 October 2026 waits and retries are counted (419 commands a run) and the ceilings are 18 and 29 (7 in the trial): $0.47 and $0.75 a month, the `workflows` line of `tests/plan-cost-registry.ts`. The owner's notice step now takes one of the store's monthly emails before it is sent (`lib/mail.ts`, `takeFromMonth`); with none left the step is marked failed with that reason, and the run goes on. Erasure adds a bounded number of commands per request (per workflow: 5 deletions plus 2 queue removals). The figures are inputs for the margin review. They are not proof that any plan meets the 60% after-tax floor.

## Verification

`tests/workflow-run-history.test.ts` covers the four counts and the bounds above. `tests/workflow-retries.test.ts` covers when a wait is tried again, the wait and retry bounds, what one wait costs, the stop rules and a preview with no database command. `tests/workflow-branching.test.ts` (62 checks) covers erasure (above), routes, preview determinism, plan limits, save validation, explicit activation, IF/ELSE delivery, label goals, step history, the daily ceiling, a lost provider answer that is held rather than resent, an attempt left open by a stopped job, and the creator's one-time resolution. Existing sequence tests were updated only where new workflows now need an explicit switch on. Everything runs against the in-memory Redis double and a stand-in email provider. No real messages, Stripe accounts or customer records are used.

## Not included

- A date/time trigger (start everyone matching on a set date). It needs paging over the list under the daily ceiling, so it is left for follow-up work.
- Granting or revoking course or community access from a workflow. Access is derived from Stripe purchases and refunds (`lib/community-access.ts`, `lib/learn.ts`), and audit item F38 asks for subscription/refund reconciliation before access automations.
- A drag-and-drop canvas. The editor stays a list of steps with branch targets and a step map. The preview shows the path.
- Page-visit triggers and split-test steps beyond the existing A/B halves.
- Deleting a contact's row from the creator's list. No such path exists in code today: an unsubscribe keeps the row, marked, and a deletion request goes to support. Workflow data is erased in code by `flow-forget`; the list row, its unsubscribe token and other modules' records (link-use records, CRM values, notes) still need a single erasure path that calls `forgetWorkflowPerson`.
