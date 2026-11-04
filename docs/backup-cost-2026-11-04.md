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
| R2 operations per run | 1 `PutObject` with `If-None-Match: *` (Class A; a 412 is also billed as Class A) + 1 `GetObject` read-back (Class B). No delete, no list (since section 5d: one `ListObjectsV2` page a run, Class A, and a free `DeleteObject` for each copy past the retention) | `r2BackupStore`, `verifyBackupRoundtrip` |
| Runs | at most 1 per UTC day (`SET nl:backup:ran:<day> NX`), so at most **31 a month**; a second call the same day costs 1 command and stops | `runBackup` |
| Retention | Not in code: a lifecycle rule the owner sets on the bucket. `validReview` demands `(retentionDays + 3) × objectBound ≤ maxStoredBytes` since the review of #2175; before it, `retentionDays + 2` since #2219, and `retentionDays + 1` before that | `validReview` |
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

Formulas, per month of 31 runs (superseded by section 5c: 32 runs, retention + 3 sets, every command a full `SCAN` page):

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

Formulas per store, per month of 31 runs (superseded for the number of runs by section 5c: 32): storage = copies kept × copy GB × $0.015 (31 copies for 30 days, 91 for 90 days); Upstash bandwidth = 31 × copy GB × $0.03; R2 operations = 31 × parts × ($4.50 + $0.36) / 1,000,000. Gzip savings are not credited (worst case: data that does not compress).

| Plan | Storage, 30 days | Storage, 90 days | Upstash bandwidth | R2 operations | Known lines + 10%, 30 days | Known lines + 10%, 90 days |
|---|---|---|---|---|---|---|
| Store | $0.1409 | $0.4136 | $0.2818 | $0.0108 | **$0.4768** | **$0.7768** |
| Studio | $0.4518 | $1.3264 | $0.9037 | $0.0345 | **$1.5290** | **$2.4911** |
| Scale | $1.3190 | $3.8718 | $2.6380 | $0.1003 | **$4.4630** | **$7.2711** |

The monthly and annual intervals have the same worst month (one run a day either way). These are **incomplete lines**: they leave out the per-store Upstash commands (2 per key; the number of keys a store can hold at full use is not tabulated) and the Vercel time to move up to 2.84 GB a day (no design or measurement). Both are unknown, so the per-store figure fails under MR until they are bounded. The backup also keeps a closed store's data for the retention days after it ends; that tail belongs to the after-the-end cost already priced per plan and must be added there.

## 5. What is still unknown (each one fails the review; none is zero)

1. **Vercel's page not reread.** R2 and Upstash were reread on 4 November 2026 (Claude 1, inbox C4-27); the Vercel rates keep their recorded date of 7 October 2026 until someone rereads them.
2. **R2 billing unit and lifecycle expiry: closed** (read by Claude 1 on 4 November 2026, inbox C4-38). https://developers.cloudflare.com/r2/pricing/ : Standard storage $0.015 per GB-month, "A GB-month is calculated by averaging the peak storage per day over a billing period (30 days)", usage rounded up to the next unit (1.1 GB-month bills 2); Class A $4.50 per million, Class B $0.36 per million; DeleteObject, DeleteBucket and AbortMultipartUpload free; no minimum duration on Standard; egress free; the free quota is never credited. https://developers.cloudflare.com/r2/buckets/object-lifecycles/ : expired objects are removed "within 24 hours" of expiry, and an object is billed until it is deleted; the page does not say whether a lifecycle deletion is billed as an operation, so it is taken as **one Class A operation per expired object**, never zero. Consequences for the figures: a 30-day rule keeps up to 30 days + 1 of delay + the day being written, so the daily peak is taken as **32 copies** (not 31), and every object a run writes costs one more Class A when it expires. The rule exists on the bucket since 4 November 2026, 14h40 (`delete-backups-after-30-days`, prefix `backups/`, 30 days, active, made by Claude 1 at the owner's request); the parts and the manifest are written under `backups/` (`lib/backup-store.ts`).
3. **R2 free quota amount**: 10 GB-month, 1 million Class A and 10 million Class B a month (C4-27); not needed for the result, because it is never credited.
4. **Vercel run duration**: no route exists, so there is no `maxDuration`; the figures assume 300 s. Also not verified: whether Vercel bills a function's outbound transfer to R2 and Upstash (the repository's traffic model has no such line).
5. **`SCAN` answer size**: `COUNT 500` is a hint; the names of other products' keys in a shared database are not capped. The bandwidth line assumes at most 500 names of at most 1,024 bytes a page. A byte cap on the walk's answers would make this a bound instead of an assumption.
6. **Ratio between `DUMP` length and Upstash's billed data size**: measured on 4 November 2026 (Claude 4, inbox C4-30) on a local Redis 7.0.15, with `scripts/backup-dump-ratio.py` (19 keys of every type the stores use: strings random, repetitive and JSON, hashes, sets, sorted sets, a list, HyperLogLogs). Results below. **Against Redis's own memory accounting (`MEMORY USAGE`), `DUMP` was smaller in every case (at most 0.973).** Against the bytes the application sends (key plus values), it was at most 1.609 (a 10-member sorted set, whose scores take more than 8 bytes each) and a few bytes more for tiny keys (22 bytes for a 17-byte string). base64 adds 4/3 on top. **Still open:** which of these two Upstash bills as "data size" is not confirmed from its documentation here. Under the reading with more cost, the copy's bytes are taken as at most 1.7 × the logical bytes + 16 bytes a key, × 4/3 for base64, instead of the 4/3 × stored bytes assumed above. The figures in section 4 need this factor once Upstash's metric is read.

