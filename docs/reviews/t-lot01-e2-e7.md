# Lot 01: E2 and E7 source and dependency audit

Frozen main 87d9e6a1c4bf98f89ac7969e8e4093e8d1134231; November 6, 2026. Read-only inspection, not an implementation or whole-feature cost certification. Audit reservation 498e331454ea8f65a19fb24ffdb4aca969e0a572.

| Item | Source evidence | Remaining scope |
| --- | --- | --- |
| E2 / 19 | Queue:2369–2373; community-points.ts:19 and community API:338/347 currently award likes on others' posts/comments | Community challenges, task/check-in records and their points are absent in inspected community paths |
| Existing five-day challenge template | course-templates.ts:61; course-templates.test.ts:27 | A drip-course template does not absorb community tasks/check-ins |
| E7 / 24 expiry | Queue:2424–2428; course.ts:91/195/285 contains opening date and certificate validity, not access expiry | Creator-selected access expiry remains absent |
| E7 lesson points | learn.ts:506–518 records completion; course-finish.ts:61–72 triggers course-completed automation | Neither implements lesson-completion points |

The ledger access decision at learn.ts:398–406 uses ended membership; it does not establish a creator's chosen access end. Certificate validity and authentication TTL are distinct features. Queue:2574 joins E7/item112 and requires server facts, anti-repetition and appropriate reversal.

## First pure units

Separately reserved before code in channel 962582b6c90912b01e597bf72d0deace9eda7b67:

- E2: new community-challenge-rules.ts and its behavioral tests, only exact supplied timestamp validation and scheduled/active/ended window state. No daily-calendar policy: creator timezone versus rolling 24-hour days is not resolved by the queue. No routes, writes, check-in acceptance, awards or public capability.
- E7: new course-access-expiry-rules.ts and tests, only optional explicit expiry-state evaluation. No course field, ledger or grant changes. A returned active expiry state is not an access authorization.

Both are foundations without paid IO or a runtime consumer. They do not mean complete E2/E7 exists or has zero operating cost. Product storage, retention and deletion/export sizing are prerequisites before integration.

## Integration dependencies

Existing community points remain with Codex O (reservations/codex.md:54,59). The learn.ts serial release is A3 then #2791/#2794 (reservation:10); fresh ownership must be checked before any later call-site change. Member points deletion/export are community-points.ts:248,297; every new person-linked key must join them.

Completion is currently SISMEMBER, room reservation, then SADD. Adding award after that read would not prove atomic first completion. Integration needs an idempotent atomic receipt, retry/deduplication and reversal tests, plus reviewed cost before IO. Existing point storage allocation does not fund an unlimited new challenge/check-in family.
