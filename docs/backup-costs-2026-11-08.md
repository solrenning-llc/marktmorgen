# Backup costs, sources and open items — 273 [BK1] (8 November 2026)

Status: **research and proposal only. The backup stays off; only the owner approves its cost.** `BACKUP_COST_REVIEW` in `lib/backup-run.ts` stays `null`; nothing here creates an account, bucket, key, variable, lifecycle rule, bucket lock, Worker, cron entry or route, and no provider was contacted. No constant in the code is changed by this document: where a value is proposed, it is proposed here for the agent writing the backup code (inbox C1-20261108-1353-C4-33 to C1-20261108-2021-C4-37), never written into `lib/backup-cost.ts` or `lib/spend-cost-table.ts` by this unit. Under the MR rule an unknown cost fails and is never zero, and no supplier's free quota is counted.

Code read: `origin/main` at `88dedad3b` (8 November 2026): `lib/backup-cost.ts`, `lib/backup-run.ts` (constants), `lib/backup-export.ts`, `lib/backup-parts.ts`, `lib/spend-cost-table.ts`, `lib/storage-quota.ts`, `lib/storage-rules.ts`, `lib/upload-budget.ts`, `lib/upload-budget-policy.ts`, `lib/assignment-rules.ts`, `lib/community-picture-rules.ts`, `lib/video-admission-rules.ts`, `lib/redis.ts`, `vercel.json`, `app/privacy/page.tsx`, `docs/backup.md`, `docs/backup-cost-2026-11-04.md`, `docs/incident-response.md`, AGENTS.md (HZ1–HZ3).

## 1. What this session could read today

| Host | Result on 8 November 2026 (20:27 UTC) |
| --- | --- |
| upstash.com (pricing page and documentation) | **read** |
| vercel.com (pricing documentation and changelog) | **read** |
| developers.cloudflare.com (R2 pricing, bucket locks, error codes, lifecycles; Workers pricing, limits, Cron Triggers) | **read** (20:59 UTC, after the network allowed the host; blocked at 20:27) |
| bunny.net, docs.bunny.net (pricing pages; Stream pricing, encoding, storage structure, Stream API) | **read** (20:59 UTC; docs.bunny.net redirects to bunny.net/docs) |

Every Cloudflare and bunny figure below was read today on the page named beside it. No price is invented: what no page states stays unknown.

## 2. Official sources read today

| Source (URL) | Page date | What it says, as used here |
| --- | --- | --- |
| https://upstash.com/docs/redis/overall/billing | undated (read 2026-11-08) | Pay-As-You-Go: commands $0.20 per 100K; storage $0.25 a GB a month (first GB free, not credited here); bandwidth free up to 200 GB a month, then $0.03 a GB (free part not credited); max data size 100 GB; max request size 10 MB; **max record size 100 MB**. EVAL/EVALSHA billed as one command plus one per `redis.call`; MULTI and EXEC billed, a transaction of N commands is N + 2; AUTH, HELLO, RESET, PING, SELECT, QUIT, INFO, CONFIG and COMMAND not billed. "Billed per request"; the page says nothing about rounding usage up to a block. Prod Pack $200 a month per database. |
| https://upstash.com/pricing/redis | undated (read 2026-11-08) | Same PAYG figures ($0.20 per 100K commands; $0.25 a GB, first GB free; bandwidth free to 200 GB, then $0.03 a GB; 100 GB; 10 MB request; 100 MB record). |
| https://upstash.com/docs/redis/features/backup | undated (read 2026-11-08) | Backups tab: "Backup & Export" makes one now; the **Daily Backup** switch turns on a daily backup, kept **1 or 3 days**. Restore from any backup of the account or team. Warning, verbatim: "All existing data in the target database will be deleted before the restore operation begins." |
| https://upstash.com/docs/redis/help/production-checklist | undated (read 2026-11-08) | "Enable Daily Backups": "Available on all paid plans"; "Backup retention up to 3 days with Prod Pack"; "Hourly backups with customizable retention (Enterprise)". |
| https://upstash.com/docs/redis/overall/enterprise | undated (read 2026-11-08) | Prod Pack turns daily backups on; "The latest daily backup is included in Prod Pack at no extra charge; keeping the last 3 days bills the two older backups as usual." Daily backups turned on before Prod Pack keep their own setting. |
| https://vercel.com/docs/functions/usage-and-pricing | `last_updated: 2026-06-16` (read 2026-11-08) | Fluid compute on Pro: Active CPU and Provisioned Memory billed on demand, by region; invocations "$0.60 per million". Regional table: `iad1`, `cle1`, `pdx1` $0.128 a CPU-hour and $0.0106 a GB-hour (the repository's figures); **highest: `gru1` $0.221 a CPU-hour and $0.0183 a GB-hour**. Memory is billed while waiting on I/O; CPU is not. |
| https://vercel.com/changelog/function-invocations-now-billed-per-unit | published 2026-05-29 (read 2026-11-08) | Pro invocations billed **per unit**, $0.0000006 each (previously $0.60 per 1M as a package). |
| https://vercel.com/docs/functions/limitations | read 2026-11-08 | Pro maximum duration 300 s default, **800 s maximum** (1,800 s extended, beta); 4 GB maximum memory on Pro; functions run in `iad1` by default, the region can be changed in the project's settings. |
| https://vercel.com/docs/manage-cdn-usage and https://vercel.com/docs/pricing/regional-pricing | read 2026-11-08 | Fast Origin Transfer is the function's own HTTP request (in) and response (out); priced "1 GB for $0.06 – $0.43" by region. Private Data Transfer ($0.15 – $0.31 a GB) applies with Static IPs. Neither page lists a charge for a function's outbound requests to other services. |

