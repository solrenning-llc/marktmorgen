# Marktmorgen anti-conflict strategy — final version (v20)

Authors: reviewers 1 to 20, one after the other, working for Claude 5. Reviewer 20 (final editor) rewrote the body in
the order below; nothing valid from version 19 was dropped. Version 19 is kept word for word in **Annex A** (in
Portuguese) as the evidence and history behind every number here. **Where the body and Annex A differ, the body
wins**: the body carries the corrections of all 20 reviewers.

**Status: proposal.** Nothing here has been applied to the repository, to GitHub or to any agent. Every change to
AGENTS.md, CLAUDE.md, tests or workflows waits for the owner where section 7 says so.

**Measurement point (reviewer 20).** 19/11/2026, 11:45 UTC. `origin/main` = `c1f6b529e` (merge of #4865 at 11:21 UTC,
read with `git ls-remote`; it changed no generated document). 295 open PRs from the REST list (4 pages), none from a
fork, 66 stacked on 61 base branches. All 295 heads and 61 bases were fetched into a throw-away mirror
(`scratchpad/r20/mirror.git`, removed at the end) and compared one by one with the list: 0 differences. Classification
with the same `r9/tool/classify.py` used by reviewers 9 to 19 (`scratchpad/r20/state.tsv`).

**Fixed limits (unchanged since reviewer 1).** No change to prices, visible limits, commission, `PLANS_ON_SALE`,
`OPENING_REQUESTED`, the tax gate, Article 9a, the commercial review or any gate; no margin, ceiling or cost test is
loosened; no account, credential, contract, payment or outside contact is created by an agent; nothing of Hazelsong
or of any creator is deleted. Every margin figure shown to the owner follows rule LC; the generated documents are the
historical and sizing model and are never presented as the owner's profit.

**Safety rules for every step below** (reviewer 5, kept):
- A check is replaced only by an equal or stronger one, in the same PR, running on the same events (`pull_request`,
  `merge_group`, `push`). The PR lists each removed assertion next to its replacement; with no equivalent, it stays.
- AGENTS.md and CLAUDE.md text changes only with the owner's authorization, with the exact new sentence quoted in the
  question, in the same PR that changes the behavior. `tests/agents-ac-section.test.ts` pins section AC: new text keeps
  the phrases it checks, or the test changes in the same authorized PR.
- Every PR of this strategy has an "Acessibilidade" section (AX274; "no interface changed; 0→0 steps and decisions"),
  uses the VR states, and says "green" only with the 9 `All checks (...)` checks on the exact head (CV (a)).
- Every push follows MV (a)/(c), AC (b), (m), (p) and the agent's minute and semaphore; every queue request follows the
  tap in force, as `fila #N @sha` (CV (c)). No script of this strategy pushes, queues, comments or closes anything by
  itself (AC (o)).

---

## Resumo para o dono (10 linhas)

