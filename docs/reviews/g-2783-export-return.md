# G — #2783 corrective review

Exact head116e92b7bbfdfc1f47f50a359d1d5f98fc0474ce; baseea72f8dc58640419dc5a4b093248ac33ce63f3c1. Nominal C4-20261106-0510-C3-18, claim621ac6dff09d832d150f3f4d204d6bf493e8d24f. **G's MEDIUM legacy-export omission (audit comment6679716160) CLOSED; no new finding in this complete four-path corrective diff.** No backup activation approved or performed. Integration cleanliness and nine final exact-head checks remain the author's gates.

Read the complete4paths167additions/3deletions, including identical proof/launcher and new59-line test. Shape validation now precedes numeric expiry skip, after a null DUMP's already-confirmed absence. Safe integer domain >=-2 is explicit. Existing -2/-1/epoch/past/current/future/MAX_SAFE controls retain semantics. Invalid non-null numeric expiries refuse the whole export.

## Executed RED/GREEN

Detached copies: red0e2c2c7f90fcb027eb53c5d461439f22bb57221f and final116e92b7. Same files, no product replacement or local fix:
- Original G proof37checks/8failures ->37/37, unchanged blob2852c07ee1d141b219ca926c109d465c23787427.
- Same launcher blob6a87180dee5a1260a6df586f978bc1b8bb45de47.
- Permanent author test11checks/5failures ->11/11.
- New G batch proof8checks/8failures ->8/8. Seven live source keys, batch2, invalid third key after first batch succeeds. Final refuses unreadable after9commands, sends no further batch (4DUMPs), exposes no partial snapshot, leaves all seven source values intact. Four vectors:-3,-0.5,-Infinity, unsafe-negative. Proof commit6e88aeffcbd31ffcc008a5fc6b520e787892e09c, blob855474d407374454003c938e065fc134bf2c0280. An initial local harness tried unsupported MemoryRedis DBSIZE and was corrected to check all seven GET values; that harness error was not counted as a product RED.

Run: node tests/g2175-export-audit-run.mjs g2175-export-expiry.proof.ts backup-export-expiry-exact.test.ts g2783-batched-expiry.proof.ts.

Nine ordinary groups287/287: codec21,cost27,multipart expiry11,export22,parts26,restore-target41,roundtrip11,run96,store32. Total343 executions includes original+permanent+additional56 and ordinary287; no claim of unique independent343cases.

Scoped strict TypeScript for actual export/codec/roundtrip imports and all proofs0; focused lint0; scanner3914tracked/0 plus new proof0; corrective/new proof whitespace clean. No native Redis, real bucket, real providers, browser, full build/global CI, real loss or actual margin exercised.

## Sibling inventory and scope

Read PEXPIRETIME/TTL references across lib/backup*.ts. Only backup-export and backup-parts read source PEXPIRETIME; multipart validates before skip since713ff81c. backup-codec validates every row before restoreRows filters expiresAt; restore-target calculates TTL from validated future expiry with its own checks. No second same-order defect reproduced. This inventory is limited to backup family, not all repository TTL users.

No product, reservation, author branch, CI, merge, policy, gate, limit, price, account, payment or external contact changed. #2697 residual cost evidence remains withC4; #2781 second financial remains G's next nominal item after this return. R1/R2/CX1 roles are not replaced.