Cloudflare and bunny, read today (8 November 2026, 20:59 UTC):

| Source (URL) | Page date | What it says, as used here | Against the earlier record |
| --- | --- | --- | --- |
| https://developers.cloudflare.com/r2/pricing/ | "Last updated Oct 30, 2026" | Standard storage **$0.015 / GB-month**; Class A **$4.50 / million**; Class B **$0.36 / million**; egress **free**; buckets: first 100,000 included, then $0.10 a bucket a month. GB-month = "averaging the *peak* storage per day over a billing period (30 days)". "Cloudflare rounds up your usage to the next billing unit" (1,000,001 operations bill as 2 million; 1.1 GB-month as 2). Free tier (10 GB-month, 1 million Class A, 10 million Class B a month): **not credited here** (MR rule). Class A includes `ListObjects`, `PutObject`, `CopyObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `ListParts`, `PutBucketLifecycleConfiguration`; Class B includes `HeadObject`, `GetObject`; free: `DeleteObject`, `DeleteBucket`, `AbortMultipartUpload`. A request refused at authentication (401, 403) is not billed; a `PutObject` answered 412 or 400 `BadDigest` is billed as Class A. | **Same values** as Claude 1's reading of 2026-11-04 (`lib/spend-cost-table.ts`, docs/backup-cost-2026-11-04.md §2): nothing to recompute. |
| https://developers.cloudflare.com/r2/buckets/object-lifecycles/ | "Last updated Oct 26, 2026" | Objects "typically removed from a bucket within 24 hours" of their expiry; "An object is no longer billable once it has been deleted." Whether the lifecycle deletion itself is billed is still not said. | Same as recorded; the deletion stays priced as one Class A (docs/backup-cost-2026-11-04.md §5 item 2). |
| https://developers.cloudflare.com/r2/buckets/bucket-locks/ and https://developers.cloudflare.com/r2/api/error-codes/ | "Last updated Oct 28, 2026" (locks) | Section 4a below: the exact 409 answer. A lock rule (by prefix; an age, a date or indefinite; up to 1,000 rules) blocks overwrites, deletes, completing uploads started earlier and **removal by lifecycle rules**; it does not block new objects. No charge for a lock rule is listed (the owner sets it once in the dashboard; at most one operation, inside the rounding million already counted). | New: never read here before (the 409 came from inbox C4-36). |
| https://developers.cloudflare.com/workers/platform/pricing/ | "Last updated Oct 2, 2026" | Workers Paid: **minimum $5 a month an account**; Standard model: requests **$0.30 per additional million** (10 million included), CPU time **$0.02 per additional million CPU ms** (30 million included), **no charge for duration**; "Cloudflare does not bill for subrequests"; no egress charge. Included amounts **not credited here**. Workers Logs: 20 million events included, then $0.60 a million, and "Beginning December 1, 2026, Workers Logs will use Cloudflare Observability pricing" (that page not read: **unknown**). The page states no rounding for Workers requests or CPU (only for Durable Objects): one block of each is added, as for R2. | New: never read here before (C4-37 said "US$ 5" without a source; the $5 is now sourced). |
| https://developers.cloudflare.com/workers/platform/limits/ | "Last updated Oct 29, 2026" | Paid: CPU time per Cron Trigger **30 s for an interval under 1 hour, 15 min for an interval of 1 hour or more**; Cron Trigger **wall time 15 min**; memory **128 MB** an isolate; subrequests **10,000 an invocation** by default (up to 10 million); 6 simultaneous outgoing connections; **250 Cron Triggers an account**. Waiting on `fetch()` does not count as CPU time. | New. |
| https://developers.cloudflare.com/workers/configuration/cron-triggers/ and https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ | "Last updated Oct 17, 2026" | Crons run on UTC; changes take up to 15 minutes to propagate; a scheduled handler can call `controller.noRetry()`. **How many times a failed cron is retried is not stated** (unknown), so the proposal below calls `noRetry()` on every outcome and the run count stays the schedule's. | New. |
| https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ | "Last updated Nov 4, 2026" | A `put()` of a `ReadableStream` needs a known length (`FixedLengthStream`), otherwise it throws. **What the Workers binding returns for a locked object is not stated** (the 409 above is written for the S3 API). | New. |
| https://bunny.net/pricing/ and https://bunny.net/docs/stream/pricing.md | undated (read 2026-11-08) | CDN and Stream delivery, Standard network: Europe & North America **$0.010**, South America **$0.045**, Asia & Oceania **$0.030**, **Middle East & Africa $0.060 a GB** (dearest); Volume network $0.005 a GB to 500 TB. Stream storage $0.01 a GB (Frankfurt), +$0.01 for a 2nd region, +$0.005 from the 3rd; $1 monthly minimum. "Storage is billed on what a video generates during encoding [...] **Keep original files** [...] add more on top". | **Same** as the 2026-10-18 record ($0.060 dearest Standard region): the Bunny egress lines do not move. |
| https://bunny.net/pricing/storage/ | undated (read 2026-11-08) | Bunny Storage (storage zones, not Stream libraries): Standard HDD $0.01 a GB a region; "Free API egress", "No API fees". Not used here: the videos are in a Stream library, read through its pull zone (`https://{pull_zone}.b-cdn.net/{video_id}/original`, https://bunny.net/docs/stream/storage-structure.md), which is CDN delivery. | New. |
| https://bunny.net/docs/stream/encoding.md, https://bunny.net/docs/api-reference/stream/manage-videos/get-video.md and .../get-video-storage-size-info.md | undated (read 2026-11-08) | Section 5b: `storageSize` and the originals. | New. |
| https://vercel.com/docs/vercel-blob/usage-and-pricing and https://vercel.com/docs/pricing/regional-pricing | `last_updated: 2026-09-23` (read 2026-11-08) | Blob: storage $0.023 – $0.041 a GB-month; Simple Operations (a read on cache miss, a metadata read) $0.35 – $0.56 a million; Advanced Operations (upload, copy, **list**) $4.50 – $7.00 a million; Blob Data Transfer $0.05 – **$0.117 a GB**; plus Fast Origin Transfer on every cache miss (up to $0.43 a GB, section 2 above) and a CDN Request per access (rate not read). Delete is free. | New: bounds the Blob fallback files of section 5b per GB; how many bytes Blob holds is still not known. |

