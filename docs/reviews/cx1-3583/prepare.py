from pathlib import Path
import json
p=Path('.git/cx1-3583-ledger.json'); assert not p.exists()
p.write_text(json.dumps({'http':0,'redisCommands':0,'httpLimit':100,'redisLimit':20000}))
s=Path('.git/cx1-run-2692.mjs').read_text().replace('cx1-2692-ledger.json','cx1-3583-ledger.json')
Path('.git/cx1-run-3583.mjs').write_text(s)
