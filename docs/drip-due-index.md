# Drip emails: an index of the pairs that fall due (design, unit 0)

Status: design only, for the coordinator's review before any code (15 November 2026, Claude 4 cloud V). Nothing here is built.

## Why

The daily drip walk (`lib/learn.ts`, `sendDripEmails`) reads every course in the drip set, every day, with all its students, to find the few student-and-module pairs whose module opened in the last three days. Its cost follows the courses and the students, not the emails:

- Each course costs at least 2 commands per run (its blocked students and its first page of students), even with batched outlines and listings (`claude4/keep/drip-run-ceiling` @ `0703841bd`).
- No plan limits products below `MAX_PRODUCTS` (2,000), so a Store can have 2,000 drip courses: 2 × 2,000 × 32 runs is about $0.26 a month.
- A refunded Store first year is about $64.98 on main without the walk priced, against its reviewed $65 exposure ceiling (`read-ceilings`, `email-logo-region`). With the walk priced at today's design it is $65.29. So main already exceeds that ceiling in reality; the line only makes it visible.

An index lets the run touch only what falls due, so its cost follows the store's email figure and the refusals ceiling. That fits under the ceiling without changing it, any price or any limit.

## The index

One sorted set per store, `nl:drip:due:<statsId>`:

- **Member:** `<courseId>|<emailKey>|<moduleId>` (32 + 1 + 32 + 1 + 12 characters, no address in clear).
- **Score:** when the pair falls due, `opensAt(course, module, start)` in seconds (`lib/course.ts`).

A set of the stores that have one, `nl:drip:stores` (the walk's only global read), replaces `nl:courses:drip` once the backfill below is done.

## When it is written, changed and removed

| Event | What the index does | Cost, priced where |
| --- | --- | --- |
| A student's row is first written (`touchStudent`) | One `ZADD` of every module with `dripDays > 0`, in the same call as the row. Its bytes are taken from the data room with the row (`takeData`, same slot), so a full room writes neither. | 1 command, inside the course page's request (public-requests) |
| The start moves earlier (`touchStudent`, `s = min(...)`) | The same `ZADD` with the new scores (`ZADD` overwrites a member's score) | the same |
| The course's schedule changes (`registerDrip`: module added, removed or `dripDays` changed, `startsAt` set or moved) | The course's entries are rebuilt from its students: `HSCAN` pages of 200 and one `ZADD` per page, after a `ZREM` of the old members, under the course's lock. A module removed leaves stale members; the run drops them when it reads them (see below). | studio action, bounded by the data room (priced in the studio line, checked in the RED) |
| A student blocked | Nothing; the run checks `SISMEMBER blocked` for each pair it is about to claim. | run |
| A person deleted (`forgetLearnerPerson`) | One `ZREM` of every member of theirs (course × module, known from `courses`), in the same pipeline as the `HDEL`, with its exact count (rule 24) | erasure |
| A course or product deleted | Nothing at once; the run finds the course gone (exact null) and `ZREM`s those members as it reads them | run |
| Each run | `ZREMRANGEBYSCORE -inf (now − 3 days)`: pairs past the three-day window leave unsent, as today | 1 command per store per run |

## The run

1. `SMEMBERS nl:drip:stores` and the cursor (as today: 2 commands, the company's).
2. For each store: `ZREMRANGEBYSCORE` (1), then `ZRANGEBYSCORE (now − 3 days) now LIMIT 0 100` (1 per page).
3. For each pair in the page:
   - read its course and listing from the run's batched cache (the code at `0703841bd`);
   - recompute `opensAt` from the course as it is now (a pair whose module is gone, or no longer due, is `ZREM`ed);
   - `SISMEMBER` blocked;
   - `claimMark` and send (unchanged);
   - `ZREM` the pair once sent or `taken`.
4. A store stops at `DRIP_REFUSALS_PER_STORE` sends that did not go, as at `0703841bd`. Its due pairs stay for the next run, inside the same window.

What is due but not reached (the deadline) is `pending`, as today.

## Migration of the pairs already open

A one-time backfill per drip course:

- The old walk keeps running for a course until its backfill marks it done (`nl:drip:indexed:<courseId>`).
- The backfill reads the course's students by `HSCAN` pages of 200 and writes their pairs (one `ZADD` per page), at most N pages a run.
- It is bounded by the data room and priced once per store, like `stats-life-fill` (a `PER_PAYMENT_LINES` line). Its room is taken first, and a full room keeps the course on the old walk and says so.

Nothing is sent twice: the claim marks (`dripmail`) are the same keys.

## Worst month per plan, at full use

Per store per run:

- 1 `ZREMRANGEBYSCORE`;
- `ZRANGEBYSCORE` pages;
- for each pair processed: 1 `SISMEMBER`, 1 claim (3 over a window when sent, then `taken`), 1 `ZREM`;
- the refused sends: at most `DRIP_REFUSALS_PER_STORE` × 5 commands.

Pairs processed in a month are bounded by:

- the store's email figure (`STORE_ALLOWANCES[tier].email`: 75 / 300 / 800 a month), each sent pair once;
- plus the refusals ceiling a run (`DRIP_REFUSALS_PER_STORE` × 32).

Transfer: the store record once a run (1 MB × 32) and the outlines of the courses touched. Outlines are at most one per pair processed, and never more than the data room.

Proposed: `DRIP_REFUSALS_PER_STORE` from 20 to **5** for the indexed run. The bound below is tight, and 5 refused sends a day already says the store's sends are not going.

Store, rough: 32 × (1 + 1 + 5 × 5) + 75 × 5 is about 1,240 commands, $0.0025. Transfer: 32 × 1 MB, plus at most (2.4 + 5) × 32 courses × 512 KB, about 0.15 GB, $0.0046. **About $0.007 a month**, against a margin of about $0.024 under $65.

The RED will compute it from the code's constants. It will hold, unchanged:

- the refunded Store first year under $65 (`read-ceilings`, `email-logo-region`);
- every unit's margin positive (`margin-alignment`).

## Tests (RED first)

- A due pair is emailed once; one not yet due is not touched; one past the window is removed unsent.
- A run touches only due pairs. The test asserts the number of commands of a store with 2,000 courses and no due pair: no `HSCAN`, no course read.
- Each event of the table above: the index after it, a full room writing neither the row nor its pairs, and a person's deletion removing their members with an exact count.
- A schedule change rebuilds the course's entries. A removed module's stale member is dropped by the run.
- The backfill is resumable, never sends twice, and is priced once.
- Rule 24: an unreadable `ZRANGEBYSCORE` reply sends nothing for the store and keeps its pairs.
- The cost line per plan and the exposure tests above, with no ceiling, price or limit changed.

## Size

Expected around 500 to 700 lines with tests. Over about 600, the coordinator asked for a stacked keep branch.

## Open points for the coordinator

1. `DRIP_REFUSALS_PER_STORE` 20 → 5 for the indexed run (above).
2. The backfill's per-run page limit N and where its once-per-store cost line goes (`PER_PAYMENT_LINES`, as `stats-life-fill`).
3. While the backfill runs, a course is on the old walk. The exposure tests are exact only once every course is indexed. The old walk's cost during migration is a one-time exposure to name in the description.