## 3. The nine items of `BACKUP_COST_UNKNOWNS`

The coordinator's brief says eight; the constant in `lib/backup-cost.ts` on `88dedad3b` holds **nine**. Each one below: what was found, the value proposed for the code agent (if any), and whether it can be taken off the list.

| # | Item | Finding (source, date) | Proposed value for the code agent | State |
| --- | --- | --- | --- | --- |
| 1 | `vercel-route` | No route yet on main (`vercel.json` has no backup entry; no file in `app/` imports `lib/backup-run`). Vercel Pro's maximum is 800 s (limitations page, read 2026-11-08). C4-36 asks for `BACKUP_RUN_CUTOFF_MS` near 700 s and an explicit `maxDuration`. | Price the route at **800 s** (the plan's maximum), whatever `maxDuration` the route sets below it, so a later change of `maxDuration` up to the maximum cannot raise the bill past the review. | **Still open**: it closes only when the route exists on main with its `maxDuration` (code agent). |
| 2 | `vercel-rates` | Reread 2026-11-08 (page `last_updated` 2026-06-16): `iad1` $0.128 CPU-hour, $0.0106 GB-hour, $0.60 per million invocations, the repository's figures. The repository does not pin a region and the live region is not verified (docs/cx55-platform-subscription-search-cost.md); the dearest region is `gru1`, $0.221 and $0.0183. | Price the backup route at **$0.221 a CPU-hour and $0.0183 a GB-hour** (dearest region) and $0.0000006 an invocation, unless the route pins `iad1` in code and a test holds it. | **Closed with source and date** (rates read today); the region choice is a proposal. |
| 3 | `vercel-transfer` | Fast Origin Transfer counts only the function's own HTTP request and response; no Vercel page read today bills a function's outbound calls to R2 or Upstash (Private Data Transfer is for Static IPs, which the project does not use: no code path names them). "Not listed" is not proof of "not billed". | Ceiling, not a rate: price **every byte the function moves** (Upstash answers, the R2 write and the read-back) at **$0.43 a GB**, the dearest Fast Origin Transfer rate. | **Bounded by a ceiling with source**; the code agent may take it off the list once the line exists in `backupWorstMonth`. |
| 4 | `upstash-overshoot` | Upstash's maximum record size is **100 MB** on PAYG (billing page, read 2026-11-08), so one key's `DUMP` is at most about 100 MB (133.3 MB as base64). The export sends `DUMP`s in batches of up to 500 keys (`lib/backup-parts.ts`), so the batch read before the byte cap refuses can be up to 500 × 133.3 MB = **66.7 GB a run** ($2.00 of Upstash bandwidth and $28.67 of the transfer ceiling of item 3, each run). | Read `DUMP`s **one key per request** (batch 1): the overshoot is then at most one key, 133.3 MB a run, priced below. A later unit may check a key's size before its `DUMP` instead. | **Bounded with an official source**, but the bound is only useful once the batch is lowered (code agent). |
| 5 | `scan-names` | No Upstash page read today states a maximum answer size for `SCAN` (only a 10 MB maximum *request*). The database is shared with the Hazelsong project (section 7), whose key names the code does not cap. | None from a source. Options for the owner and the code agent: read each `SCAN` answer under a byte cap and refuse past it (the bytes already read are still billed, so the bound is one page plus the cap), or give Marktmorgen its own database. | **Still unknown**: no official figure bounds one page. |
| 6 | `refused-calls` | Depends on the route (item 1). With `CRON_SECRET` checked by `lib/request-guard.ts` before any database command (C4-36), an unauthenticated call costs one Vercel invocation and no Upstash command; authenticated calls are the crons' (C4-36 asks for two a day, matching `BACKUP_RUNS_PER_DAY` = 2). | Authenticated calls = the scheduled ones (2 a day, 64 a month, already priced); unauthenticated calls refused at **zero database commands**, their invocation counted with the site's ordinary traffic, not the backup. Needs a test that a call without the secret sends no command. | **Still open** until the route and that test are on main. |
| 7 | `report-reads` | Nothing schedules the report on main. | Two reads a day, as assumed; closes when the report's schedule exists. | **Still open** (code agent). |
| 8 | `billing-units` | Upstash: "billed per request", no rounding stated (billing page, 2026-11-08). Vercel: invocations per unit since 2026-05-29 (changelog); CPU measured in milliseconds; no rounding stated. Silence is not a statement of "no rounding". | Add **one block of each** to the worst month, as R2 does: +100,000 Upstash commands ($0.20), +1 GB of bandwidth ($0.03), +1 GB of storage ($0.25), +1 CPU-hour ($0.221) and +1 GB-hour ($0.0183) on Vercel. | **Bounded by a ceiling**; can leave the list once the code prices it. |
| 9 | `restore-reads` | Reading a set back costs one R2 Class B per object (parts + 1) at $0.36 a million and no egress (R2 pricing page, reread 2026-11-08, same values as Claude 1's reading of 2026-11-04). The monthly restore test (C4-35) reads the verified set in memory only. Where that test runs (a machine of the owner's, a CI runner) is not decided, and a CI runner's minutes are not priced here. | Per test, at most `maxParts + 1` Class B operations, inside the million of Class B rounding already counted below. | **Partly closed**: the R2 part is priced; the runner is open until the owner decides where the test runs. |

