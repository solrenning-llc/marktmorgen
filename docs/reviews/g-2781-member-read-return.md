# G — #2781 corrective return: residual member-read MEDIUM

Exact reviewed headc2b313ce847ecdbfa74521e6e7b4c32eb626b76c; prior corrective7f760b4e8cb28d4a35d4318ca80aa981faee44b8; original832c5b8600f71c2fd86140c71791a104b564019c. Second financial, C4 first, nominal C4-0505/C5 requests04h57/05h03; claimc2bac2e219f21bf322e8312b43d3de8f1c53bdb065c. **G original M1/M2 closed on demonstrated contract, but ONE residual MEDIUM remains: NOT CLEARED.** C4's independent TTL-of-retry LOW remains hers; G does not silently close it.

Full corrective diffs read:832..7f two paths214+/56-;7f..c2b two paths90+/8-; combined296+/56-. Main/base and author refs untouched.

## Residual MEDIUM — unknown member list committed as handled

lib/group-buy.ts:576–580 and598. The outer single-result envelope is checked, but its HGETALL value acceptsnull and anyobject; values() can yieldno members and parseMember() silently discards malformedentries. handle then writes SADDseen and the completed page advances the anchor. A subsequent healthy run skips the refund because it is alreadyseen.

Independent proof uses actual startGroup/createCheckout/settleGroup and askPlace/takePlace to grant one place, not a fabricated manual grant/member row. Only the HGETALL answer for thatgroup is replaced once AFTER the real MemoryRedis read. Three vectors:null, odd flatarray["odd-field"], object{broken:true}. Each causes seen1 and anchor advance while a real grantedmember remains. A later healthy run leaves importedFor count1 and actual purchasesFor still lists the product as place:true. purchasesFor's synthetic store view disables its external Stripe lookup, isolating the retained imported entitlement. No HTTPdownload/login/browser authorization flow or real financialloss claimed.

Same frozen proof on BOTH7f andc2b:12checks/6causal failures (3vectors*2: no handledmark and recovery),6controls pass. On the exact c2bordinaryauthor34/34 andgroup61/61 pass, so those do not cover this residual. Require a complete legible member schema before claiming completion; malformed list/row must remain pending under the existing bounded retry design, not become no members. This is a reproduced sibling/residual of C4's membercleanupM3, not an assertion that her earlier legitimate-partial-close case regressed.

Proof1e7a49200891bb2b3c1c1941d848d2e668dedd95, tests/g2781-member-read.proof.ts, blob12b3a3fffbad8383857b4bd803b7aad80071a929. Runner9b3f11417a3a8ef8399e29f72e77dc941e9ca585, tests/g2781-run.mjs/blob6a87180d. Branchcodex/g-review-2781-member-read-return was basedon7f; copy the proof/runner into the EXACT reviewedc2bcheckout before executing. Same bytes verified locally. No repairedGREEN for this12-caseproof.

## Original findings and current-boundary evidence

The original4aff4e8d seven-check proof was run UNCHANGED first on7f:7/3 failures. Three assertions describe the old state (repeat identical pages; seenalready1beforework), not desired correctness after correction. Also its old mapping-loss interceptor matches SADD+GET and no longerhits the newSISMEMBER+GET (hit0), so that originalmappingoutcome cannot itself establish current-boundary recovery. No original assertion changed or7/7claimed.

A separate independent current-boundary proof retains the recovery requirements and changes nooldproof:6checks/5failures on832 ->6/6 onc2b. First runreads10pages and leavespage11pending, secondboundedrunresumesafterre_LotThreeOther3999andrevokes. Each old interruptedclose/mappingcase is now intercepted exactlyonce atactualcurrentcommands; seen0/openbeforehealthyretry ->seen1/closedafterretry. This closes G's two original demonstrated defects without pretending old diagnostics are new GREEN.

Newcurrent-boundaryproof2a7c7a798b00089883bb695a742461776a1ee6b1, tests/g2781-return-recovery.proof.ts, blobc511ff8cfa8d0c45f118d20019b7d7e6fc166f16. Frozen separately fromoriginalproof.

## Other executed validation

Author permanent34checks/6causalfailures on10531a6b232b59a56007a4f0e87ef5a42d48578f ->34/34onc2b. Read/ran allcasesincludingretryqueue, anchorunknown and legitimatehalfwaymembercleanup. Totalordinary11groups313customchecks+34node:testgreen,0skip (34author+61group+218othercustom; closing4/taxjournal6/costregistry24). Independentrecovery6/6 isadditional, member12/6stillRED.

ScopedstrictTypeScript actualgroup/refund/reader/entitlement imports and bothproofs0. Focusedlint0errors/11unusedfixturewarnings openlydeclared across two derivativeproofs; no productlintwarning introduced. Scanner3907tracked/0 plusbothproofs0, whitespaceclean. No nativeRedis/provider/browser/globalbuild/CI, real accounts/mail/payment/contact, margin or productioncertification.

C4newqueue/deadline/cost/TTLjudgments staywithherfirstreview. Sameproof mustbe repeated unchanged onthenextnominalcorrectivehead. Productauthorownsfix, Gneveredits/reserves/mergesproduct or changescost/policy/limits/flags. Rawlogsandpointofcontinuityarepreserved inthisownbranch.