| Case | Logical bytes | DUMP | base64 | MEMORY USAGE | DUMP/logical | base64/logical | DUMP/MEMORY |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| string random 10B | 17 | 22 | 32 | 72 | 1.294 | 1.882 | 0.306 |
| string random 100B | 108 | 113 | 152 | 168 | 1.046 | 1.407 | 0.673 |
| string random 1000B | 1009 | 1013 | 1352 | 1080 | 1.004 | 1.340 | 0.938 |
| string random 10000B | 10010 | 10013 | 13352 | 10296 | 1.000 | 1.334 | 0.973 |
| string random 100000B | 100011 | 100016 | 133356 | 114744 | 1.000 | 1.333 | 0.872 |
| string repetitive 1000B | 1009 | 33 | 44 | 1080 | 0.033 | 0.044 | 0.031 |
| string repetitive 100000B | 100011 | 1162 | 1552 | 114744 | 0.012 | 0.016 | 0.010 |
| string JSON 13700B | 13707 | 6604 | 8808 | 14392 | 0.482 | 0.643 | 0.459 |
| hash 10 fields | 227 | 280 | 376 | 376 | 1.233 | 1.656 | 0.745 |
| hash 100 fields | 2298 | 2580 | 3440 | 3128 | 1.123 | 1.497 | 0.825 |
| hash 1000 fields | 23899 | 25903 | 34540 | 72304 | 1.084 | 1.445 | 0.358 |
| set 10 members | 169 | 182 | 244 | 864 | 1.077 | 1.444 | 0.211 |
| set 1000 members | 16011 | 17013 | 22684 | 64304 | 1.063 | 1.417 | 0.265 |
| zset 10 members | 248 | 399 | 532 | 504 | 1.609 | 2.145 | 0.792 |
| zset 1000 members | 24010 | 25013 | 33352 | 118672 | 1.042 | 1.389 | 0.211 |
| list 500 items | 15007 | 16032 | 21376 | 16560 | 1.068 | 1.424 | 0.968 |
| HyperLogLog 10 adds | 57 | 60 | 80 | 152 | 1.053 | 1.404 | 0.395 |
| HyperLogLog 1000 adds | 1912 | 1842 | 2456 | 2104 | 0.963 | 1.285 | 0.875 |
| HyperLogLog 100000 adds | 12317 | 10645 | 14196 | 14392 | 0.864 | 1.153 | 0.740 |

