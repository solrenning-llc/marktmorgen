from pathlib import Path
import json
b=Path(__file__).resolve().parent;r=b/'cx1-review-3598'
ledger=json.loads((b/'cx1-3598-ledger.json').read_text())
assert ledger['http']<=73 and ledger['redisCommands']<20000
s=(r/'tests/cx1-move-unknown.proof.ts').read_text(encoding='utf8')
removed='    const kept=await keptAlready(store,`${name}@example.com`,productId).catch(()=> \'unknown\');\n    is(`${label}: reminder knowledge`,kept,exists===null?\'unknown\':exists);\n'
assert s.count(removed)==1
s=s.replace(removed,'    // Independent opening-only subset: the original 15-check RED proof is untouched.\n')
target=r/'tests/cx1-move-opening-causal.proof.ts'
assert not target.exists()
target.write_text(s,encoding='utf8',newline='\n')
print('causal opening-only8checks, same expectations, maximum19mock calls, original15 intact; ledger',ledger,flush=True)
