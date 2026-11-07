# Course compliance: lesson order and "90% watched" measured on the server

Queue item 102 [E2-COURSE-COMPLIANCE], a prerequisite of 96 [D2-LESSON-DROPOFF]. **Design only** (6 November 2026, Claude 5). No product code, price, limit, commission, flag or gate changes. State of everything below: *in the queue*, not built. Nothing here is available to a customer.

## 1. What exists today (main at c366e58ab)

| Fact | Where |
| --- | --- |
| A lesson is `Lesson { video: ProductFile \| null, quiz, task, preview, link, ... }`; the order is the array order of `modules[].lessons[]` | lib/course.ts:52-77, `lessonsInOrder` :213 |
| Drip is the only time gate: `isOpen(course, unit, joined)` per module | lib/course.ts:235-271 |
| The only **order** gate is `heldBack(course, passed)`: every lesson after the first required quiz or gating assignment that is not yet passed is held. It is the one shared function, used by the lesson page, "Mark as done", the file route, the quiz route, the comment route and assignment access | lib/quiz.ts:341-351; app/[handle]/course/[product]/[lesson]/page.tsx:114-116; app/api/store/course/progress/route.ts:~52; app/api/store/course/file/route.ts:46; quiz/route.ts:52; lib/assignment-access.ts:33; lib/course-preview.ts:57 |
| Progress is one Redis set per course and student, `nl:course:<course>:done:<emailKey>`, of lesson ids. `markLesson` takes room in the store's data room first (`needData`, `DataRoomError`) | lib/learn.ts:412, 506-518 |
| "Mark as done" is a plain form POST. The server does **not** check that earlier lessons are done, nor that any video was watched: a student can mark lesson 9 done first. The only refusals are drip, quiz-held, task, and a required quiz not passed | progress/route.ts:35-79 |
| Finishing (all lessons done) triggers `noteIfFinished` (certificate, flows) | lib/course-finish.ts:61 |
| Stream videos play in the video service's iframe with a signed token (4 h); the iframe is cross-origin, the page sees nothing of playback | lib/stream.ts:602-663 (`playerFor`, `PLAYER_SECONDS` :112); page.tsx:199-230 |
| Stream length is known server-side: `StreamRecord.seconds`, filled when the service has read the file (0 until then). **There is no `streamLengths` function**; the queue's name for it does not exist. Read it with `streamRecord(pathname)` | lib/stream.ts:132-153, 199 |
| Watch time is measured **per store and per month**, from the service's own running total per video, read hourly (`streamWatched`). It is not per student and not per lesson position. It is the figure the plan's video allowance is charged on (4 / 32 / 64 hours: `PAID_VIDEO_HOURS`) | lib/watch.ts; lib/stream.ts:321; lib/video-admission-rules.ts:6; lib/learn.ts:719-750 |
| Non-stream lesson videos (`kind: "file"`) play in a native video element with a signed link; no length is stored for them | lib/learn.ts:690-700 |
| Nothing the browser says about watching is recorded today. So today there is **no** client-reported watch time to distrust, and no server-side watch data per student either | grep of lib/, app/api: none |

Consequence: the gap is exactly the two things the item names. (a) Order is not enforced for plain lessons. (b) "Watched" has no per-student measure.

## 2. The measure: what the server can and cannot know

**Honest limit first.** The server never sees a person's eyes. It can bound how fast "watched" can accumulate and require that it was reported in a consistent way, so a casual skip does not pass and a forged pass is expensive and visible. It cannot prove attention, nor that a video played on a screen somebody looked at. The product copy must say "watched at least 90% of the video" for what the player reported, never "verified attention".

### 2.1 Buckets, not seconds

A lesson's video is split into equal **buckets**. `interval = max(15, ceil(length / 960))` seconds, so a video has at most 960 buckets (a 4-hour video, the token ceiling; 15 s for anything up to 4 h). `buckets = ceil(length / interval)`, `length = StreamRecord.seconds`, read on the server when the page renders. A student's state for a lesson is a **bitmap** of buckets already covered: at most 120 bytes.

- 90% rule: complete when `popcount(bitmap) >= ceil(0.9 * buckets)`. Distinct coverage, so skipping to the end, or replaying the same minute, does not count. Seeking is allowed and is simply uncovered.
- `length` of 0 (service has not measured yet): no heartbeat is accepted and the rule is not applied; the page shows "Your video is still being prepared". Unknown never becomes "watched".
- Creator's percentage is a setting (default 90, allowed 50-100, step 5). 100 means all buckets.

