from pathlib import Path
import json
b=Path(__file__).resolve().parent;r=b/'cx1-review-3610';p=b/'cx1-3610-ledger.json';assert not p.exists()
p.write_text(json.dumps({'http':0,'redisCommands':0,'httpLimit':0,'redisLimit':0}))
s=(b/'cx1-run-3590.mjs').read_text().replace('cx1-3590-ledger.json','cx1-3610-ledger.json')
# Run the SAME test with a filesystem view of the RED commit, where this new document does not exist.
s=s.replace('cwd:root,env,encoding:',"cwd:process.env.CX1_DOC_ABSENT ? join(out,'before') : root,env,encoding:")
s=s.replace("const ledger={};","mkdirSync(join(out,'before'),{recursive:true});\nconst ledger={};")
(b/'cx1-run-3610.mjs').write_text(s)
(r/'tests/cx1-monitoring-ecp-source-gap.proof.ts').write_text('''import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
const doc=readFileSync("docs/gd1-payment-monitoring-sources-2026-11-10.md","utf8");
part("The cited provider pages disagree about the ECP rate; retain that concrete gap before implementation");
// docs.stripe.com/disputes/monitoring-programs, ECM table: 1.5–2.99%.
// support.stripe.com/questions/monitoring-program-faq, ECP calculation: 1%.
// This checks the missing fact, not a preferred wording or a runtime threshold.
is("the study records the FAQ's one-percent ECP rate as well as the guide's ECM rate", /(?:^|[^0-9.,])1(?:[.,]0+)?\\s*%/m.test(doc), true);
done();
''',encoding='utf8')
print('prepared zero-I/O ledger and one documentary assertion')
