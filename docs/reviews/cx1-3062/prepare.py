from pathlib import Path
import json
p=Path('.git/cx1-3062-ledger.json'); assert not p.exists()
p.write_text(json.dumps({'http':0,'redisCommands':0,'httpLimit':100,'redisLimit':20000}))
s=Path('.git/cx1-run-2692.mjs').read_text().replace('cx1-2692-ledger.json','cx1-3062-ledger.json')
Path('.git/cx1-run-3062.mjs').write_text(s)
r=Path('.git/cx1-review-3062')
src=(r/'tests/directory-assembly-ceiling.test.ts').read_text(encoding='utf8')
start=src.index('  part("A save every second for twenty minutes:')
end=src.index('  part("Past the ceiling:',start)
(r/'tests/cx1-directory-author-bounded.proof.ts').write_text(src[:start]+src[end:],encoding='utf8')