### 2.2 Signed heartbeats

The lesson page (server render) mints a **heartbeat token** and passes it to a small client component that wraps the iframe.

- Token = base64url(payload) + HMAC-SHA256 over `courseId, lessonId, emailKey, streamId, interval, issuedAt, exp` with a server secret (same secret family as the existing signed links; a new env name is a Depends-on-owner step only if none fits). `exp = issuedAt + PLAYER_SECONDS`. A token copied to another account fails (emailKey), to another lesson fails, expired fails. The student's session cookie is also checked (`courseAccess`), so a token alone is not a login.
- The client listens for the player's `timeupdate`/`play`/`pause` messages through the provider's Player.js protocol (**to confirm in unit 4 from the provider's dated official doc**; if the embed does not offer it, the fallback is the provider's own per-video watch statistics, which are per video not per student and would not support this design: then stop and report). It accepts messages only from `STREAM_PLAYER_ORIGIN` and from the iframe's own `contentWindow`.
- While playing and visible, it POSTs every `interval` seconds: `{ token, bucket }` where `bucket = floor(position / interval)`. No beat while paused or hidden.
- Route: `POST /api/store/course/watch`, small JSON, `limited(request, 1_000)`, same-site check (`fromAnotherSite`), `no-store`.

### 2.3 Server rules per heartbeat (all must hold; otherwise 204 with nothing recorded)

1. Token valid, student has open access, lesson open (`isOpen`) and not held (`heldBack`), store not resting.
2. `0 <= bucket < buckets`; bucket belongs to this token's `interval`.
3. **Pace:** at most one accepted beat per `interval / 2` seconds per student and lesson (`SET pace NX EX`). So covering a full video needs at least half its length in wall-clock requests. This is the "playback at 2x" allowance (the player offers speed, so faster playback is legitimate; beyond 2x is refused, which a plain 2x viewer never hits because beats are per wall interval).
4. **Forward plausibility:** a bucket farther than `3` buckets beyond the highest bucket already covered in this token's session is not credited unless the student's last beat was within 2 intervals (a seek is allowed, but a jump needs a live session, not a cold forged one). Detail for unit 2 to settle in tests; the invariant is rule 3 plus rule 5.
5. **Pools (spend ceilings, reserved before the write):** see section 4. A spent pool refuses the beat (section 4.3 says what the student sees).
6. **Idempotent write:** the bit is set once; a replayed or duplicated beat sets an already-set bit and changes nothing. Replay is safe by construction, with no nonce store to grow.

### 2.4 What a cheating client can and cannot do

