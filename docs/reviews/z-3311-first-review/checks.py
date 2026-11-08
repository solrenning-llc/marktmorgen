from pathlib import Path
import json, subprocess, time
p=Path("docs/reviews/z-3311-first-review")
commands=[
 ("types",["node","--max-old-space-size=1024","--require",str((p/"network-guard.cjs").resolve()),str(p/"types.mjs")]),
 ("lint",["node","--max-old-space-size=512","--require",str((p/"network-guard.cjs").resolve()),"node_modules/eslint/bin/eslint.js",'lib/stripe-connect.ts','app/api/stripe/check/route.ts','app/api/stripe/return/route.ts','lib/checkup.ts','lib/checkup-rules.ts','tests/stripe-connect-account-exact.test.ts','docs/reviews/z-3311-first-review/z-3311-shapes.proof.ts','docs/reviews/z-3311-first-review/z-3311-status-unknown.proof.ts',str(p/"runner.mjs"),str(p/"types.mjs")]),
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
