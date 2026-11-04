# Backup cost — 273 [BK1], worst case under the MR rule (4 November 2026)

Status: **cost review prepared; not admitted.** Nothing is switched on by this document. `BACKUP_COST_REVIEW` in `lib/backup-run.ts` stays `null`; no bucket, key, variable, lifecycle rule, cron entry or route is created. The owner sets up the bucket and the variables (docs/backup.md, owner prerequisites). Under the MR rule (AGENTS.md, "MR — Regra de margem vigente"), an unknown cost fails and is never zero, and no supplier free quota is counted as zero. The open items in "What is still unknown" below keep this review from passing. The owner's bucket, key and variables (inbox C4-25) and the proposed 30-day retention are in section 5a.

Code read: `origin/main` at `fcd1617ac` (4 November 2026): `lib/backup-run.ts`, `lib/backup-export.ts`, `lib/backup-store.ts`, `lib/backup-roundtrip.ts`, `lib/backup-codec.ts`, `lib/store-data-rules.ts`, `tests/store-data-registry.ts`, `lib/spend-cost-table.ts`, `lib/llc-fixed-costs.ts`, `docs/backup.md`; queue item 273 [BK1] in docs/codex-queue.md.

## 1. What one run does (from the code)

| Quantity | Value in the code | Where |
|---|---|---|
| What is copied | Every Redis key under `nl:` in the database, as one snapshot of the **whole database** (all stores and company keys together), not one copy per store | `exportSnapshot`, `BACKUP_PREFIX` |
| Commands per run | `SCAN` pages (`COUNT 500`, a hint) + 2 per key (`DUMP`, `PEXPIRETIME`) + 2 run marks (`SET NX` day mark, one outcome `SET`). Refused before any `DUMP` if the total would pass `maxCommands` | `exportSnapshot`, `RUN_COMMANDS = 2` |
| Rows per run | at most 10,000 keys (`BACKUP_MAX_ROWS`) | `lib/backup-export.ts` |
| Size per run | at most 4 MiB of sealed JSON (`BACKUP_MAX_BYTES` = 4,194,304 bytes); stored object at most that + 65,536 bytes of seal room = **4,259,840 bytes** (`objectBound`) | `lib/backup-run.ts` |
| R2 operations per run | 1 `PutObject` with `If-None-Match: *` (Class A; a 412 is also billed as Class A) + 1 `GetObject` read-back (Class B). No delete, no list | `r2BackupStore`, `verifyBackupRoundtrip` |
| Runs | at most 1 per UTC day (`SET nl:backup:ran:<day> NX`), so at most **31 a month**; a second call the same day costs 1 command and stops | `runBackup` |
| Retention | Not in code: a lifecycle rule the owner sets on the bucket. `validReview` demands `(retentionDays + 1) × objectBound ≤ maxStoredBytes` | `validReview` |
| Daily report reads | `backupStale()` 1 `GET` + `backupLastFailure()` 1 `GET` | `lib/backup-run.ts` |
| Schedule and route | None yet; no `maxDuration` exists for the run | `vercel.json` unchanged |

The queue item asks for 30 daily copies plus weekly copies for 3 months. The code keeps one object a day under `backups/` and relies on an age-based lifecycle rule, so it can do "keep every day for N days" but not "daily for 30, then weekly". Both are priced below: 30 days (31 objects at once) and 90 days (91 objects at once, which covers the 3 months with daily copies). A true 30 + 13 weekly scheme needs a second prefix and code that does not exist.

## 2. Prices used, with source and date

This session's network refuses `developers.cloudflare.com`, `upstash.com` and `vercel.com`. Claude 1 reread the Cloudflare R2 and Upstash pages on 4 November 2026 (inbox C4-27); their figures are the same as the repository's, and the rows below say so. The Vercel rates were not reread: they are the ones the repository records, with their date.