| Attack | Result |
| --- | --- |
| Click "Mark as done" without watching | Refused by the server when the lesson needs the video (the form route checks coverage). |
| Open the lesson, never play, script beats | Possible. Bounded by pace (half the video's length in real time), by the 25% per-student pool share and by one student's account. Leaves a pattern the creator could be told about (no aggregate "suspicious" claims in v1). **The server cannot tell a script from a person who left the tab playing.** |
| Play muted in a background tab | Counts if the player reports playback. Browsers throttle; we do not claim more. Visibility is client-reported and not provable. |
| Replay one beat many times | No effect (idempotent), costs the student's own request quota. |
| Share the token | Useless without the same account's session cookie. |
| Seek to the end | The end buckets count only if beats arrive for them; the rest stay uncovered. |
| Two devices | Both write the same bitmap; coverage is a union. Fine. |

So the guarantee is: *to pass by cheating, someone must run a script that keeps up with real time at 2x or slower, using an account that paid.* That stops skipping, not deception, and the text shown to the creator says so.

### 2.5 Videos this cannot cover

- External links (`lesson.link`), non-stream uploaded files (`kind: "file"`, no stored length; a length from the browser is exactly the client-reported figure this item refuses), and lessons with no video: the 90% rule does **not** apply. Order still applies (done = button, quiz, or hand-in as today). The editor says so next to the setting.
- Preview lessons and the creator's own preview never need beats or are held.

## 3. Lesson order

### 3.1 Creator setting (Course, additive and optional like `stampVideo`)

- `lessonOrder?: "free" | "sequential"` (absent = "free", **all existing courses unchanged**).
- `watchPercent?: number` (50-100, absent = 90), used only when `lessonOrder` is "sequential" and a lesson has a stream video.
- Per-lesson opt-out is not needed in v1 (preview lessons are always open).

### 3.2 Rule

In "sequential", lesson N (not a preview) is **held** until lesson N-1 is *complete*, where complete = marked done (button, passed quiz, handed-in task, as `markLesson` does today) **and**, if N-1 has a stream video and the rule applies, coverage >= `watchPercent`. A lesson the student already has done is never re-locked by a later reorder or by a raised percentage (the rule only holds what is not yet done). Evaluated against the current order.

### 3.3 Where it is checked

One function, because `heldBack` is already the single point: extend it (new optional argument: the student's complete set and the course settings) so every caller below inherits the rule, instead of adding a second check somewhere:

1. Lesson page server render (page.tsx:114-116) - redirect to the blocking lesson with `?held=1`.
2. `progress/route.ts` - refuse "Mark as done" for a held lesson and for a lesson whose own video is below the percentage.
3. `course/file/route.ts`, `quiz/route.ts`, `comment/route.ts`, `task/route.ts`, `assignment-access.ts` - already call `heldBack`; they pick it up unchanged.
4. The new watch route (rule 1 of 2.3).
5. `course-preview.ts` (creator "what a student sees") so the preview shows the lock.
6. Outline (`components/course-outline.tsx`) draws held lessons with text, not only an icon.

The component never decides; it only displays. A hand-built request gets the same refusal.

### 3.4 What the student sees (AX274)

Plain US English, grade-8, no timer, no shaming, all as text plus the structure (not color only), reachable by keyboard and announced in a polite live region:

- Held lesson page: heading "Finish “<title of lesson N-1>” first", one sentence "Watch at least 90% of its video, then press Mark as done. Then this lesson opens." and a single link button "Go to “<title>”".
- On the video: a text readout "Watched: 72% of this video. 90% opens the next lesson." with `<progress>`-semantics (`aria-valuenow`), updated at most every 15 s to avoid chatter; no auto-popups; no flashing.
- "Mark as done" is disabled-with-reason, not hidden: "Available after you watch 90% of the video." (disabled buttons keep an explanation in text beside them.)
- Outline: "Locked. Opens after you finish lesson 4." as text.
- Pool spent / room full / video unmeasured: the student is **never** locked out by the creator's plan or a cost ceiling. See 4.3.
- **Equivalent alternatives (no fake presence):** captions and playback speed count normally. A creator can "Let this student continue" for one student from the students list (a per-student release set, a few bytes), for anyone who cannot use the player. This is a recorded creator action, not a silent bypass, and it is the documented accommodation for AX274.
- Words live in lib/buyer-words in every language the site has today; a language not yet reviewed falls back to the existing rule for new buyer words (do not add a language by this item).

## 4. MR cost (rough, from tests/plan-cost-registry.ts shapes)

Unit prices come from lib/spend-cost-table.ts through the registry: Redis command US$2.00 per million (`COMMAND` = 2e-6), transfer US$0.03/GB (`DB_BYTE` 3e-11), storage US$0.25/GB-month (`DB_BYTE_MONTH` 2.5e-10), Vercel call US$0.60/million, CPU US$0.128/h, memory US$0.0106/GB-h at 2 GB. A heartbeat is a `light` request (1.3 s, 0.1 CPU s; SHAPES) with 4 Redis commands (pace `SET NX`, pool `INCR`+first-use `EXPIRE`, the bitmap `SETBIT`; counted as 4 to be conservative):

`request("light", 4, ~400 B)` = 0.60 µ$ (call) + 3.56 µ$ (CPU) + 7.66 µ$ (memory) + 8.00 µ$ (commands) + 0.01 µ$ (bytes) = **about US$0.0000198 per heartbeat**.

### 4.1 Caps, so the worst case is independent of the number of students

Heartbeats come from the same watching the plan already meters, so the pool is derived from the plan's own video allowance (`paidVideoSeconds(tier)`, 4 / 32 / 64 hours a month), with room for 2x playback:

`pool(tier) = 2 * paidVideoSeconds(tier) / 15 s` per store per calendar month (`nl:watchbeat:pool:<folder>:<month>`, expiring after the month).

| Plan | Monthly pool | Worst month | Worst year |
| --- | --- | --- | --- |
| Store (4 h) | 1,920 | 1,920 x US$0.0000198 = **US$0.038** | US$0.456 |
| Studio (32 h) | 15,360 | **US$0.304** | US$3.65 |
| Scale (64 h) | 30,720 | **US$0.608** | US$7.30 |

- Per student, at most 25% of the pool a month (`nl:watchbeat:student:...`), so one account cannot spend the store's pool (a few paid accounts together still can: accepted, bounded by the pool, and it only ends the 90% measure for the month, see 4.3).
- Per student per lesson, at most `2 * buckets` accepted beats, and a hard 60 requests/minute guard on the route.
- Pool and caps are **reserved (incremented) before** the bitmap write, like every other spend (VR/MR rule: ceiling before spend). A failure to read a pool means refuse (unknown never zero).

### 4.2 Storage

Bitmap at most 120 B + key and field overhead (counted as 160 B), one hash per student and course (`nl:course:<course>:watch:<emailKey>`, field = lesson id). Worst case, a full 200-lesson course: 200 x (120 + 160) = 56 KB per student, = 56,000 x 2.5e-10 = **US$0.000014 per student-month**, plus one write transfer of the same order. Counted in the store's data room like `markLesson` (`dataBytes`, `needData`, slot `cw:<course>`), so the room that already bounds a plan's records bounds this, and a full room gives the fallback in 4.3, never a lost purchase. Registry: a new key family in tests/store-data-registry.ts (it fails for an unbounded family) and a new read/write line in tests/plan-cost-registry.ts. **Unit 2 must add those lines; this document adds none and certifies no margin.**

### 4.3 Fallback (fail open for the student, closed for the spend)

Pool spent, student share spent, data room full or Redis unreadable: **no beat is recorded** and the lesson's 90% requirement is *not applied for that student that month* (order, quiz and task gates still apply). The creator sees one line in the course's students list ("Video watch measure paused this month"). A paying student is never blocked by a cost ceiling, and unknown cost does not become free: nothing is spent.

### 4.4 The refunded Store first year (net < US$66)

The Store annual unit keeps US$66.39 before and US$65.39 after the reserved room (docs/mr3-current-price-result-2026-10-27.md:138). The worst year of this feature on Store is **US$0.456 of heartbeats + well under US$0.01 of storage**, about 0.7% of the retained US$65.39, from a pool that is per store, so it does not grow with students. A fully refunded first year loses the revenue regardless; the cost left behind is at most that US$0.46, inside the pool, and the refund reserve is unchanged. On the monthly Store unit the worst month costs US$0.038 against the US$0.25 reserved room and US$6.32 conservative profit, positive. **This is an estimate from registry prices, not a review.** The registry line (unit 2) is what makes it count; if the line fails any unit, the feature is not built for that plan, with no change to price or limits.

## 5. Privacy

Per-student watch coverage is personal data (it shows when and how a named person studied).

- Kept: bitmap per student per lesson, plus the pace/student-pool counters (hashed key, no address in the key: `emailKey`, as `doneKey` does). No IP, no user agent, no timestamps beyond the month-expiring counters. No per-beat log.
- Retention: with the course access. Deleted when the creator removes the student, when the course is deleted (`dropCourse`), and at once on a person's erasure request: add `lib/learn.ts` watch module to `lib/person-erasure.ts` (the list at :105-135, same shape as `forgetFinishPerson`) and an `erased` entry in `lib/person-data.ts` (:105-108 pattern); the "copy of my data" export lists the lessons and the percentage covered per lesson. The pace keys expire in under a minute; the pool counters hold no person.
- The privacy page and the lesson page state it in plain words ("We record how much of each video you watched so the next lesson can open. Delete it any time at <existing erase link>"); the store's own privacy text follows the existing builder.
- Creators see **only** the percent of each lesson covered per student in the students list (aggregate for 96 [D2-LESSON-DROPOFF]: counts of students per bucket, no names), no replay of when.
- No tracking pixels, no third party beyond the video service already in use. Nothing is sent to analytics.

## 6. Units, files, who holds them now

Sequence after the two holders; nothing below starts before their PRs merge. Re-check the reservations in docs/codex-queue.md before each unit.

| Unit | What | Files (new unless noted) | Holder now |
| --- | --- | --- | --- |
| 1 | Pure rules: buckets, interval, required count, token sign/verify, pace and forward-plausibility predicates | lib/lesson-watch-rules.ts, tests/lesson-watch-rules.test.ts | free (new files) |
| 2 | Storage + route + pools + erasure + registry lines | lib/lesson-watch.ts, app/api/store/course/watch/route.ts, tests/lesson-watch.test.ts; edits: lib/person-erasure.ts, lib/person-data.ts, tests/store-data-registry.ts, tests/plan-cost-registry.ts (shared and often reserved: reserve first) | lib/learn.ts not needed; the registry files are shared hot files |
| 3 | Settings + the gate: `lessonOrder`, `watchPercent` on `Course`, `parseCourse`, `editCourse`; extend `heldBack`; refuse in progress route | lib/course.ts, lib/quiz.ts, app/api/store/course/progress/route.ts, tests | **lib/course.ts: Claude 4 (#2560)** - wait for its merge |
| 4 | Client component around the iframe, outline and held-page words | components/lesson-watch.tsx, page.tsx, components/course-outline.tsx, lib/buyer-words/* | page.tsx and outline: check; no known holder |
| 5 | Creator setting in the editor and "let this student continue" | components/course-editor.tsx, students list (lib/learn.ts), course-preview.ts | **components/course-editor.tsx: Codex J** - wait for its merge |

Units 1 and 2 can run now and in parallel (new files, only registry edits to coordinate); 3 after #2560; 5 after Codex J.

## 7. Acceptance tests per unit

1. **Rules.** Interval and bucket count for 20 s, 15 min, 4 h, 10 h (bucket cap 960, interval grows). Required count for 50/90/100%. Token: valid, wrong account, wrong lesson, wrong stream, expired, tampered signature, truncated. Pace: two beats inside `interval/2` refuse. Length 0 refuses and never counts. Property test: any sequence of beats at 2x wall rate or slower covers at most `2 * elapsed / interval + 1` buckets.
2. **Storage and route** (fake Redis, no real provider). A beat sets exactly one bit; the same beat 100 times changes nothing and costs no pool after the first; the pool counter is incremented *before* the write and a failed read of it refuses; pool, student share, per-lesson cap and room each give "no record, fallback flag"; other site, wrong method, oversized body refused; erasure removes every key and the person's export lists the percentages; key families appear in the store-data registry; the registry line for the heartbeat fits every plan's unit (fails the suite if any unit goes below zero or loses its reserved room). Cost test: pool x price for each tier equals the table in 4.1.
3. **Gate.** Existing courses (no setting) behave exactly as today (snapshot of `heldBack` outputs). Sequential: lesson 3 held until 2 is complete; a done lesson is never re-held after a reorder; previews open; creator preview unaffected; drip and quiz gates still apply together; every caller (page, progress, file, quiz, comment, task, assignment, preview) refuses a held lesson with the same blocker; hand-built "Mark as done" for a 60%-watched video is refused, at 90% accepted; non-stream lesson ignores the percentage; pool-spent student is not blocked.
4. **Student view.** Real-browser test with a mocked player postMessage: readout updates at most every 15 s, `aria-valuenow` correct, live region polite, held page has heading, reason and one link, button disabled with text, keyboard-only path completes, no time limit, `prefers-reduced-motion` honored, contrast 7:1 in all themes, 320 px reflow, text in every shipped buyer language (and the fallback rule for unreviewed ones). The Acessibilidade section lists what was **not** done (no real assistive-technology or human test yet: a gap, not a pass).
5. **Editor and release.** Setting saves and round-trips for old and new courses; the editor text states what is not measured (external links, uploaded files); "Let this student continue" is recorded, undoable and visible in the students list; a released student passes with 0% watched; no label says "verified".

## 8. Open questions for the owner (none blocks units 1 and 2)

1. Default percentage 90 (as the item says) and range 50-100: confirm, or fix at exactly 90.
2. Should "sequential" be on by default for **new** courses? This design says no (opt-in), so nothing changes by surprise.

## 9. State

In the queue. Design recorded in this file. No code, no price, limit, commission, flag, tax or gate changed; no account, contract, payment or third-party contact; synthetic tests only in later units. This estimate does not certify a margin and does not open sales (`PLANS_ON_SALE` stays false).