1. Hoje (19/11, 11h45 UTC) há 295 PRs abertos; 82 estão em conflito de verdade com a própria base (126 contra o main).
2. 45 desses 82 têm conflito nos documentos de preço e margem gerados pelo código; 25 só neles.
3. A causa é uma esteira: cada incorporação que muda um custo põe de novo em conflito todos os PRs de custo (o #3545 sozinho pôs 7).
4. A cura principal é a proposta do Claude 6, completada: esses documentos saem dos PRs e do main e são publicados sozinhos num ramo à parte.
5. Os testes continuam calculando todas as margens, tetos e travas em todo PR; nenhum preço, limite, comissão ou trava muda.
6. Os outros conflitos que se repetem são de três ou quatro registros compartilhados; a cura é entrada nova em arquivo próprio e uma entrada por linha.
7. Uma verificação no CI impede a volta dessas causas, e um painel automático mede todo dia os conflitos parados há mais de 2 horas (meta: zero).
8. A limpeza dos 82 segue uma receita única e segura; os do Codex, que só lê, ganham um agente adotante.
9. Cerca de 33 conflitos são de código de verdade; esses nenhuma regra elimina, só PR pequeno e entrada rápida reduzem.
10. Preciso de quatro respostas suas (seção 7); o resto começa sem pergunta nova.

---

## 1. Diagnosis, with numbers

### 1.1 The stock today (reviewer 20, `c1f6b529e`, 11:45 UTC)

| Measure | Value |
| --- | --- |
| Open PRs | 295 (229 with base `main`, 66 stacked on 61 bases), 0 from forks |
| In conflict with their **own base** (what GitHub shows and what blocks CI) | **82**: 77 out of draft, 5 drafts; 72 with base `main`, 10 stacked |
| In conflict with `main` | 126 (the 44 extra are stacked PRs clean against their base; see 1.3, C6) |
| With a generated price/margin document in conflict (class G) | **45**; **25 only that** |
| Only mechanical classes (G, the 18/11 migrations V/S/A, inventory I) | 30 |
| With real product code in conflict (class P) | 33 |
| Touching a money path | 60 |
| By agent, out of draft | Claude 4 16, Claude 7 12, Claude 3 9, Claude 5 9, Codex 8 (+2 `codex-x1/`), Claude 2 8, Claude 1 6 (+2 `claude/`), Claude 6 5 |
| Files in conflict, most frequent | the 6 price/margin documents 36–43 PRs each; `docs/value-presentation-2026-10-18.md` 13; `lib/data-families.ts` 12; `tests/plan-cost-registry.ts` 10; `tests/switch-keeps-window.test.ts` 9; `lib/redis-memory.ts` 8; then 3 or fewer each |

Changes since reviewer 19 (`cabd3687c`, 11:23): one merge (#4865, no generated document). Three PRs left conflict
because their authors merged main (#2848, #3378, #3608). One entered: **#3659** (Codex, stacked on #3608). It did not
enter through `main`: the author of the base #3608 merged `main` into the base at 10:46, and the conflict moved one level
up the stack, into a PR whose author is read-only. This is a new mechanism (R20-1, section 9).

Trend of the same measure through the day: 82 (09:30), 77 (10:40), 77 (11:00), 84 (11:23), 82 (11:45). The stock does
not shrink by itself: as fast as owners clean, cost merges re-create it.

### 1.2 Causes, ranked by how many PRs each explains

| # | Cause | Evidence (measured) | Can a rule remove it? |
| --- | --- | --- | --- |
| C1 | **Generated price/margin documents (treadmill).** Every merge that changes a cost rewrites the same lines (the Store row, the totals) of 6–7 generated files that every cost PR also rewrites | 45 of 82 today. In 24 h (18–19/11) 58 PRs went from clean to conflict, 32 of them in G; one merge (#3156) caused 19, another (#3545, 11:08 today) caused 7, all only in G (verified before/after each merge). 11 cost merges on 18/11. 72% of the main merges done inside PRs in 24 h (254 of 353) existed only to regenerate these files, about 40% of all CI time | Yes, structurally: take the files out of PRs and main (S1) |
| C2 | **Shared registries.** New entries all go to the same spot (end of a block, one long line, one packed import line) | `lib/data-families.ts` 12, `tests/plan-cost-registry.ts` 10, `lib/redis-memory.ts` 8, `tests/store-data-registry.ts` 3. In `tests/plan-cost-registry.ts` the most common conflict hunk is the packed import line (6 of 14; the longest has 694 characters and 22 names) | Mostly: one file per new entry (S3), one entry per line (S4) |
| C3 | **One-time migrations of 18/11** (`docs/value-presentation-2026-10-18.md` became a pointer in #4859, `lib/accessibility-statement.ts` became one entry per line in #4856, section 11 of `tests/switch-keeps-window.test.ts` stopped fixing numbers in #4854) | 13, 3 and 9 PRs; **no conflict was born in these files after each migration merged** (binary search per file) | Already cured; resolve once with main's side |
| C4 | **Aggregate counter** `routeInventory.pageTemplates` in `docs/accessibility-inventory.json`, changed by every PR that adds a page | 37 simulated conflict pairs; few live today because owners re-merged | Yes: remove the counter (S2) |
| C5 | **Real product code**: the same function changed by two PRs | 33 PRs | No. Only small PRs and fast entry reduce it |
| C6 | **Stacks.** A stacked PR inherits its base's conflict; can hide a latent one that appears when the base enters; and (new) receives a conflict when its base merges `main` | Of 44 stacked PRs clean against their base but conflicting with main: 24 inherit, 7 are clean once the stack is simulated in, 9 have their own latent conflict, 4 have an orphan base (R18). #3659 today (R20-1) | Partly: shallow stacks (already followed: no stack deeper than 1 created since 15/11), stack-entry simulation in measurement, check after pushing to a base (rule 10 of AC-M) |
| C7 | **Behavior and measurement.** Late resolution; read-only Codex PRs with no adopter; shallow or stale clones; extra changes inside merge commits; a daily report that undercounts | At 10:40, 64 of 66 conflicts with base `main` were older than the 2 h of AC (a); 8 of the 12 older than 24 h were Codex's. A 50-commit clone showed 10,069 false conflict lines in #2048 against 9 real. 10 of 128 merge commits carried unrelated changes. The 19/11 daily report counted 21 in conflict 12 minutes after a merge; git counted 79 | Mechanized where possible (sections 3, 4, 8); the rest stays behavioral and is said so |

### 1.3 Why AC (a)–(q) did not stop it

- C1 cannot be stopped by behavior: a cost PR merged correctly still puts every other cost PR back in conflict in about
  two hours. The rule "regenerate on merge" (AC (b), (d)) **feeds** the treadmill.
- Most AC rules depend on each agent's memory across many sessions; the measurement above shows the 2-hour deadline
  missed in 64 of 66 cases.
- Codex reads only the first 32 KiB of AGENTS.md (`DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024` in `openai/codex`, one
  budget for all instruction files, truncation with a warning). AGENTS.md has 107,142 bytes; section AC runs from byte
  20,691 to 33,986, so its last part, and every rule appended at the end of AC (as #4850 and #4864 propose), never
  reaches Codex.
- The only daily measure (`prs-parados`, section 2) reads GitHub's `mergeable_state`, which is unstable for minutes
  after each merge, ran 8 to 10 hours late on 16–18/11, and failed once on a single HTTP 503 with no retry.
- `gh issue list` and `gh pr view` (the commands written in MV (a) and CV (a)) use GraphQL, which Claude Code sessions
  refuse with 403. A script that treats that error as "no issue" would push with main red.

### 1.4 Facts the design relies on (all verified by reviewers 4–20; details in Annex A)

- Main's ruleset 26510779 requires a PR, the 9 checks and the merge queue, with `bypass_actors: []`; no workflow can push
  to main. A PR opened with `GITHUB_TOKEN` needs a human approval to run workflows, and its events trigger no others.
- The queue is `ALLGREEN`, `merge_method MERGE`, `strict` false; main receives exactly the queue's commits. The queue
  tests each PR combined with main and the entries ahead, so a combined cost-ceiling breach (AC (l)) still fails there.
- `delete_branch_on_merge` is true and GitHub retargets stacked PRs to `main` automatically when their base merges.
- GitHub does not run `pull_request` workflows on a PR in conflict.
- Generators are a pure function of the commit: the 12 generated files regenerate byte for byte on Node 22.23.5 and on
  the CI's Node 24.22.3, under other time zones, locales, clocks and scipy versions; exceptions found and fixed in the
  plan: order (inventory before statement reviews), the `per-use-resale.mjs` working directory, the missing scipy in
  the default `python3`, and an untracked file in the work tree.
- Conflict is monotonic along main's first-parent chain (68 of 68 PRs, 11,039 merges checked), so a binary search gives
  each conflict's birth and cause without stored state. Blaming "the last merge that touched the file" is wrong (it
  would give #3660 53 PRs; it caused 2).
- Exactly one open PR (#4573) has two merge bases: git says clean, GitHub says `dirty`.
- `GITHUB_TOKEN` allows 1,000 REST requests per hour per repository; standard runners are free on public repositories.

---

## 2. The permanent fix (structural changes)

Principle: remove the **cause** of each repeating conflict class with a change of structure, so no agent has to
remember anything; then make the CI refuse the cause's return (section 3).

### S1. Generated price/margin documents leave PRs and `main` (evaluation and completion of Claude 6's proposal)

**Claude 6's proposal** (asked to the owner, unanswered): PRs stop committing the 7 generated price documents; tests
keep computing every margin from code; documents are regenerated only on main, option 1 by a workflow after each merge,
option 2 by a coordinator PR from time to time.

**Evaluation.** The core is right and is the single change with the largest effect: alone it frees 25 of today's 82
conflicts and removes the class forever (no PR can conflict on a file it may not touch). Its two delivery options need
correcting, not replacing:
- **Option 1 as written cannot work.** No workflow can write to main (ruleset without bypass); a PR opened by the
  workflow with `GITHUB_TOKEN` waits for a human click and runs none of the 9 checks by itself. Making it work needs a
  GitHub App with a bypass on main, which would let any holder of that key write to main without the queue or the 9
  checks. Not recommended; if the owner wants it anyway, it must be a new App used only by that workflow, with its key in
  an Actions secret no agent reads.
- **Option 2 works but leaves stale numbers** on main between coordinator PRs and is recurring manual work.
- **Improvement (recommended): no numbers on main at all, plus automatic publication outside main.** Main never holds
  a stale document because it holds none; every margin is still computed on every PR, in the queue and on main; no
  credential and no human click are needed.

**Design.**
1. **One manifest**, `scripts/generated-docs.json` (data only; read by `scripts/generated-docs.mjs`, the tests, the
   publishing workflow and the CI guard), an **ordered** list of entries: path, generator, hand-written inputs
   (`docs/pricing-optimization-data-2026-10-18.json`, `docs/per-use-resale-data-2026-10-18.json`,
   `docs/zero-cost-value-2026-10-18.md` stay on main as inputs), write path, required notice, and `"stage"`
   (`"in-main"` from S1a, `"out-of-main"` from S1b). Recommended list (9 files): Claude 6's 7 (`margin-alignment`,
   `limits-proposal`, `pricing-usage-proposal`, `pricing-optimization` `.md`, the MILP input and output `.json`,
   `pack-cost-decomposition`) plus `docs/per-use-resale-2026-10-18.md` and `docs/feature-videos-cost.md` (also computed
   from `lib/receiving-costs.ts`). The PR declares which list it uses; today no PR conflicts only on the 2 extra files,
   so the choice changes no count.
2. **On main each `.md` becomes a fixed pointer**: the same historical notice the render puts on top
   (`HISTORICAL_MARGIN_NOTICE` / `HISTORICAL_TAX_NOTICE`), then "Generated document; the current version is on the
   `generated-docs` branch, with the main commit it came from", then "These figures come from the historical sizing and
   most-tax models. They are not the owner's profit calculation under the LC rule in AGENTS.md." US English. The two
   `.json` files leave main. `tests/historical-margin-isolation.test.ts` stays unchanged and passes on the pointer; a new
   test checks each pointer's exact text. References in AGENTS.md, CLAUDE.md and `docs/value-presentation-2026-10-18.md`
   keep working through the pointer (so S1b does not touch that file, changed by 17 open PRs).
3. **Generators write to `generated/`** (in `.gitignore`), never to `docs/`: running one locally never dirties a tracked
   file. `node scripts/generated-docs.mjs --write` runs them in manifest order and then a second pass that must change
   nothing (fixed point), failing with the generator's name otherwise.
4. **Tests lose nothing.** Every margin, floor, `MR > 0`, most-tax-fails, plan-order and "no visible limit cut" assertion
   stays. Each read of the committed file becomes a read of the in-memory render. Equivalences (the PR lists each):

   | Protection today | Equivalent after S1 (same events) |
   | --- | --- |
   | Document on main never stale ("file == render") | main holds no numbers; pointer text fixed by a test; the published branch states its main commit and only moves forward |
   | Old calculation never shown as current proposal (MR) | isolation test unchanged on the pointer; the **render** must start with the notice; publication refuses a file without it |
   | No "ask an accountant" text (`tests/tax-gate.test.ts` scans `docs/`) | the same scan also reads each manifest render in memory |
   | `worstMonthKept` lines, current table rows | the same assertions on `renderMarginAlignment()` etc. |
   | Script == render | `scripts/margin-alignment.mjs --stdout` compared to the render |
   | Reviewer sees a cost's effect on margins (the diff of the document) | the "Behavior regressions" job (shard 1, `pull_request` only, depth-2 checkout, `contents: read`) renders base and head in memory and writes the diff to the job summary; never fails ("not computed" on error). Locally: `node scripts/generated-docs.mjs --diff <base> <head>`. Cost PR "re-review needed" and PRONTO messages quote the changed plan rows from it |
   | Combined cost ceiling of two PRs (AC (l)) | unchanged: ceiling tests run in the queue on the combination |
5. **MILP solver in CI (M1).** Today the optimization render reads the committed MILP output, produced by Python
   (`scipy.optimize.milp`/HiGHS), which never runs in CI. Before the files leave main, shard 1 installs hash-pinned
   `scipy 1.18.1`/`numpy 2.5.5` (`scripts/check-milp-solver.mjs` checks them before anything is written) and asserts
   `solver(committed input) == committed output` byte for byte (true today on main and on all 55 open heads that have
   the input). After S1b the solver runs in memory with `mip_rel_gap: 0`. A new advisory on those libraries can turn main
   red (as in #4842); the fix is a version bump or a dated owner exception (Q1 says so).
6. **Publication** (`.github/workflows/generated-docs.yml`): job `render` (`contents: read`) on `workflow_run` of
   "Product checks" completed successfully, guarded **before any checkout** by
   `github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main' &&
   github.event.workflow_run.head_repository.full_name == github.repository` (a fork branch named `main` would
   otherwise run with secrets; 0 forks today), plus hourly `schedule` and `workflow_dispatch` as backup. It renders with
   the same `node-version` as Product checks and writes `GENERATED-FROM.txt` (main SHA, `node --version`, numpy/scipy
   versions, runner image). Job `publish` (`contents: write`, no `npm ci`, runs no app code) checks the SHA is an
   ancestor of main and newer than the published one, then pushes to branch `generated-docs` only. Its name joins the
   three `NOT_CI` lists. Optional owner extras: a rule forbidding deletion/rewrite of `generated-docs`; Vercel ignoring
   that branch (to be checked in the Vercel panel).
7. **Two PRs, with proof.** **S1a** adds manifest, script, workflow and the job-summary diff while the documents are
   still on main; it must publish **byte-identical** files for 24 h covering at least 2 cost merges. **S1b** then turns
   the `.md` files into pointers, deletes the `.json` files, switches write paths and `"stage"`, and changes the AGENTS.md
   sentences that say the test fails when a document is stale ("One receiving model for every unit") and that tell agents
   to regenerate on merge (AC (b), (d)). S1b enters the queue **alone, with the queue empty**, and cost PRs stop
   requesting the queue until it is on main (about 30 minutes).

### S2. Remove the aggregate inventory counter

The aggregate count `routeInventory.pageTemplates` (today `152`, the last lines of `docs/accessibility-inventory.json`,
written by `scripts/accessibility-route-inventory.mjs`) changes in every PR that adds a page and is read by nothing else
(`git grep routeInventory` on `c1f6b529e`: only the generator and the file). Remove that count only; the
`pageTemplates` **list** at the top of the file stays (it is read by `lib/accessibility-statement.ts` and two tests). Test
B6 refuses the count's return. Wave: 9 PRs, measured; resolution for each is main's side plus
`node scripts/accessibility-route-inventory.mjs --write`.

### S3. One file per new entry in the hottest registries (only new entries; nothing moved in bulk)

- `tests/plan-cost-registry.ts`: a loader for `tests/plan-cost/` fragments (each fragment imports its own constants; the
  big file gains no import per new entry); prototype measured, wave 1 PR (#3583, already in conflict). An extension of
  B7 refuses new lines inside `EMAIL_SITES`, `SCOPES`, `NOT_A_COST` and `COST_LINES` of the big file (warn first).
- `tests/store-data-registry.ts`: the same loader (found by the dashboard's hotspot rule; 3 PRs by 3 merges).
- `lib/redis-memory.ts`: the `EVAL` script simulator gets a generated index with preserved order; production code, so an
  independent review and a behavior-equality proof.
- Precedent: `tests/aliases/<test>.json` (one file per test) has had 0 conflicts.

### S4. Ratchet: one entry per line in the lines a PR touches

In the listed registries (starting with `lib/data-families.ts`, where several keys share one long line), every line a
PR adds or changes must hold one entry, **including named imports** in `tests/plan-cost-registry.ts`,
`tests/store-data-registry.ts` and `tests/plan-cost-registry.test.ts` (32 of the 98 PRs touching the first change a
packed import line). Existing lines are never reformatted in bulk: a one-time reformat would put 103 PRs in conflict.

### S5. No merge notes inside files

Provenance of a merge goes in the merge commit message, never as a comment in the code (84 such notes in 44 PRs were
found). B2 warns.

### S6. Shallow stacks

At most one level (AC (g)), already followed: no deeper stack was created since 15/11 (23 old ones remain, 2 to 6
levels). GitHub retargets automatically when a base merges; no new check (B3 stays in phase 2).

### S7. Two script fixes that make regeneration safe (no generated byte changes)

`scripts/per-use-resale.mjs` passes `cwd: root` to its child process (run from another clone, it silently wrote that
clone's price into 4 lines); `scripts/pricing-optimization.mjs` checks the solver before writing and writes only at the
end (today it writes the MILP input and then fails without scipy, leaving a half-updated set).

### Phase 2 (only if 7 days of measurement show a need) and retired items

- **Phase 2:** `scripts/agent-turn.mjs` (one read-only command per agent), adoption labels, the migration-window issue,
  mechanical-merge proof without re-review (E6/B13), B2/B11/B15 as hard checks, B3, B12 (force-push check; must exempt
  `dependabot/`), one-time sorting/formatting, S3 for other registries, a single exported constant for the US$ 66 ceiling
  repeated in 3 assertions (R18-4), the no-`gh` modes for Codex.
- **Retired** (each with an equivalent): B21 "verified revert" (a config-only PR flips the rule to `warn` first); B17,
  B18 (S3 covers new entries); changing the 9 required workflows' triggers (close/reopen, CV (d), already works); sorting
  privacy lists (risk in privacy/legal code, gain 11→10); B16 (needed only if the owner refuses S1); M2 (removed a check).

---

## 3. Enforcement (what the machine guarantees even if an agent forgets)

### 3.1 One guard script, one step, no new required check name

`scripts/conflict_guards.py` runs as one step in the existing scope job of Product checks, reads its configuration
(`scripts/conflict-guards.json`) **from the base commit** (`HEAD^1` of the PR's merge commit), and gives each rule a
`warn`/`fail` switch that a configuration-only PR can flip the same day (so neither its own fix nor a revert is ever
trapped). Its step has event guards: it runs only on `pull_request` and `merge_group` (a step that ran on `push` to main
after the script's first merge would turn main red). About 1 second per run.

| Rule | Refuses | Mode on day 1 | Open PRs hit today |
| --- | --- | --- | --- |
| B1 | a diff touching any manifest path | armed only when the base manifest says `"stage": "out-of-main"` | 0 until S1b |
| B7 | a new line in the frozen list of `tests/test-config.mjs` (use `tests/aliases/<test>.json`) | `warn`, then `fail` on an announced date | 4 clean PRs, fixed in their next push |
| B14 | a conflict marker left in any file | `fail` | 0 |
| B20 | `AGENTS.override.md` or a nested AGENTS.md/CLAUDE.md | `fail` | 0 |
| B22 | a revert of a main merge inside a PR branch | `fail` | 0 |
| B2 | merge notes in code | `warn` | — |

In `npm test`: B4 (ratchet S4), B6 (counter S2), B10 (AC-M at byte 0 of AGENTS.md and under 4,096 bytes), B19 (every
script that writes under `docs/` with a "file == render" test must be in the manifest, so C1 cannot return under a new
name), the S3 loaders (a fragment with a bad name or duplicate key fails).

**Stacked PRs:** on `pull_request` with base ≠ `main` every rule runs in `warn` (a diff against an old base would blame
the PR for main's content); the hard check is the queue (`merge_group`), which every PR passes with base `main`.

### 3.2 What git and GitHub already guarantee, unchanged

The queue refuses textual conflict and tests every combination (including AC (l) cost ceilings); a non-fast-forward
push is refused without force (protecting another session's head, AC (m)); the 9 checks gate every merge. Nothing here
weakens them.

### 3.3 Machine measurement with an alarm (the dashboard)

`.github/workflows/conflict-report.yml` (own workflow, own concurrency group, because a push trigger inside
`stale-pr-report.yml` would by default cancel that file's pending daily run): triggers `push` to `main`, `schedule:
'7 * * * *'`, `workflow_dispatch`; permissions `contents: read`, `pull-requests: read`, `issues: write`; no `npm ci`.
`scripts/conflict_report.mjs` (tests with synthetic git repositories in `tests/conflict-report.test.ts`) computes the
metrics of section 8 from git (full clone, shallow check, heads from the REST list, head re-fetch on mismatch) and
updates one issue labeled `conflitos`, title "Conflitos parados há mais de 2 horas: N (meta: 0)", open while N > 0,
closed by itself at 0. It never blocks anything. About 10 API calls per run, about 80 runs a day. Hotspot list and
thresholds live in `scripts/conflict-hotspots.json` (coordinator only).

Mutual watch: the hourly queue-health job warns if the `conflitos` issue is older than 3 hours, and both
`scripts/stale_pr_report.mjs` and `scripts/queue_health_report.mjs` retry a transient GET failure (502/503/504/network,
3 tries, 2 s then 8 s) before failing visibly.

### 3.4 What stays behavioral (said plainly)

The 2-hour deadline of AC (a), the per-agent minute and semaphore, the queue tap, "merge main only when needed" (MV (c)),
claiming before preparing a merge (AC (p)), and naming adopters. The dashboard makes each of them visible within an hour;
it does not enforce them.

---

## 4. Rules for every agent (Claude 1 to 7, every Codex, any new agent)

### 4.1 AC-M: the short section at the top of AGENTS.md (exact proposed text, Q4 (a))

Placed at byte 0 so Codex reads it; 2,380 bytes (measured, `scratchpad/r20/acm.md`), under the 4,096 of test B10; does
not use the `## AC — ` header that `tests/agents-ac-section.test.ts` requires exactly once. Reviewer 20 changed
reviewer 13's draft in three places (R20-2): item 3 and item 8 no longer contradict each other (forbidden: reverting
main's merge inside a PR branch; required: reverting a failed step's merge on main through a new PR); items 1 and 2 gain
the shallow/stale-clone check and the stacked-PR target; item 10 is new (R20-1).

> ## AC-M — Conflitos: o essencial (dono, DD/MM/2026)
> Vale para todo agente (Claude 1 a 7, cada Codex e qualquer agente novo). Fica em primeiro lugar e abaixo de 4 KiB
> porque o Codex lê só os primeiros 32 KiB deste arquivo; um teste confere.
> 1. Antes de juntar o main e antes de cada push, confira o main vermelho pela API REST:
>    `gh api -X GET 'repos/solrenning-llc/marktmorgen/issues?labels=main-vermelho&state=open' --jq length`. Resposta 0:
>    pode. Qualquer outro número, erro ou falta de resposta: não empurre. Confira também que o clone não é raso
>    (`git rev-parse --is-shallow-repository` dá `false`) e que o seu `origin/main` é o atual
>    (`git ls-remote origin refs/heads/main`).
> 2. Só junte o main num PR quando houver conflito, logo antes de pedir a fila ou depois do conserto do main vermelho
>    (MV (c)); junte com `git merge origin/main`, nunca rebase, force push nem o botão "Update branch". Num PR empilhado
>    cuja base está aberta, junte `origin/<base>`, nunca o main.
> 3. O commit de junção só junta: nenhuma outra mudança nele e nenhuma nota de junção dentro de arquivo (a proveniência
>    vai na mensagem do commit). Nunca reverta a junção do main dentro do ramo de um PR: junção errada se corrige com
>    commit novo.
> 4. Documento gerado de preço e margem não se edita nem se regenera no PR (lista em `scripts/generated-docs.json`); o CI
>    reprova.
> 5. Registro compartilhado: entrada nova num arquivo próprio quando o registro tiver pasta; senão, uma entrada por
>    linha, sem empacotar. Nada novo na lista antiga de `tests/test-config.mjs`: use `tests/aliases/<teste>.json`.
> 6. PR de quem não escreve mais (hoje o Codex) é juntado só pelo adotante nomeado pelo coordenador.
> 7. As verificações de conflito do CI não se contornam; a mensagem de cada uma diz o comando que conserta.
> 8. Passo desta estratégia que deixou o main errado: reverta primeiro o merge dele no main (`git revert -m 1 <merge>`,
>    num PR novo), investigue depois.
> 9. Regra nova sobre conflito entra nesta seção, nunca só no fim de AC. Não crie `AGENTS.override.md` nem AGENTS.md ou
>    CLAUDE.md em subpastas.
> 10. Depois de empurrar numa base de pilha, confira na mesma rodada cada PR empilhado nela
>     (`git merge-tree --write-tree origin/<base> <cabeça>`) e avise o dono ou o adotante do que ficou em conflito.
> Os porquês e os detalhes estão na seção AC e no painel `conflitos`.

Until S1b merges, item 4 reads: "Documento gerado de preço e margem: só se regenera pelo script, na junção feita logo
antes de pedir a fila" (AC (b) and Q2).

### 4.2 Operating rules (already in AC/MV/CV, collected; none new except where marked)

1. **Ownership is computed, not claimed:** the branch prefix names the owner (`claude/` and `claude1/` → Claude 1;
   `codex/`, `codex-x1/` and user `solrenning-codex` → Codex). Codex only reads since 12/11; the coordinator (Claude 1)
   names an adopter for each Codex PR in one BROADCAST; the dashboard shows the adopter as responsible, or "sem
   responsável".
2. **Before preparing a merge:** no `main-vermelho` (REST); no CLAIMED/HOLD/"re-review needed"/foreign push in the last
   6 hours on the PR or the coordination issue; then publish CLAIMED with the head (AC (p)).
3. **Clone hygiene (new as mechanism, H2–H4):** full clone (`--unshallow` first; without network, do not predict and do
   not merge); `git ls-remote` equals `origin/main` before every push and every PRONTO; collision scans use only the
   REST open list, never all `refs/pull/*`; generators run only with an empty `git status --porcelain
   --untracked-files=all` or in a fresh worktree, from the top of the same worktree.
4. **Never:** rebase, force push, the "Update branch" button, merging the queue tip into a PR, reverting a main merge in a
   PR branch, extra changes in a merge commit, fixing numbers by hand in a shared test (AC (n)).
5. **Status words** ("green", "queued", "merged", "fixed", "reviewed") only with PR number and head, read now (CV (b)).
6. **Cite tests by assertion name or a reproducible `git grep`,** never by line number alone (line numbers age: R19-2).
7. **Codex specifics:** everything a Codex must follow is in AC-M (inside its 32 KiB); no override or nested
   instruction files (B20); if Codex writes again, it follows the same recipe with REST commands only.

---

## 5. One-time safe cleanup of the existing conflicts

### 5.1 Batches (today's numbers; recomputed at the moment of work with the same tool)

| Batch | What | PRs now | How | When |
| --- | --- | --- | --- | --- |
| 0 | Stacked, clean against their base, conflicting with main | 44 | Nothing now. When the base merges, GitHub retargets; any own conflict then follows AC (a) | after the base |
| 1 | Only mechanical, no G (A, I) | 3 | main's side + the generator (I before A) | now |
| 2 | Code or registry, no G | 34 | the recipe (5.3), human decision on code | now, in the order of 5.2 |
| 3a | G plus only mechanical parts | 27 | before S1b: per Q2, merge once just before requesting the queue, regenerating; after S1b: main's side (pointer or deletion), nothing to regenerate | per Q2 |
| 3b | G plus code or registry | 18 | one merge with the code decision; G as in 3a | per Q2 |

By owner (batches 1/2/3a/3b): Claude 1 1/5/2/0; Claude 2 0/3/2/4; Claude 3 0/1/9/0; Claude 4 1/8/3/5; Claude 5 0/0/8/1;
Claude 6 0/0/2/4; Claude 7 0/8/1/3; Codex (adopter) 1/9/0/1. All 9 of Claude 5's conflicts involve G: S1 frees 8 of them
outright.

**Do not "clean" batch 3a in a row just to remove the label**: measured, they return to conflict within about 2 hours of
the next cost merge, and each return costs a review and about 12 minutes of CI.

### 5.2 Order

1. Main-red fix; then security and law; then customer money (charge, checkout, refund, payout, affiliates); then cost;
   then the rest, oldest first (PV (a)).
2. The base before its stack, the chain that unblocks most first: #3587 (law and safety, base of 5) merges now even
   in batch 3, regenerating, and requests the queue in the same round; then #3471, then one level at a time.
3. Ready before clean: a PR with valid reviews that only needs the queue goes first.
4. Do not prepare a merge the queue will undo: `git ls-remote origin 'refs/heads/gh-readonly-queue/*'`, then
   `git merge-tree --write-tree <queue tip> <head>`; if the tip brings a conflict main does not, wait for the queue
   (~12 min per group). Never merge the queue tip into a PR.
5. Before merging a red PR, read why it is red: a reservation, a review finding or the PR's own test is not fixed by
   merging main (21 heads of 7 PRs did that in 24 h, ~124 job-minutes each); infrastructure flakiness is
   `reexecutar #N @sha` of the failed jobs, never a push.

### 5.3 The single safe merge recipe (per PR; until a tool exists, the owner runs it by hand)

0. **May I?** Computed owner or written adoption; no window open for this PR; `main-vermelho` closed by the REST command
   (error = no).
1. **Claim** (AC (p)) as in 4.2.
2. **Full clone and head check:** shallow → `git fetch --unshallow origin`; `git fetch origin main <branch>`; local head
   equals the REST `head.sha`, or stop.
3. **Target and prediction:** base ≠ `main`: if the base merged or closed, retarget to `main` first (CV (h)); if open,
   the target is `origin/<base>`, and only with a conflict against it. `git merge-tree --write-tree <target> HEAD`.
   If `git merge-base --all <target> HEAD` prints more than one line, read `mergeable_state`: `dirty` with a clean
   merge-tree is a GitHub-only conflict (#4573) and needs one merge; `unknown` is re-read later, never "clean".
4. **Merge:** `git merge --no-ff <target>` and resolve by class (in the PR branch, `--theirs` is the target):
   - G before S1b: `git checkout --theirs` the documents, then regenerate with the generators in manifest order
     (scipy 1.18.1/numpy 2.5.5 present, checked with `python3 -c 'import numpy, scipy'`; a generator that exits non-zero
     → `git checkout --` the manifest paths and stop). G after S1b: `--theirs` (pointer) or `git rm`.
   - V: `--theirs`. S: main's side of section 11, re-adding any non-number check the PR added.
   - I then A: main's side and `node scripts/accessibility-route-inventory.mjs --write`; then main's side and
     `node scripts/accessibility-statement-reviews.mjs` (run on the day of the merge).
   - R: keep both entries, one per line, alphabetical among neighbors (AC (d), (q)); when both changed the same entry,
     read `git log -p <merge-base>..<target> -- <file>` and keep both behaviors.
   - P: read both sides and main's commits on the file; keep both behaviors; same code with different comments → the code
     once, both notes; two incompatible designs → stop, record the exact hunk on the PR and the channel, move on.
5. **Merge commit holds only the merge:** `git diff $(git merge-tree --write-tree HEAD^1 HEAD^2 | head -1) HEAD --stat`
   lists only conflicted and regenerated files. Own fixes go in separate commits in the same push. A wrong merge already
   pushed is fixed with a new commit, never by reverting it.
6. **Check:** `git diff --check`; no column-0 markers; `npx tsc --noEmit` with no new error versus `origin/main`; tests of
   the touched files; in a cost PR, the AC (l) ceiling tests on the merge result (`plan-margin`, `read-ceilings`,
   `email-logo-region`, section 11 of `tests/switch-keeps-window.test.ts` and every test using `worstCost`, `netOf` or the
   registry), HOLD if over the ceiling; before S1b, in a cost PR, also regenerate on the **simulated** final merge
   (`git commit-tree` of the merge-tree result, throw-away worktree) and require an empty `git status` (#3022 merges
   cleanly yet regeneration changes 1,820 lines); finally a clean `git merge-tree` against an `origin/main` fetched less
   than 1 hour ago (AC (i)).
7. **Push:** `ls-remote` main equals the `origin/main` used (if not: fetch and redo only the merge-tree); the REST head is
   the merge's first parent; no other active CLAIMED; `main-vermelho` closed; own minute and semaphore; push without
   force; refused → fetch and merge again from the new head.
8. **After:** if this branch is the base of other PRs, check each of them now (AC-M item 10); post `re-review needed #N
   @sha10 (merge of main)` with the human-decision files and, in a cost PR, the changed plan rows; no Actions run in 30
   minutes → CV (d); with reviews and the 9 checks on the head → `fila #N @sha`.

### 5.4 Pace and who does it

One push at a time per agent, in its minute, with the semaphore. Coordinator's cap for cleanup pushes from all agents
together: 10 per hour, up to 20 while `actions/runs?status=queued` reads 0, reduced after 10 minutes of queueing; the
merge queue always has priority (its timeout is 360 minutes). The cap is an estimate, not a measured capacity. One
BROADCAST carries the owner table, batches, order, recipe and cap; after it, the dashboard is the source of truth.

### 5.5 Done criteria

K2 (section 8) equal to 0 for 7 days in a row with healthy measurement (K5); no PR in conflict on G after S1b; at no
moment a push with `main-vermelho` open, a force push, a merge that changes a price, limit, commission, gate or flag, or
a PR closed without the PV (b) note.

---

## 6. Rollout: the PR sequence

### 6.1 Rules for every rollout PR

1. One subject per PR, under 400 lines outside tests (declared exception: S1b's deletion of generated files).
2. Each PR body has "Acessibilidade", "Reversão" (revert first, never revert a merge inside a branch, reintroduce by
   reverting the revert) and its **wave** re-measured on the day: which open PRs would gain a conflict when it merges,
   listed by owner. A wave larger than the table → wait or open an announced window.
3. One rollout PR in the queue at a time; I12 (S1b) alone with an empty queue.
4. A rollout PR does not touch files the stock fights over, except its own object, away from the lines open PRs change.
5. After each merge: 5 first-parent merges and at least 1 hour of observation; a PR that changes a workflow also gets one
   `workflow_dispatch` run of that workflow on main at the merge SHA, read by the author (the red alarm counts only
   `push` and `schedule`, so a red manual run means: revert first and open `main-vermelho` by hand).
6. The next step starts only after the previous is out of observation and with no `main-vermelho` open.
7. Coordinator = Claude 1; release of Codex reservations = Claude 2 (as `docs/reservations.md` already says). Codex
   receives no rollout PR.

### 6.2 The sequence

| # | PR | Owner | Authorization | Wave measured | Verification |
| --- | --- | --- | --- | --- | --- |
| I0 | (no PR) baseline from the dashboard or the classifier; BROADCAST with the owner table | Claude 1 | none | — | numbers recorded with date and main SHA |
| I1 | Release Codex reservation lines whose branch has no open PR **and is not the base of one**: 5 lines (`f-tax-residual-risks`, `h-ses-dedup-ack`, `n-cx121-shipment-release`, `w-reminder-queue-evidence`, `x-member-nudge-evidence`); `a3-c97a-email` stays (base of #2352) | Claude 2 | none (rule of 13/11) | 0 | `tests/reservation-check.test.ts` |
| I2 | Missing lanes in `docs/reservations.md`: `claude1/`, `claude5/`, `claude6/`, `claude7/`, `codex-` | Claude 1 | none | 0 textual; **9 open PRs start failing the reservation check** (#3926, #3997, #4073, #4245, #4408, #4871, #2912, #3481, #3369); recompute on the day, list in BROADCAST | lanes simulation before and after I1 |
| I3 | S7: `cwd: root`; solver check before writing | Claude 6 | none | 0 | regeneration with zero diff on Node 22 and 24; run without scipy writes nothing |
| I3a | Dashboard (3.3) | Claude 5 | none (implements AC (c) and PV (c); read-only plus its own issue) | 0 | synthetic git repos: cross base, stacked base moved, draft, head changed mid-read, cause by transition, thresholds, unreadable answer fails, 503 retried then fails, body ≤ 65,000 chars |
| I3b | Retries in the two report scripts; health job watches the dashboard | Claude 5 | none | 0 | synthetic 503 once → 200; three 503 → still fails |
| I4 | Guard script (3.1), its tests, its configuration, one step with event guards, 3 paths in `SHARED_FILES` | Claude 5 | **Q3** | 0 (step placed after `ci_documentation_scope.py`, away from lines #2048, #3630, #3659, #4094 change) | `--all-open` over open heads: 0 failures in B14/B20/B22; dispatch on main |
| I5 | AC-M at the top of AGENTS.md (4.1) and test B10 in a new file | Claude 1 | **Q4 (a)** | 0 (#4850, #4864 append at the end of AC) | B10 green; `tests/agents-ac-section.test.ts` untouched |
| I6 | AC (j) for a closed base; REST commands in MV (a) and CV (a) | Claude 1 | **Q4 (b), (c)** | 0 expected; measure | the pinned phrase "muda a base para `main`, sem juntar" kept |
| I7 | M1: solver in CI, hash-pinned, output == solver(input) | Claude 6; independent High review by Claude 5 | **Q1** | 0 | 56 of 56 heads give the committed output byte for byte |
| I8 | Python requirement in the dependency audit | Claude 6 | **Q1** | 0 | `npm audit` intact; dispatch on main |
| I9 | S1a: manifest, `generated-docs.mjs`, publishing workflow (`NOT_CI`, `SHARED_FILES`) | Claude 6 | **Q1** | 0 (all new paths free in the 295 open PRs, re-checked by reviewer 20) | render rehearsal in the PR; then 24 h and 2 cost merges publishing **identical bytes** |
| I10 | Cost-effect diff in the job summary; `--diff` | Claude 6 | **Q1** | 0 expected | writes "not computed" and exits 0 when it cannot |
| I11 | S1 prep: every test reads the in-memory render; all "file == render" assertions move into one new test, none removed | Claude 6 | **Q1** | 0 (only #1496 touches the adapted tests, already in conflict) | `npm test` equal; PR lists each moved assertion |
| I12 | **S1b** in an announced window: pointers, deletions, `generated/`, `"stage": "out-of-main"`, pointer test, AGENTS.md sentences; does not touch `docs/value-presentation-2026-10-18.md` or any workflow | Claude 6; independent review | **Q1** (and Q2 for the window) | 48 PRs with base `main` plus 13 stacked change a manifest path (4 clean today: #2271, #3022, #3481, #4436) | queue empty, cost PRs hold their queue requests until it lands |
| I13 | S2 with test B6 | Claude 5 | **Q3** | 9 (5 clean: #1913, #3498, #4048, #4065, #4191) | if #4191 is ready, it enters first |
| I14 | B7 to `fail` (after the 4 clean PRs moved their aliases); later, separately, B2 | Claude 5 | **Q3** | 0 | `--all-open` shows no PR hit by a rule that fails |
| I15 | S4 ratchet (B4) with imports | Claude 5 | **Q3** | 0 | warn first, list of PRs hit; then fail |
| I16 | S3 for `tests/plan-cost-registry.ts` (+ B7 extension) | Claude 5; High review (cost) | **Q3** | 1 (#3583) | loader refuses bad fragments |
| I16b | S3 for `tests/store-data-registry.ts` | Claude 5; High review | **Q3** | measure on the day | dashboard shows "cura sem efeito" if new entries still conflict |
| I17 | S3 for `lib/redis-memory.ts` scripts | coordinator chooses; independent review | **Q3** | measure on the day (45 open PRs touch the file) | behavior-equality proof |
| I18 | (no PR) 7 days of measurement; phase 2 only where needed | Claude 1 | none | — | section 8 |

Dependencies: I3a first (it gives I0's baseline), I3b in parallel; I1 → I2; I3, I4, I5 independent; I5 → I6; I4 → I7 →
I8; I7 → I9 → (I10 and I11 during I9's 24-hour proof) → I12 → I13 → I18; I4 → I14 and I15; I12 and I14 → I16 → I16b;
I15 → I17. Cleanup batches 1 and 2 run from I0 in parallel with everything.

### 6.3 When each class stops being born

| Class | Stops at | Mechanism |
| --- | --- | --- |
| G (45 of 82 today) | the merge commit of I12 | base manifest says `out-of-main`; B1 refuses every diff on a manifest path in PR and queue |
| Inventory counter | I13 | the line no longer exists; B6 |
| Markers, override/nested instruction files, merge reverts in branches | I4 | B14, B20, B22 from day 1 |
| New line in the frozen `tests/test-config.mjs` list | I14 | B7 `fail` |
| New entry at the end of `tests/plan-cost-registry.ts` blocks | I16 + B7 extension `fail` | entries only in fragments |
| Packed lines in registries | falls from I15 | ratchet |
| New `lib/redis-memory.ts` scripts at the same spot | I17 | generated index |
| Product code | never | small PRs, fast entry |

### 6.4 Estimated calendar (not measured; depends on the answers)

Day D (answers): I3a/I3b (may come before D), I0–I3, cleanup starts, I4 and I5 opened. D to D+1: I4–I6 merged and
observed, I7. D+1: I8, I9; the 24-hour proof starts, I10 and I11 during it. D+2 to D+3: I12 window (up to 2 hours,
alone in the queue), then I13. D+3 to D+5: I14–I17, each with its wave measured on the day. D+10: I18. Without Q1,
I7–I12 do not exist and the fallback of Q2 holds.

---

## 7. What needs the owner's authorization

Without any answer, these proceed: I0, I1, I2, I3, I3a, I3b, I18 and cleanup batches 1 and 2. Everything else waits for
one of the four questions below. They complement (Q1) or consolidate earlier drafts (P1–P10, Annex A, 3.1); none runs
in parallel with Claude 6's question (Pedidos repetidos). They go in one message through the channel in force (Claude 1,
`para-claude-1`), in Brazilian Portuguese (IDIOMA).

**Q1 — Documentos de preço fora dos PRs (complemento da pergunta do Claude 6).**
"Sobre a pergunta do Claude 6: você autoriza que os documentos de preço e margem gerados pelo código deixem de ser
gravados nos PRs e no main? Hoje 45 dos 82 PRs em conflito estão em conflito por eles. Nenhum preço, limite, comissão,
trava ou teste de margem muda: os testes continuam calculando todas as margens e tetos em todo PR, na fila e no main. No
main fica, no mesmo caminho, um aviso fixo com o aviso de 'cálculo histórico' de hoje, apontando para um ramo separado
(`generated-docs`), atualizado sozinho por um workflow depois de cada incorporação aprovada nas verificações, sempre com
o número do commit de origem. A opção 1 do Claude 6 (o workflow gravar no próprio main) exigiria dar a um robô permissão
de gravar no main sem a fila e sem as 9 verificações; por isso não a recomendo. Antes de os documentos saírem do main, a
publicação roda 24 horas ao lado deles e precisa produzir exatamente os mesmos arquivos. O otimizador de preços em Python
passa a rodar no CI; um aviso de segurança novo numa biblioteca dele pode deixar o main vermelho, e o conserto é subir a
versão ou uma exceção sua com prazo. Mudam em AGENTS.md as frases que mandam regenerar esses documentos na junção.
Resposta curta possível: 'sim, ramo separado'."

**Q2 — Até a mudança entrar.**
"Até a mudança dos documentos entrar, você aceita que um PR em conflito só nesses documentos seja juntado com o main
apenas logo antes de pedir a fila, e não em até 2 horas como manda AC (a)? E que, depois de você aprovar a Q1 com uma
data, os PRs com conflito nesses documentos e também em código esperem essa data para juntar o main uma vez só? Ficam
fora da espera os PRs de lei e segurança (hoje o #3587, base de 5) e os que já podem pedir a fila. Se a mudança não entrar
até 24 horas depois da data, a espera acaba sozinha e volta o prazo de 2 horas."

**Q3 — Verificações novas no CI e formato dos registros.**
"Você autoriza acrescentar ao CI verificações que só reprovam mais coisa: PR que grava documento gerado, linha nova na
lista antiga de `tests/test-config.mjs`, marcador de conflito esquecido, arquivo de instrução que só o Codex leria,
reversão de uma junção do main dentro de um PR e entrada empacotada nas linhas que o próprio PR muda? E que as entradas
novas dos registros mais disputados passem a ir num arquivo próprio, sem mudar nenhum valor? Entram dentro das
verificações que já existem, primeiro como aviso e depois como trava numa data anunciada, cada uma com uma chave que um
PR só de configuração desliga no mesmo dia. Para seu conhecimento, sem precisar de resposta: completar a tabela de faixas
das reservas fará 9 PRs abertos reprovarem nas reservas no próximo push; e entra um relatório que não trava nada, uma
issue 'Conflitos parados há mais de 2 horas: N (meta: 0)', que o Claude 1 copia em cada status para você."

**Q4 — Três textos curtos em AGENTS.md.**
"Você autoriza: (a) uma seção 'AC-M' em primeiro lugar no AGENTS.md, com 10 itens e menos de 2,5 KB (texto na estratégia,
seção 4.1), que resume as regras contra conflito, para valer também para o Codex, que lê só o começo do arquivo; um teste
impede que ela saia do topo; (b) corrigir AC (j) para o caso da base fechada sem entrar: conferir com `git cherry` e, se
houver trabalho não revisado, levar só os próprios commits para um PR novo; (c) trocar, em MV (a) e CV (a), os comandos
`gh issue list` e `gh pr view`, que o GitHub recusa nas sessões do Claude Code, pelos da API REST, com a regra de que
qualquer erro na conferência significa 'não envie'? Nenhum preço, limite, comissão ou trava muda."

Informative note to send with Q4, not a new question: AC already ends with two points in "Depende do dono" since 15/11
(scan interval of 30 or 60 minutes; whether the second of two colliding PRs waits or proceeds). They are not decided
here (Pedidos repetidos, step 3 (c)). Two measured facts help the decision: the dashboard scans by machine on every merge
and every hour, which makes any manual interval a backup; and a PR's conflict only grows while it waits (68 of 68 PRs),
so waiting does not undo a conflict.

---

## 8. Measurement

### 8.1 Metrics (computed by the dashboard, 3.3)

| Metric | Definition | Goal | Alarm |
| --- | --- | --- | --- |
| K1 In conflict now | Open PRs out of draft whose head conflicts with its current base by `git merge-tree --write-tree`, plus the "GitHub only" class (more than one merge base, git clean, GitHub `dirty`); drafts counted apart; stacked PRs' latent conflicts shown separately, by simulating the stack's entry (never by a direct merge-tree against main) | 0 in G, R, M; in P none older than 2 h | — |
| K2 Stale conflict | K1 PRs in conflict for more than 2 hours; the clock is the latest of: birth by binary search (for stacked PRs on the base branch's first-parent chain), PR creation, and the first main first-parent commit containing the head's merge base | **0** | the `conflitos` issue stays open while K2 > 0 |
| K3 Born | Clean→conflict transitions per causing merge (or causing base push, for stacked PRs), with files and class, per day and 7 days | G = 0 from I12; R falling from I15–I17 | — |
| K4 Hotspot | A file with 3 or more PRs born in conflict on it in 7 days, caused by 2 or more different merges, not in `scripts/conflict-hotspots.json` | none without a cure | "Ponto quente novo" section; coordinator adds it the same day by a config-only PR |
| K5 Measurement health | time of the last dashboard run, of the last `prs-parados` update, git/GitHub divergence | dashboard < 90 min, `prs-parados` < 30 h, divergence 0 except explained | alarm line; the health job watches the dashboard |

Plus, per agent: K1, K2, over 24 h, and "depends on the author (floor: conflicts only) / 15" for MV (b) and AC (h).

Measurement rules: an unreadable answer is never zero (the run fails visibly and the old body stays with its old time);
no stored state except the 14-day display series; full clone required; heads re-fetched on mismatch; GitHub's
`mergeable_state` read only where it can disagree (multiple merge bases), `unknown` never counted as clean; cause only
by transition, never by "last change".

### 8.2 Baseline

Reviewer 17 (10:40 UTC): K1 72 out of draft, K2 64 with base `main`, K3 58 in 24 h (32 with G). Reviewer 20 (11:45): 82
against own base, 77 out of draft, 45 with G. Two more series, measured once by reviewer 11 for 18–19/11: main merges
inside PRs 353 a day, 254 of them regeneration only (goal after I12: 0 regenerations); hours of `main-vermelho` caused
by this strategy (goal 0; if any, revert first).

### 8.3 What counts as proof, and what may be said

- S1 worked: K3 in G = 0 every day since I12's merge; any G birth after it is a defect B1 should have refused.
- S3/S4 worked: R births per week fall at least by half from the baseline, and K4 shows no "cura sem efeito".
- Cleanup done: K2 = 0 for 7 days with K5 healthy.
- Daily cross-check: git's K1 against `prs-parados`' dirty count when that report is not partial; an unexplained gap
  prints "medições divergem".
- To the owner: "K2 = 0 for N days; the conflicts born are code only; no hotspot without a cure", always with dates and
  the issue number. Never "zero conflicts forever" (VR, item 8).

---

## 9. Risks left and how they are covered

| Risk | Coverage | Residual |
| --- | --- | --- |
| Product-code conflicts (C5, ~33 today) | small PRs, fast entry, the recipe, the 2-hour dashboard alarm | cannot be zero; said to the owner |
| **R20-1: a push to a base moves the conflict up the stack** (#3659 today: Codex, read-only, entered conflict because its base #3608 merged main) | AC-M item 10 and recipe step 8: after pushing to a base, check each stacked PR now and tell its owner or adopter; K3 attributes the birth to the base push | memory until AC-M is authorized; the dashboard shows it within the hour regardless |
| Read-only Codex stock (11 PRs in conflict, #3659 included; 10 out of draft) | one adopter per PR named by the coordinator; dashboard shows "sem responsável" otherwise | depends on the coordinator acting |
| Latent conflicts in stacks (9 measured) | stack-entry simulation in the dashboard; they surface when the base enters and follow AC (a) | they still appear, later |
| GitHub-only conflict (multiple merge bases, #4573) | dashboard class; recipe step 3 reads `mergeable_state` | one PR today |
| `mergeable_state` unstable after merges | all counting by git | — |
| Publication workflow fails or stops | 24-hour byte-identical proof before S1b; hourly backup schedule; ancestry and newer-SHA check; `GENERATED-FROM.txt` | published numbers can lag up to an hour; main never shows wrong numbers |
| Supply-chain alarm on scipy/numpy turns main red | hash-pinned requirements; fix by bump or a dated owner exception (stated in Q1) | possible red main, with a known fix |
| Node or runner image changes a last-bit rounding | `GENERATED-FROM.txt` records versions; before S1b, a "stale" failure without a commit is read in the job's `Found in cache` line and fixed by the coordinator from the render artifact; after S1b the class disappears (render compared with itself) | — |
| A stale, shallow or dirty clone produces wrong merges | AC-M item 1, recipe steps 2, 4, 7; non-fast-forward push refused by git | — |
| The guard script itself turns main red | event guards (never on `push`), config from base, `warn`/`fail` switch, dispatch after merge, revert first | one observation window |
| Owner refuses S1 | Q2's "merge just before the queue"; B16 kept as a fallback check; regeneration in the recipe | the G treadmill continues, slower |
| Reservation lanes make 9 PRs fail | I1 first; list in the BROADCAST; owners wait for release or agree with the reservation owner | short delay for 9 PRs |
| AGENTS.md grows past what Codex reads | AC-M at byte 0, under 4 KiB, test B10; B20 forbids override files | the rest of AC stays outside Codex's 32 KiB |
| Behavioral rules forgotten (2 h, semaphore, tap, claims) | dashboard makes each visible in an hour; mechanism wherever possible | still behavior |
| Dependabot (0 PRs ever; security updates limited to 10 by GitHub) rebases its branch on conflict | if it ever opens one: "sem responsável" on the dashboard, adopted by the coordinator; B12 (phase 2) exempts `dependabot/` | whether security updates are enabled could not be verified |
| Hotspot thresholds wrong (one day of data) | thresholds in configuration, adjusted by a config-only PR | possible early false alarms |

**Not verified** (and why): the 24-hour Actions series (353/254 merges, 6,178 runs) were measured once by reviewers 11,
12 and 17 and not redone; the dashboard's real runtime on a hosted runner; whether the queue accepts `queue: max`
concurrency here; Codex in ChatGPT cloud with the 32 KiB default; whether Dependabot security updates are on (the proxy
refuses that API path); whether the owner follows GitHub issue notifications; the answer to Claude 6's question (not
readable from this session); a distribution Node with system ICU.

---