So, of nine: **2 closed or bounded with a source today (2, 4), 3 bounded by a proposed ceiling (3, 8, and 9 for its R2 part), 4 still open (1, 5, 6, 7)**, three of them waiting only for the route and the report's schedule, which are the code agent's.

## 4. Does the production database already have a provider backup? (Upstash)

From the official pages read on 8 November 2026 (section 2):

- Upstash offers a **daily backup** on every paid plan (Pay-As-You-Go included). It is **a switch the owner turns on** in the database's Backups tab; nothing in the pages says it is on by default on Pay-As-You-Go. It keeps **1 or 3 days**.
- With **Prod Pack** ($200 a month per database) daily backups are turned on automatically, the latest one at no extra charge, the two older ones billed "as usual". The price of a kept backup on Pay-As-You-Go is not on any page read today: **unknown, not zero**.
- Hourly backups with chosen retention are for Enterprise only.
- **Whether the production database has the switch on cannot be seen from here**: no agent enters the Upstash account. The owner can check the Backups tab and say which (on or off, 1 or 3 days).
- These backups live in the same Upstash account: they do not protect against losing the account, and a restore through the console **deletes the target database's data first** (official warning above). Never restore over the live database.

## 4a. The bucket lock: what R2 answers (official pages, 8 November 2026)