7. **Per-store key count and per-store Vercel time** for a backup in parts (section 4).
8. **Repository bundles** (item 4 of BK1): not built; sizes not measured (this session has a shallow clone and no GitHub API access to the three repositories).
9. **Second copy of sold files** (item 3 of BK1): not built. For scale only, one extra copy of a full Scale store's 80 GiB would be 85.9 GB → 86 GB-month × $0.015 = $1.29 a month per store, before operations. Not a proposal.
10. **Fixed-cost line: added** (inbox C4-44, after #1492 merged): `backup` in `LLC_FIXED_COST_IDS` (`lib/llc-fixed-costs.ts`), priced by `backupWorstMonth` in `lib/backup-cost.ts` from a review's caps (section 5c). Its reviewed ceiling stays unknown while `BACKUP_COST_UNKNOWNS` are open and the owner has not approved a monthly cost.

## 5a. The owner's setup (inbox C4-25, 4 November 2026) and the retention to set

What the owner did today, as reported through the inbox (not verified from this session, which has no access to the Cloudflare or Vercel accounts):

- R2 bucket `marktmorgen-backup`: private, public access off, **Standard** class, location chosen automatically (Eastern North America), **no jurisdiction** (so `BACKUP_R2_JURISDICTION` stays unset), separate from `marktmorgen-files`.
- An account R2 token `marktmorgen-backup-production`: Object Read & Write, on that bucket only, no expiry.
- In Vercel, Production only: `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `BACKUP_ENCRYPTION_KEY` (32 random bytes in base64, with a copy kept by the owner outside Vercel).
- The account's R2 billing has no free credit counted here (MR: a supplier's free quota is never zero cost).

None of this switches the backup on (docs/backup.md): `BACKUP_COST_REVIEW` is still `null`, and the lifecycle rule, the daily schedule and the report's delivery do not exist.

**Retention: 30 days (proposal for the lifecycle rule).**

- **Cost:** 30 and 90 days differ by $0.0038 a month in storage (section 3). Cost does not decide.
- **Privacy:** a backup keeps a person's data after it is erased on the site. A shorter retention lets that copy go sooner, and the privacy text that must be published when the backup is switched on (docs/backup.md, prerequisite 7) can say "up to 30 days". *Superseded by section 5d (inbox C4-49):* the lifecycle rule's "within 24 hours" is what is typical, not a bound, so "up to 30 days" is not what the code proves; the sentence to publish is in section 5d.
- **Recovery:** 30 daily copies are enough to notice a mistake and go back to before it within a month. Upstash's own provider backup keeps 1 or 3 days (docs/backup.md, provider research), so this is the only longer history.
- **Rule for the owner:** in the bucket `marktmorgen-backup`, an object lifecycle rule that deletes objects with prefix `backups/` **30 days** after they were created. The code had no delete then (`lib/backup-store.ts`), so this rule was the only retention. *Since section 5d the run deletes past the retention itself and this rule is a safety net.*
- **Matching review figures** (superseded by sections 5b and 5c: (30 + 3) × the set's bound): `retentionDays` 30; `maxStoredBytes` = (30 + 1) × 4,259,840 = **132,055,040 bytes**, which `validReview` accepts, because (retentionDays + 1) × objectBound ≤ maxStoredBytes holds with equality.

**Retention approved** (owner, MR; inbox C4-27, 4 November 2026): 30 days, `maxStoredBytes` 132,055,040.

**Still blocking the review:** the R2 and Upstash prices are reread with today's date (section 2). The Vercel rates keep their recorded date of 7 October 2026. The other open items in section 5 remain: the R2 billing unit's size and whether lifecycle expiry is billed, the route's duration, the `SCAN` answer size, which size Upstash bills (the `DUMP` ratios are now measured, item 6), and the missing fixed-cost line. Until they are closed, this review is not admitted and `BACKUP_COST_REVIEW` stays `null`.

## 6. Where each cost belongs

- **As built (whole database, 4 MiB cap):** company cost → LLC fixed costs, 100% Marktmorgen (FX275), minimum base. Bound: $1.92 a month linear, $7.28 a month with R2 whole-unit rounding, both with the 10% allowance.
- **R2 whole-unit rounding:** one account-wide fixed line, counted once.
- **A backup that covers 100% of every plan's rights (format in parts):** per-store variable cost → each plan's worst month, monthly and annual, with an automatic ceiling before each run (the existing `maxCommands`/`maxBytes`/`maxStoredBytes` caps, sized per store). Known lines: $0.48 / $1.53 / $4.46 a month (Store / Studio / Scale) at 30 days; $0.78 / $2.49 / $7.27 at 90 days; plus the unknown lines in section 5.

No price, visible limit, commission, flag, gate, tax reading or cost table is changed by this document. It does not certify any margin or profit: the per-plan recomputation and the minimum base belong to MR2/MR3 and FX275 (item 275).

## 5b. The figures with the R2 reading of 4 November 2026 (inbox C4-38)

The lines above that use 31 copies for a 30-day retention are taken at **32** (30 days, up to one day of lifecycle delay, the day being written), and each object written costs one Class A more when it expires:

- R2 storage, 30 days, one object a run = 32 × 4,259,840 = 136,314,880 bytes = 0.1363 GB × $0.015 = **$0.0020** (unchanged at four decimals); per store in parts, storage × 32/31 (+3.2%).
- R2 operations, one object a run = 31 × (2 × $4.50 + $0.36) / 1,000,000 = **$0.000290**; in parts, 31 × (parts + 1) × (2 × $4.50 + $0.36) / 1,000,000.
- Matching review figures (superseded by section 5c: (30 + 3)): `retentionDays` 30, `maxStoredBytes` ≥ (30 + 2) × the run's stored bound; `validReview` holds the extra day (#2219).

## 5c. The fixed-cost line in code (inbox C4-44, 4 November 2026; corrected after its independent review)

`lib/backup-cost.ts` (`backupWorstMonth(review, routeSeconds)`) prices the worst month from the caps of a review the run would accept, with the rates in `lib/spend-cost-table.ts`; `tests/backup-cost.test.ts` holds every line against figures worked out by hand. It is the `backup` line of the LLC fixed costs (`lib/llc-fixed-costs.ts`, 100% Marktmorgen under FX275), whose reviewed ceiling stays unknown, never zero, while anything in `BACKUP_COST_UNKNOWNS` is open.

What changed from sections 3 and 5b, each toward more cost:

- **32 runs a month**, not 31: a run is marked by the UTC day it starts, so one that starts just before a midnight writes after it, and a 31-day billing period that does not start at 00:00 UTC touches 32 days.
- **R2 storage:** retention + 3 sets at the daily peak (30 days + the lifecycle rule's day + the day being written + a run that wrote past its midnight = 33), each at the stored bound of a set in parts (`runStoredBound`), plus one GB-month of rounding. `validReview` (`lib/backup-run.ts`) now demands the same (retention + 3) × a set's bound of `maxStoredBytes`.
- **R2 operations:** one Class A for each object written and one more for its lifecycle deletion, one Class B for its read-back, plus one million of each class of rounding.
- **Upstash bytes:** every command the caps allow taken as a full `SCAN` page (500 names of 1,024 bytes), since `COUNT` is a hint and the shared database holds other products' keys; every copied byte as read (`maxRunBytes` counts the base64 `DUMP`s the run keeps, so the 1.7 × logical bytes measured in item 6 decides how much data fits under the cap, not what the cap lets be billed); each key's name sent twice; the marks and the report's reads. **Upstash storage:** the backup's five marks (three days' day marks, the last good copy, the last failure).
- **No free quota** is credited anywhere.

Worst month of the design as built (one part of 4 MiB, 10,000 keys, 20,202 commands, 30 days, `maxStoredBytes` 142,742,688, a 300 s route; *superseded by section 5d*):

| Line | Per month |
| --- | ---: |
| R2 storage (33 sets + 1 GB-month of rounding) | $0.0171 |
| R2 Class A (128 operations + 1 million of rounding) | $4.5006 |
| R2 Class B (64 operations + 1 million of rounding) | $0.3600 |
| Upstash commands (32 × 20,204) | $1.2931 |
| Upstash bytes (32 × 10.37 GB, almost all of it the `SCAN` pages taken as full) | $9.9540 |
| Upstash storage (5 marks) | $0.0000 |
| Vercel (32 calls of 300 s at 2 GB) | $0.3979 |
| Provider allowance, 10% | $1.6523 |
| **Total** | **$18.1749** |

A year: 12 × $18.1749 = **$218.10**. More than half is the `SCAN` reading: a cap on the pages the walk may read (for example 200, as section 3 assumed) would bring the Upstash bytes to about $0.12 and the month to about $7.36; that is a code change for a later unit, not made here (made since: section 5d).

Still open, so the line is not reviewed (`BACKUP_COST_UNKNOWNS`): the route and its maximum duration (300 s assumed); the Vercel rates of 7 October 2026; whether Vercel bills the bytes sent to R2 and Upstash; the last batch of `DUMP`s read before the cap refuses it (a key's size is not capped by the backup); the `SCAN` names of other products and names escaped in JSON; how often a day the run is called (each call refused at the day's mark is one command and one Vercel call, and nothing limits them yet); the report's two reads a day, assumed while nothing schedules it; whether Upstash and Vercel round usage up to a block as R2 does; and reading a set back to restore, priced when a restore is decided. Nothing is switched on: `BACKUP_COST_REVIEW` stays `null` until the owner approves the monthly cost.

## 5d. The run deletes its own copies, a run and one new try a day, 200 SCAN pages (inbox C4-46 and C4-49, 4 November 2026)

*The order and the ceiling below (delete first, 2 × (retention + 2) sets) are superseded by section 5e (inbox C4-53); the snapshot, the 200 pages and the day's count stand.*

What changed in the code, each with a test that failed before it (`tests/backup-run.test.ts`, `tests/backup-parts.test.ts`, `tests/backup-store.test.ts`, `tests/backup-cost.test.ts`):

- **The review is read once, as data** (`admitReview`, `lib/backup-run.ts`; Codex G on #2175): each field from the object's own data property, never through a getter, never inherited; an object that throws when read (a revoked Proxy) gives null. The run and `backupWorstMonth` use only that copy, so a review cannot pass with one figure and be priced or used with another.
- **The walk reads at most 200 `SCAN` pages** (`BACKUP_SCAN_PAGES`, `lib/backup-parts.ts`): at 500 names a page asked for, 100,000 names of the whole database, ten times the design's 10,000 keys. A walk not done by then is refused as `scan_pages` (`export_scan_pages` in the owner's report) before anything is written; a partial copy never passes as a whole one. The bytes priced are the fewer of 200 pages and what the run's commands allow.
- **The run deletes its own copies past the retention.** R2's lifecycle rule removes what expired *typically* within 24 hours, not within a bound, and bills it until it goes (Claude 1, inbox C4-49), so 33 sets was not a proved ceiling. The store now lists its own objects (`ListObjectsV2`, Class A, 1,000 names a page) and deletes by id (`DeleteObject`, free on R2). Before it writes, each run deletes every copy the bucket says was written more than `retentionDays` days before the run started; when the deletion does not complete (an error, a listing longer than `backupListPages`, or the run's cutoff), it writes nothing and the report says `prune_error`, `prune_pages` or `prune_cutoff`. **Why before, and not after, the write:** deleting first makes the ceiling a proof whatever happens (a run that dies before deleting, two calls at once, a run that crosses midnight, a new try): every copy alive was written by a run that started no earlier than `retentionDays` days and one run's length (at most 800 s) before the start of the latest run whose deletion completed, a span that touches at most `retentionDays` + 2 UTC days, with at most 2 runs each (`backupPeakSets` = 2 × (retention + 2) = **64 sets** for 30 days). Had the deletion come after the write, a run whose deletion failed would already have added a set with no ceiling proved. Going first deletes only copies past the retention, which the lifecycle rule deletes anyway, so no copy inside it is lost. The proof needs a run's writes to land within a day of its start: the deletion and the copy run under a cutoff of 800 s (`BACKUP_RUN_CUTOFF_MS`, independent review of #2175), after which no page, part or manifest is begun (`export_cutoff`); and the clocks of R2 and the function must agree within that margin. A review's retention is at least 3 days (`BACKUP_MIN_RETENTION_DAYS`): deleting first could otherwise remove the last good copy after one or two failed days, before the report says no good copy for 48 hours. The lifecycle rule stays on the bucket as a safety net.
- **At most a run and one new try a day** (`BACKUP_RUNS_PER_DAY` = 2): the day's count (`SET … NX EX` and `INCRBY`) is taken before anything costly; a run that ends well raises it past the limit; every call past it is refused at two commands, nothing listed or written. Calls refused this way still cost two commands and one Vercel call each, and nothing limits how many arrive: that stays open (`refused-calls`).

**Retention and privacy, as the code proves it:** a copy is deleted by the first run whose deletion finishes more than 30 days after the copy was written; after each such run, none of the backup's own copies (`backups/<uuid>.mmbk`) older than 30 days is left (held by the 90-day test with runs just before midnight, failures and new tries). A run whose deletion did not finish (`prune_error`, `prune_pages`, `prune_cutoff`) may leave older ones until the next run or the lifecycle rule; any other name under `backups/` is never deleted by the run, only by the lifecycle rule. With a daily schedule, a copy is gone within 30 days and the time to the next run; without runs, the lifecycle rule deletes it, typically within a day. There is no backup sentence in the privacy policy or in `lib/person-data.ts` on this branch or on main (searched 4 November 2026), so nothing public changed. The sentence proposed for prerequisite 7, when the backup is switched on: "Backups are kept for 30 days. Each daily backup deletes the copies older than that, and a storage rule deletes any it missed, usually within a day." The review's `maxStoredBytes` approved on 4 November (132,055,040) no longer passes `validReview`: the design as built needs **276,834,304** (64 × 4,325,536), to be approved again with the cost below.

Worst month of the design as built (one part of 4 MiB, 10,000 keys, 20,204 commands: 20,000 for the copy, 200 `SCAN` pages and the run's four; 30 days, `maxStoredBytes` 276,834,304, a 300 s route), `tests/backup-cost.test.ts`:

| Line | Per month |
| --- | ---: |
| R2 storage (64 sets + 1 GB-month of rounding) | $0.0192 |
| R2 Class A (64 runs × (2 objects × 2 + 1 listing page) = 320, + 64 sets × 2 objects alive at the month's start, deleted in it = 448 operations, + 1 million of rounding) | $4.5020 |
| R2 Class B (128 read-backs + 1 million of rounding) | $0.3600 |
| Upstash commands (64 × 20,204 + 32 × 2 report reads) | $2.5862 |
| Upstash bytes (64 runs × 127.7 MB: 200 `SCAN` pages, the copy, the names twice, the marks) | $0.2452 |
| Upstash storage (5 marks) | $0.0000 |
| Vercel (64 calls of 300 s at 2 GB) | $0.7958 |
| Provider allowance, 10% | $0.8508 |
| **Total** | **$9.3593** |

A year: 12 × $9.3593 = **$112.31**. Against section 5c ($18.17), the 200-page cap takes the Upstash bytes from $9.95 to $0.25; counting a new try on every day doubles the runs (32 → 64), and so the commands and the Vercel line, which is why the month is $9.36 and not about $7.30. The $4.50 of Class A is almost all the million of rounding.

Still open (`BACKUP_COST_UNKNOWNS`), none closed today: this session cannot reach developers.cloudflare.com, vercel.com or upstash.com, so no rate or date was reread. The route and its maximum duration (300 s assumed for the price; the retention proof no longer depends on it, since the run's cutoff is 800 s); the Vercel rates of 7 October 2026; whether Vercel bills the bytes sent to R2 and Upstash; the last batch of `DUMP`s read before the byte cap refuses it; the `SCAN` names of other products and names escaped in JSON (pages are now capped, their size is not); calls refused at the day's count (two commands and one Vercel call each, no cap); the report's two reads a day; whether Upstash and Vercel round up to a block; reading a set back to restore. `BACKUP_COST_REVIEW` stays `null`.

## 5e. Write first, delete after, one run at a time (inbox C4-53, 4 November 2026)

Claude 1's decision replaces "always delete first" (section 5d), so a passing failure to delete never costs the day's copy, with the ceiling still proved. What the code does now (`lib/backup-run.ts`), each with a test that failed before it (`tests/backup-run.test.ts`):

- **One run at a time:** a lock (`nl:backup:lock`, `SET … NX PX`, 15 minutes, let go when the run ends) is taken before anything else; a call that finds it is refused as `busy` at one command, without touching the day's count. Two runs at once (counts 1 and 2), a run that crosses midnight and the day's new try therefore never write side by side. The lock outlives everything a run can write: its listing, deletions and copy are under an 800 s cutoff (`BACKUP_RUN_CUTOFF_MS`), after the admission's two requests of at most 5 s each.
- **Step 1, before the write:** the run lists every object of its own (complete within `backupListPages` pages, or it writes nothing: `room_pages`). When they and one more set at its stored bound would pass the review's `maxStoredBytes`, or `backupKeptObjects` objects ((retention + 2) × (parts + 1)), it deletes the oldest first, never the last verified copy (the manifest whose id is kept with the last good copy's time, read back to find its parts), and if that deletion fails it writes nothing (`room_error`, `room_cutoff`); the day's new try may try again.
- **Step 2, after the write:** it deletes every copy of its own older than `retentionDays` days, as best it can; a failure (`prune_error`, `prune_pages`, `prune_cutoff`) goes into the owner's report and the run is still done.

**The ceiling, proved:** no other run writes while one holds the lock, R2 lists what was written, and a run writes only after its own complete listing showed room for its whole set; deletions only lower it. So the bucket never holds more than `maxStoredBytes` nor more than `backupKeptObjects` objects. `validReview` asks `maxStoredBytes` ≥ (retention + 2) sets at their bound (`backupPeakSets` = retention + 2 = **32 sets** for 30 days): with one good run a day, the copies of the last 30 days and the one about to age out are there before the day's write, so step 1 deletes nothing inside the retention; it acts only after failed runs or failed deletions. **`maxStoredBytes` for the design as built: 32 × 4,325,536 = 138,417,152 bytes** (the 132,055,040 approved on 4 November was 31 sets of the old 4,259,840 bound; it no longer passes).

**The last verified copy** is never deleted to make room (Reviewer 1's note), held by a test at the ceiling and by the 90-day simulation (runs before midnight, failures, new tries, failed deletes: never past the ceiling, the last verified copy always there). Step 2 may still delete it once it is older than the retention, as the lifecycle rule would; the 3-day minimum retention means the report has said "no good copy for 48 hours" before that.

**Retention and privacy:** after each run whose deletion finished, none of the backup's own copies is older than 30 days. A run whose deletion did not finish leaves older ones for the next run or the lifecycle rule. Other names under `backups/` are never deleted by the run. The sentence proposed in section 5d for the privacy text stands.

Worst month of the design as built (one part of 4 MiB, 10,000 keys, 20,208 commands: 20,000 for the copy, 200 `SCAN` pages and the run's eight (the lock, the day's count, the last good copy's read, the outcome); 30 days, `maxStoredBytes` 138,417,152, a 300 s route), `tests/backup-cost.test.ts`:

| Line | Per month |
| --- | ---: |
| R2 storage (the review's ceiling, 32 sets, + 1 GB-month of rounding) | $0.0171 |
| R2 Class A (64 runs × (2 objects × 2 + 2 listings) = 384, + 64 objects alive at the month's start = 448, + 1 million of rounding) | $4.5020 |
| R2 Class B (64 runs × (2 read-backs + 1 manifest read) = 192, + 1 million of rounding) | $0.3601 |
| Upstash commands (64 × 20,208 + 32 × 2 report reads) | $2.5868 |
| Upstash bytes (64 runs × 127.7 MB) | $0.2452 |
| Upstash storage (6 marks) | $0.0000 |
| Vercel (64 calls of 300 s at 2 GB) | $0.7958 |
| Provider allowance, 10% | $0.8507 |
| **Total** | **$9.3576** |

A year: 12 × $9.3576 = **$112.29**. Calls refused at the lock cost one command, at the day's count four, each one Vercel call, with no cap on how many arrive: still open (`refused-calls`), with the other items of section 5d. `BACKUP_COST_REVIEW` stays `null`.

