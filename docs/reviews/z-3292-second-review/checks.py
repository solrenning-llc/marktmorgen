from pathlib import Path
import json, subprocess, time
p=Path("docs/reviews/z-3292-second-review")
commands=[
 ("types",["node","--max-old-space-size=1024","--require",str((p/"network-guard.cjs").resolve()),str(p/"types.mjs")]),
 ("lint",["node","--max-old-space-size=512","--require",str((p/"network-guard.cjs").resolve()),"node_modules/eslint/bin/eslint.js","lib/creator-invite-credit.ts","tests/invite-credit-store-unknown.test.ts",str(p/"z-3292-retention.proof.ts"),str(p/"runner.mjs"),str(p/"types.mjs")]),
]
for name,cmd in commands:
 start=time.monotonic()
 try:
  r=subprocess.run(cmd,capture_output=True,timeout=120)
  out=r.stdout+r.stderr
  if len(out)>262144: raise RuntimeError("output ceiling")
  (p/(name+".log")).write_bytes(out)
  print(json.dumps({"name":name,"status":r.returncode,"seconds":round(time.monotonic()-start,3),"bytes":len(out)}),flush=True)
 except Exception as e:
  (p/(name+".log")).write_text(str(e)); print(json.dumps({"name":name,"error":str(e)}),flush=True)
