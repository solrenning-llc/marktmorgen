import os, subprocess, json
from pathlib import Path
r=Path('.git/cx1-review-2692').resolve()
out=r/'.cx1-evidence'
p=out/'canonical/app/refunds/page.tsx'
p.parent.mkdir(parents=True,exist_ok=True)
raw=subprocess.check_output(['git','show','8be6eb29:app/refunds/page.tsx'])
assert (r/'app/refunds/page.tsx').read_bytes().replace(b'\r\n',b'\n')==raw
p.write_bytes(raw)
env={k:os.environ[k] for k in ['PATH','SystemRoot','WINDIR'] if k in os.environ}
env['TEMP']=str(out/'tmp'); env['TMP']=env['TEMP']
env['CX1_LEDGER']=str(Path('.git/cx1-2692-ledger.json').resolve())
run=subprocess.run(['node','--max-old-space-size=512',str(out/'plan-refund-rules.test.ts.cjs')],cwd=out/'canonical',env=env,capture_output=True,timeout=120)
log=run.stdout+run.stderr
assert len(log)<=262144
(out/'canonical-plan-refund-rules.log').write_bytes(log)
print(json.dumps({'status':run.returncode,'summary':[l for l in log.decode().splitlines() if 'checks' in l]}))
