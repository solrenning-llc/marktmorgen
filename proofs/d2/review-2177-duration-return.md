# D2 return review of #2177

Exact head: a6182684b241408980257ad374dfe5092ed1dc56.
Original text/feature/row medium is closed. Current head is NOT approved because a residual medium was independently reproduced.

Unchanged original D2 proof d53c8c81d0206bb8c3557e9240e6f9249f15260c has the identical blob 9c841a7242712755280c3b9a3eff0f4cf6b019b9: six reached assertions all pass; three guarantee controls inside the failure-only branch are no longer reached. No assertions were removed. The older 16-case proof returns 15 pass / 1 fail, its partial-prose retention expectation. This expectation is incompatible with the explicit new whole-part-or-absent coordinator decision, so it is recorded as historical, not represented as a passing test or a live refund defect. The actual guarantee condition remains present.

Read the entire delta from 6e6551ea: answers.ts, answers-rules.ts, store-assistant-rules.ts, seven language additions, tests and the reservation replacement. Author branch unchanged.

Current linked tests: answers-row23, answers33, terms-cut28, terms-paraphrase19, store-assistant90, store-assistant-tax7, store-language980 = 1180 passes, plus six reached original D2 assertions. No global suite is claimed.

Residual medium at store-assistant-rules.ts 348–355: NUMBER_WORDS does not include thirteen or seventeen. Real parsed page: four 3000-character filler parts, a short promise “You can try it for thirteen days.”, then a 2900-character condition part beginning “Only if the purchased file has never been downloaded.” Facts retain the promise and cutoff marker, drop the condition. heldToFacts accepts it and answerQuestion returns known:true with the synthetic model reply. Seventeen behaves identically; thirty is refused. New unchanged proof ecad3e145208b4efac338bbd9104266318f04eb8: 12 checks / 4 failures / 8 controls; parser, facts, filter and answerQuestion are real, Redis/model are existing synthetic boundaries. No real provider call.

Strict scoped TypeScript for the proof and implementation roots plus resolved imports passed. The initial temporary config lacked explicit typeRoots because it lived in /dev/shm; corrected only the config, then exit0. Earlier global TSC was killed by the host, not claimed green. Focused lint, new-file diff check and public-data scan including the new proof through a private index passed (3646/0). No browser/native Redis/global build/full CI/actual model behavior claimed.