From https://developers.cloudflare.com/r2/buckets/bucket-locks/ ("Notes") and https://developers.cloudflare.com/r2/api/error-codes/ (code 10069), verbatim where quoted:

- **Delete of a locked object, single-object S3 request (`DeleteObject`)**: "fails with HTTP `409` and the `ObjectLockedByBucketPolicy` error code" (error code **10069**, "Object is protected by a bucket lock rule and cannot be modified or deleted"). The existing object is not modified. This **matches** what #3273 (`claude4/bk1-cron-lock`, `lib/backup-store.ts` `delete`) assumes: a 409 throws `BackupObjectLockedError` and is never a done delete. The error-codes page lists no other 409 for an object delete (`BucketNotEmpty` and `BucketConflict` are bucket operations), so reading any 409 there as the lock is consistent with the page; checking the `ObjectLockedByBucketPolicy` code in the body would be a stricter reading, not a correction.
- **Multi-object delete (`DeleteObjects`)**: "R2 returns HTTP `200` and reports `ObjectLockedByBucketPolicy` for each locked key in the response body". #3273 does not use it; if a later unit switches to it, a 200 must never be read as "all deleted".
- **Write onto a locked name, including a create-only `PutObject` with `If-None-Match: *`**: "The lock check runs before conditions on the object being written, such as `If-None-Match` or `If-Match`, so a write that fails both checks returns `ObjectLockedByBucketPolicy`, not `PreconditionFailed` (`412`)." **This differs from what #3273 says**: `lib/backup-store.ts` (`putNew`, and its header comment "the other is answered 412") expects 412 for a name that already exists; under the lock, a name that exists and is locked answers **409**. #3273's code still throws on it (any status other than 200 or 412 is "Backup write failed"), so nothing is taken as written; only the message and the comment are wrong for that case. Names are random ids, so it needs a collision or a retried write. Not changed by this unit (it belongs to #3273).
- **Lifecycle and lock**: "Bucket lock rules take precedence over lifecycle rules": a locked object is not removed by the lifecycle rule until its lock ends. A bucket cannot be emptied while any lock rule is configured.
- **Billing of a refused request**: a `DeleteObject` is free; whether a `PutObject` refused with 409 is billed is not said (the FAQ bills a 412 and a 400 `BadDigest` as Class A): it is taken as one Class A, inside the rounding million already counted.
- **The Worker (files and videos)** would write through the Workers binding, for which the pages read today do not state the lock's answer: **unknown** until read; the Worker must treat any error from a delete or a write as not done.

## 5. The design priced (inbox C4-37)