| Rate | Figure | Official source | Read on (as recorded) | Recorded in |
|---|---|---|---|---|
| R2 Standard storage | $0.015 per decimal GB-month | https://developers.cloudflare.com/r2/pricing/ ("Last updated Oct 30, 2026") | **2026-11-04 (Claude 1, inbox C4-27)**; earlier 2026-10-16, 2026-10-17, 2026-10-22 | `lib/spend-cost-table.ts` (`R2_STORAGE_MICRO_USD_PER_GB_MONTH`), docs/backup.md, docs/tier-storage-limits.md |
| R2 Class A operations | $4.50 per million; a PutObject answered 412 by If-None-Match counts as Class A | same | 2026-11-04 (C4-27) | `R2_CLASS_A_MICRO_USD_PER_MILLION` |
| R2 Class B operations | $0.36 per million; a request refused for authentication is not billed | same | 2026-11-04 (C4-27) | `R2_CLASS_B_MICRO_USD_PER_MILLION` |
| R2 egress | $0 ("data out free"; reads are still operations) | same | 2026-11-04 (C4-27); earlier 2026-10-19, 2026-10-31 | docs/plan-capacity-provider-review.md, lib/picture-r2.ts, queue (CV1 unit 4) |
| R2 billing rounding | usage rounded up to the next billing unit | same | 2026-10-16, 2026-10-22 | docs/tier-storage-limits.md, docs/backup.md |
| R2 free quota | 10 GB-month, 1 million Class A, 10 million Class B a month; **never credited** (MR) | same | 2026-11-04 (C4-27) | docs/backup.md ("no free-tier credit") |
| R2 delete / lifecycle expiry | not recorded in the repository | — | — | **unknown** (see section 5) |
| Upstash commands | $0.20 per 100,000 = $2.00 per million (pay as you go), reads and writes alike; operational commands (AUTH, PING) not billed | https://upstash.com/pricing/redis (page undated) | **2026-11-04 (C4-27)**; earlier 2026-10-17, 2026-10-22 | `UPSTASH_MICRO_USD_PER_MILLION_COMMANDS`, docs/backup.md |
| Upstash billing of every command, pipelines and scripts included | yes (the pricing page does not say how scripts and pipelines count; the billing page does, and the worst case is used) | https://upstash.com/docs/redis/overall/billing | 2026-10-31 | docs/backup.md |
| Upstash storage | $0.25 per GB; the first GB free is **not credited** | https://upstash.com/pricing/redis | 2026-11-04 (C4-27) | the three marks: under 1 KB |
| Upstash bandwidth | $0.03 per GB past a free 200 GB a month; free part **not credited** | https://upstash.com/pricing/redis | 2026-11-04 (C4-27); earlier 2026-10-17, 2026-10-31 | `UPSTASH_MICRO_USD_PER_GB_TRANSFER` |
| Vercel function memory | $0.0106 per GB-hour, 2 GB function | Vercel pricing | 2026-10-07 | `VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR`, tests/traffic-cost.ts |
| Vercel CPU | $0.128 per CPU-hour | same | 2026-10-07 | `VERCEL_CPU_MICRO_USD_PER_HOUR` |
| Vercel function call | $0.60 per million | same | 2026-10-07 | `VERCEL_CALL_MICRO_USD_PER_MILLION` |
| Provider invoice allowance | +10% on every supplier charge (taxes on the invoice, exchange, card) — a deliberate allowance, not a rate | — | — | `PROVIDER_CHARGES_BPS = 1_000` |

## 3. Today's design: one whole-database copy a day (company cost)

Because one run copies the whole database, the cost does not grow with the number of stores until the 4 MiB / 10,000-key cap is reached; past the cap the run refuses (`export_too_big` or `export_too_many`) and stores nothing. So, as built, it is a **company cost**, bounded by the caps, and belongs with the LLC fixed costs and the minimum base (FX275), not inside a plan.

Proposed ceiling for `BACKUP_COST_REVIEW` (a proposal, not set): `maxRows` 10,000; `maxBytes` 4,194,304; `maxCommands` 20,202 (20,000 for the copy, 200 `SCAN` pages, 2 marks); `retentionDays` 30 or 90; `maxStoredBytes` = (retentionDays + 1) × 4,259,840. With 200 `SCAN` pages the walk covers about 100,000 keys in the whole shared database (the hint is not a guarantee); a larger database makes the run refuse with `export_budget`, which is a visible failure, not a higher bill.

Formulas, per month of 31 runs:

- Upstash commands = 31 × (20,202 + 2 report reads) × $2.00 / 1,000,000 = 626,324 commands = **$1.2526**
- Upstash bandwidth = 31 × (4,194,304 bytes of `DUMP` answers + 200 pages × 500 names × 1,024 bytes of `SCAN` answers) = 3.304 GB × $0.03 = **$0.0991** (1,024 bytes is the longest key name the codec accepts for our keys; other products' names are not capped, see section 5)
- R2 storage, 30 days = 31 × 4,259,840 = 132,055,040 bytes = 0.1321 GB × $0.015 = **$0.0020**; 90 days = 91 × 4,259,840 = 387,645,440 bytes = 0.3876 GB × $0.015 = **$0.0058**
- R2 operations = 31 × $4.50 / 1,000,000 + 31 × $0.36 / 1,000,000 = **$0.000151**
- R2 egress = $0 (official page, as recorded)
- Vercel, with a route `maxDuration` of 300 s (to be set when the route is built) = 31 × (2 GB × 300 s / 3,600 × $0.0106 + 300 s / 3,600 × $0.128 + $0.0000006) = **$0.3855** (with 60 s, like the other cron routes: $0.0771)
- Upstash storage of the 3 small marks: under 1 KB, under $0.000001.

| Line, per month | 30-day retention | 90-day retention |
|---|---|---|
| Sum, linear | $1.7394 | $1.7432 |
| + 10% provider allowance | **$1.9133** | **$1.9175** |
| Worst case with R2 whole-unit rounding: one extra billing unit per class ($0.015 storage + $4.50 Class A + $0.36 Class B), + 10% | **$7.2735** | **$7.2735** |
| A year (12 worst months), linear + allowance | $22.96 | $23.01 |
| A year, with whole-unit rounding | $87.28 | $87.28 |

The rounding line matters more than the usage itself. Cloudflare rounds the **account's** usage up to the next billing unit, so the backup can push the account over one more unit per class at most once a month. That marginal unit is an account-wide, company-level cost, to be counted **once** among the fixed costs (shared by sold files, pictures and backup), never once per feature or per store. If the owner puts the backup bucket in a separate Cloudflare account, the whole minimum unit falls on the backup. The size of one unit (taken here as 1 GB-month and 1 million operations, consistent with the whole-GB rounding in docs/tier-storage-limits.md) still has to be read on the official page.

**The limit of this design:** a single Store-plan store at full use can keep about 227 MB in Redis (next section), roughly 54 times the 4 MiB cap. Once the real database passes 4 MiB or 10,000 keys, every run refuses and no backup exists. Today's design does **not** back up 100% of the plans' rights. The cost stays bounded only because nothing is copied.

## 4. Backup of 100% of each plan's rights: per-store cost (format in parts, not built)

To copy a full store, the format must be split into parts (listed as missing in docs/backup.md). Then the cost grows with each store's data and **belongs in each plan's worst month** (`tests/plan-cost-registry.ts`), not in fixed costs.

Bytes a store can keep in Redis at full use = data room (`DATA_ROOM_BYTES`, `lib/store-data-rules.ts`) + the most it keeps outside the room at one time (`reservePeakBytes`, `tests/store-data-registry.ts`, computed with the repository's own function on 4 November 2026):

| Plan (price) | Data room | Peak outside room | Total in Redis | One copy (× 4/3, base64) | 4 MiB parts |
|---|---|---|---|---|---|
| Store ($69) | 18,000,000 | 209,230,481 | 227,230,481 | 0.3030 GB | 72 |
| Studio ($449) | 135,000,000 | 593,771,021 | 728,771,021 | 0.9717 GB | 229 |
| Scale ($999) | 250,000,000 | 1,877,390,853 | 2,127,390,853 | 2.8365 GB | 666 |

Formulas per store, per month of 31 runs: storage = copies kept × copy GB × $0.015 (31 copies for 30 days, 91 for 90 days); Upstash bandwidth = 31 × copy GB × $0.03; R2 operations = 31 × parts × ($4.50 + $0.36) / 1,000,000. Gzip savings are not credited (worst case: data that does not compress).

| Plan | Storage, 30 days | Storage, 90 days | Upstash bandwidth | R2 operations | Known lines + 10%, 30 days | Known lines + 10%, 90 days |
|---|---|---|---|---|---|---|
| Store | $0.1409 | $0.4136 | $0.2818 | $0.0108 | **$0.4768** | **$0.7768** |
| Studio | $0.4518 | $1.3264 | $0.9037 | $0.0345 | **$1.5290** | **$2.4911** |
| Scale | $1.3190 | $3.8718 | $2.6380 | $0.1003 | **$4.4630** | **$7.2711** |

The monthly and annual intervals have the same worst month (one run a day either way). These are **incomplete lines**: they leave out the per-store Upstash commands (2 per key; the number of keys a store can hold at full use is not tabulated) and the Vercel time to move up to 2.84 GB a day (no design or measurement). Both are unknown, so the per-store figure fails under MR until they are bounded. The backup also keeps a closed store's data for the retention days after it ends; that tail belongs to the after-the-end cost already priced per plan and must be added there.

## 5. What is still unknown (each one fails the review; none is zero)

1. **Vercel's page not reread.** R2 and Upstash were reread on 4 November 2026 (Claude 1, inbox C4-27); the Vercel rates keep their recorded date of 7 October 2026 until someone rereads them.
2. **R2 billing unit size** (taken as 1 GB-month and 1 million operations) and whether lifecycle expiry deletions are free. Neither is recorded in the repository with a source.
3. **R2 free quota amount**: 10 GB-month, 1 million Class A and 10 million Class B a month (C4-27); not needed for the result, because it is never credited.
4. **Vercel run duration**: no route exists, so there is no `maxDuration`; the figures assume 300 s. Also not verified: whether Vercel bills a function's outbound transfer to R2 and Upstash (the repository's traffic model has no such line).
5. **`SCAN` answer size**: `COUNT 500` is a hint; the names of other products' keys in a shared database are not capped. The bandwidth line assumes at most 500 names of at most 1,024 bytes a page. A byte cap on the walk's answers would make this a bound instead of an assumption.
6. **Ratio between `DUMP` length and Upstash's billed data size**: taken as at most 1 (copy = 4/3 × stored bytes). Not measured. The independent review in docs/backup.md measured a HyperLogLog `DUMP` of 5–12 KB, so it needs a real measurement.
7. **Per-store key count and per-store Vercel time** for a backup in parts (section 4).
8. **Repository bundles** (item 4 of BK1): not built; sizes not measured (this session has a shallow clone and no GitHub API access to the three repositories).
9. **Second copy of sold files** (item 3 of BK1): not built. For scale only, one extra copy of a full Scale store's 80 GiB would be 85.9 GB → 86 GB-month × $0.015 = $1.29 a month per store, before operations. Not a proposal.
10. **No fixed-cost line exists**: `LLC_FIXED_COST_IDS` in `lib/llc-fixed-costs.ts` has no backup or R2-rounding entry, and `tests/plan-cost-registry.ts` has no backup line. Adding them is a code change for a later unit.

## 5a. The owner's setup (inbox C4-25, 4 November 2026) and the retention to set

What the owner did today, as reported through the inbox (not verified from this session, which has no access to the Cloudflare or Vercel accounts):

- R2 bucket `marktmorgen-backup`: private, public access off, **Standard** class, location chosen automatically (Eastern North America), **no jurisdiction** (so `BACKUP_R2_JURISDICTION` stays unset), separate from `marktmorgen-files`.
- An account R2 token `marktmorgen-backup-production`: Object Read & Write, on that bucket only, no expiry.
- In Vercel, Production only: `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `BACKUP_ENCRYPTION_KEY` (32 random bytes in base64, with a copy kept by the owner outside Vercel).
- The account's R2 billing has no free credit counted here (MR: a supplier's free quota is never zero cost).

None of this switches the backup on (docs/backup.md): `BACKUP_COST_REVIEW` is still `null`, and the lifecycle rule, the daily schedule and the report's delivery do not exist.

**Retention: 30 days (proposal for the lifecycle rule).**

- **Cost:** 30 and 90 days differ by $0.0038 a month in storage (section 3). Cost does not decide.
- **Privacy:** a backup keeps a person's data after it is erased on the site. A shorter retention lets that copy go sooner, and the privacy text that must be published when the backup is switched on (docs/backup.md, prerequisite 7) can say "up to 30 days".
- **Recovery:** 30 daily copies are enough to notice a mistake and go back to before it within a month. Upstash's own provider backup keeps 1 or 3 days (docs/backup.md, provider research), so this is the only longer history.
- **Rule for the owner:** in the bucket `marktmorgen-backup`, an object lifecycle rule that deletes objects with prefix `backups/` **30 days** after they were created. The code has no delete (`lib/backup-store.ts`), so this rule is the only retention.
- **Matching review figures:** `retentionDays` 30; `maxStoredBytes` = (30 + 1) × 4,259,840 = **132,055,040 bytes**, which `validReview` accepts, because (retentionDays + 1) × objectBound ≤ maxStoredBytes holds with equality.

**Retention approved** (owner, MR; inbox C4-27, 4 November 2026): 30 days, `maxStoredBytes` 132,055,040.

**Still blocking the review:** the R2 and Upstash prices are reread with today's date (section 2). The Vercel rates keep their recorded date of 7 October 2026. The other open items in section 5 remain: the R2 billing unit's size and whether lifecycle expiry is billed, the route's duration, the `SCAN` answer size, the `DUMP`/billed-size ratio, and the missing fixed-cost line. Until they are closed, this review is not admitted and `BACKUP_COST_REVIEW` stays `null`.

## 6. Where each cost belongs

- **As built (whole database, 4 MiB cap):** company cost → LLC fixed costs, 100% Marktmorgen (FX275), minimum base. Bound: $1.92 a month linear, $7.28 a month with R2 whole-unit rounding, both with the 10% allowance.
- **R2 whole-unit rounding:** one account-wide fixed line, counted once.
- **A backup that covers 100% of every plan's rights (format in parts):** per-store variable cost → each plan's worst month, monthly and annual, with an automatic ceiling before each run (the existing `maxCommands`/`maxBytes`/`maxStoredBytes` caps, sized per store). Known lines: $0.48 / $1.53 / $4.46 a month (Store / Studio / Scale) at 30 days; $0.78 / $2.49 / $7.27 at 90 days; plus the unknown lines in section 5.

No price, visible limit, commission, flag, gate, tax reading or cost table is changed by this document. It does not certify any margin or profit: the per-plan recomputation and the minimum base belong to MR2/MR3 and FX275 (item 275).