- A **separate Cloudflare account** for backups only, created by the owner; agents never enter it. Three buckets: `marktmorgen-backup` (database), `marktmorgen-files-backup` (files), `marktmorgen-videos-backup` (videos).
- **Database:** the existing Vercel route (`lib/backup-run.ts`), daily copies kept 30 days, plus 3 monthly copies (90 days) under their own prefix (C4-36 item 1), the bucket's rule as a safety net (+30 days); no copy past 120 days.
- **Files and videos:** a Cloudflare Worker in the backup account with a daily cron, reading the sources with read-only keys (R2 of the production account and Vercel Blob; Bunny Stream's library read key), copying only what is new or changed (key + etag), create-only; anything deleted at the source is deleted from the copy after 30 days; a 7-day bucket lock. Videos are never routed through Vercel.

### 5a. Worst month and year: the company line (fixed cost, 100% Marktmorgen, FX275)

The database copy, as built plus the proposals of section 3 (one part of 4 MiB, 10,000 keys, 20,210 commands a run, 64 runs a month (two a day on 32 UTC days), 800 s a run at `gru1` rates, `DUMP` batch 1, 3 monthly copies added to the stored ceiling). R2, Upstash and Vercel rates read today (the R2 values did not change since 2026-11-04, so the database lines below are as before).

| Line | Per month | How |
| --- | ---: | --- |
| R2 storage | $0.0173 | (138,417,152 + 3 × 4,325,536 bytes) + 1 GB-month of rounding, at $0.015 |
| R2 Class A | $4.5021 | as docs/backup-cost-2026-11-04.md §5e (448 operations + 1 million of rounding) + the monthly copies' 12 |
| R2 Class B | $0.3615 | as §5e (4,224 reads + 1 million of rounding) |
| Upstash commands | $2.7870 | 64 × 20,210 + 32 × 2 report reads, at $2.00 a million, + one 100K block |
| Upstash bandwidth | $0.5312 | 64 × (127,720,448 bytes + 133,333,333 bytes of one oversized key) at $0.03 a GB, + 1 GB |
| Upstash storage | $0.2500 | the six marks, under 1 KB, rounded up to one GB (item 8) |
| Vercel compute | $3.9030 | 64 × (2 GB × 800 s at $0.0183 + 800 s of CPU at $0.221 + $0.0000006), + 1 CPU-hour + 1 GB-hour |
| Vercel transfer (ceiling, item 3) | $7.4223 | 17.26 GB a month (every byte above, plus the write and the read-back) at $0.43 |
| Provider allowance, 10% (`PROVIDER_CHARGES_BPS`) | $1.9774 | |
| **Total, database copy** | **$21.7517 a month** | **$261.02 a year** (12 worst months) |

With the code's current batch of up to 500 keys the same month would carry up to $128.00 of Upstash bandwidth and $1,834.67 of the transfer ceiling more: that is why item 4 proposes batch 1.

**The files-and-videos Worker (Cloudflare Workers Paid, read today).** Its cost does not grow with the bytes it moves, only with how often it runs: duration is not billed, subrequests are not billed, R2 egress is free, and the CPU of one cron run is capped by Cloudflare itself at 15 minutes (the limit for an interval of 1 hour or more, and the run's wall time). So the ceiling is the schedule. Proposed: **one hourly cron** (one "lane"), `controller.noRetry()` on every outcome (the retry count is not stated, section 2), Workers Logs **off** (its price from 1 December 2026 is not read), and none of the included amounts credited:

| Line | Per month | How |
| --- | ---: | --- |
| Workers Paid plan | $5.0000 | the account's minimum charge |
| Requests | $0.3000 | 24 × 32 = 768 cron runs, inside one million at $0.30 (one block; no rounding rule stated, so a whole block) |
| CPU time | $13.8440 | 768 × 900,000 ms = 691.2 million CPU ms at $0.02 a million, + one million of rounding |
| Provider allowance, 10% | $1.9144 | |
| **Total, Worker (one lane)** | **$21.0584 a month** | **$252.70 a year** |

Each further lane (another hourly cron, if one does not copy every store in time) adds 768 × 900,000 ms more: **$15.21 a month** with the allowance. How many bytes one lane copies in its 15 minutes is **not on any page** (it depends on the speed of the sources and of R2): the number of lanes a given number of stores needs is unknown until it is measured in the owner's account. The Worker never buffers a file (128 MB of memory): it streams each one with a known length (`FixedLengthStream`), uses multipart above 5 GiB, stays under 10,000 subrequests a run, and alarms when the copy falls behind instead of claiming it is done.

**Company line, both parts: $42.8101 a month, $513.72 a year** (database copy $21.7517 + one Worker lane $21.0584).

Still outside this total, and **each one keeps the line unapproved**: the number of Worker lanes (throughput not stated); Workers Logs from 1 December 2026, if turned on; the lock's answer through the Workers binding (section 4a); the `SCAN` page size (item 5); the restore test's runner (item 9). In a separate Cloudflare account, the minimum billing unit of each R2 class (the "+1 million" and "+1 GB-month" above) falls entirely on the backup; it is counted **once**, here, and not again in the per-plan lines.

### 5b. Worst month and year per plan (files and videos, variable cost of each plan)

Per store at 100% of its plan, from the code's own limits: the plan's storage (`PAID_STORAGE_BYTES`: 5, 40, 80 GiB, which `storageUsed` measures as files plus Bunny Stream's `storageSize`), its students' room (`TASK_ROOM_BYTES`: 250 MiB, 1 GiB, 2 GiB) and its community pictures (`COMMUNITY_PICTURES` × 1 MB: 200, 1,000, 3,000).

- **Peak bytes in the copy = 3 × what the store may keep**: what is live, plus what was deleted in the last 30 days (kept that long). A store's new uploads are capped at its whole storage a month (`AUTOMATIC_UPLOAD_CAPS`, `lib/upload-budget-policy.ts`), and 30 days can touch two of its months, so at most twice its room was deleted and is still kept. *Assumption to verify:* the students' room and the community pictures are taken as churning no faster than that; no monthly byte cap for them was found.
- **R2 operations**: the source and the copy listed once a day each, at most 10 pages of 1,000 names a store (proposed cap: the Worker refuses and alarms past it); up to 10,000 objects written a month, 3 Class A each (create, one part, complete), plus one Class A per 5 MiB part; one Class B per object and part read from the source.
- **Bunny egress**: every video byte the store may keep downloaded once a month through the library's pull zone, at $0.060 a GB (dearest Standard region, Middle East & Africa, reread 2026-11-08 on https://bunny.net/docs/stream/pricing.md: unchanged). A Cloudflare cron runs wherever Cloudflare places it, so the dearest region is used. Today direct uploads to Bunny are closed (`reserveStoreUpload` accepts only R2), so after the first copy a month should move little; the worst month still counts all of it.

| Plan | Copy peak | R2 storage | R2 Class A | R2 Class B | Bunny egress | **Per month, + 10%** | **Per year** | One month after the plan ends |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Store ($69) | 17.49 GB | $0.2624 | $0.1429 | $0.0040 | $0.3221 | **$0.8045** | **$9.65** | $0.0962 |
| Studio ($449) | 135.07 GB | $2.0261 | $0.1765 | $0.0067 | $2.5770 | **$5.2649** | **$63.18** | $0.7429 |
| Scale ($999) | 273.14 GB | $4.0971 | $0.2160 | $0.0099 | $5.1540 | **$10.4246** | **$125.10** | $1.5023 |

The monthly and annual intervals have the same worst month; the year is 12 of them. The last column is the copy kept 30 days after a closed store's files are deleted: it belongs to the after-the-end cost each plan already carries. These lines go into each plan's worst month (`tests/plan-cost-registry.ts`), with the Worker's own automatic ceiling before each copy; whether each plan still clears the MR rule with them is MR2/MR3's to compute, not this document's.

None of the rates read today changed the table: R2 and Bunny are as before, and the Worker is a company line (5a), not a per-store one.

**Bunny's `storageSize` and "Keep original files" (read 2026-11-08).** The Get Video API describes `storageSize` as "Total storage used by this video, in bytes" (https://bunny.net/docs/api-reference/stream/manage-videos/get-video.md). The encoding page's per-video storage breakdown lists "Codec", "MP4 (MP4 fallback)", "**Original (Keep original files)**", "Other" and "Total" (https://bunny.net/docs/stream/encoding.md#video-storage-usage), and the Stream pricing page says keeping originals adds to the storage billed. So the reading of the pages is that the total includes the original when it is kept; but **no page says in words that the `storageSize` field equals that breakdown's total**. The storage-size endpoint (`GET /library/{libraryId}/videos/{videoId}/storage`, https://bunny.net/docs/api-reference/stream/manage-videos/get-video-storage-size-info.md) returns the parts separately, `originals` among them. Proposal for the code agent, not done here: where `storageUsed` counts a video, take the larger of `storageSize` and the sum of the storage endpoint's parts, so an original outside `storageSize` could never be uncounted; until then the per-plan bound rests on that reading. An original is kept only when the option was on before the upload; its cost on Bunny is the library's storage rate, $0.01 a GB a region (more with replication), a production cost of the plan's storage, not of the backup. The backup copies the original when it exists (one file a video), never every rendition.

**Still unknown for the per-plan lines, so they are not approvable yet:** whether `storageSize` includes the original in every case (above); the Vercel Blob fallback files (`lib/blob.ts`): a GB read from Blob by the Worker costs up to $0.117 of Blob Data Transfer plus up to $0.43 of Fast Origin Transfer on a cache miss, a read $0.56 a million, a list $7.00 a million (read today), plus a CDN Request whose rate was not read, against $0 of R2 egress, and how many bytes Blob holds is not known (C4-37 asks for that inventory); product and email pictures (`PICTURE_R2_CEILING` is `null`, and no per-plan count of email pictures was found), which may sit outside the store's measured folder.

### 5c. What to bring to the owner

| | Per month | Per year |
| --- | ---: | ---: |
| Company line: database copy | $21.75 | $261.02 |
| Company line: files-and-videos Worker, one lane | $21.06 | $252.70 |
| **Company line, total** | **$42.81** | **$513.72** |
| + each further Worker lane, if needed | $15.21 | $182.48 |
| + per store on Store / Studio / Scale | $0.80 / $5.26 / $10.42 | $9.65 / $63.18 / $125.10 |

None of this is a total the owner can approve yet: the unknowns listed above fail it (the number of Worker lanes above all), and the lowest-cost settings proposed (batch 1, 800 s priced, the transfer ceiling, the Worker's hourly schedule with `noRetry()` and logs off) are code that does not exist. Only the owner approves the cost; nobody fills `BACKUP_COST_REVIEW` before that.

## 6. Hazelsong and the shared database

- The repository says so in the owner's own decision: AGENTS.md, "Hazelsong guardada sem dividir custos" (24/10/2026, 14h58; HZ1–HZ3) lists "chaves no Upstash compartilhado" among Hazelsong's residual costs paid by the LLC, and the queue (item 337 [HZ2]) repeats "chaves dela no Upstash compartilhado". Claude 1 reports that Vercel shows the database linked to two projects (C4-34). So, **as the repository records it, Hazelsong uses the same Upstash database**. Not verified from this session: no account access, and Hazelsong's code is not in this repository, so its key prefix is not known here.
- Consequences: the backup copies only `nl:` keys (`BACKUP_PREFIX`, `lib/backup-export.ts`), so Hazelsong's keys are **not** in Marktmorgen's backup unless they also start with `nl:` (not verified); `SCAN` walks Hazelsong's names too (item 5); a restore of the **whole database** from Upstash's console brings both products back to the same moment and deletes whatever either wrote since; restoring Marktmorgen into a **new** database and pointing only Marktmorgen's variables at it leaves Hazelsong untouched on the old one. Hazelsong is kept, never deleted (HZ1).

## 7. Draft privacy text (not published)

C4-37 item 5: published only together with the cron turned on (VR: no promise of what does not run). Until then it lives **only in this document**; `app/privacy/page.tsx` is not changed by this unit. When the backup is switched on, the code agent puts it in a "Backups" section with every number read from the code's constants and a test that fails if they differ, and adds the backups to the Cloudflare line of the providers' list (today that line names only the sold files' store, and only when it is configured).

> **Backups**
>
> We keep backup copies so that we can bring the service back if something goes wrong. We copy our database, the files creators upload (files they sell, stamped PDFs, product pictures, community pictures, students' hand-ins and pictures in emails) and lesson videos. The copies are kept by Cloudflare (Cloudflare R2), in an account used only for backups. The database copy is encrypted before it leaves our servers.
>
> How long copies are kept:
> - daily database copies: 30 days;
> - monthly database copies: 3 months (90 days);
> - a file or video deleted from the site: removed from the copies 30 days later;
> - our database provider's own copy: 1 day;
> - no copy is kept longer than 120 days.
>
> When you ask us to delete your data, we delete it from the live service right away. Copies that already hold it are not changed; they expire on the schedule above, at the latest after 120 days. If we ever restore from a copy, we apply every deletion request made since that copy before the site comes back, so deleted data does not return.

Numbers to read from constants when it is published: 30 (daily retention), 3 and 90 (monthly copies), 30 (deleted files), 1 (Upstash, only if the owner confirms the switch and its setting, section 4), 120 (cap). The "1 day" line must not be published unless the owner confirms that setting.

## 8. Limits of this document

Research and proposal, not a review: no figure here is admitted, no constant changed, no gate or flag touched. No price, limit, commission, flag or gate is changed. Not verified: the live Vercel region, the Upstash plan and backup switch, Hazelsong's key prefix, anything in the Cloudflare or Bunny accounts, and how fast a Worker copies in practice. Official pages describe a service; they do not prove what an account was billed.
