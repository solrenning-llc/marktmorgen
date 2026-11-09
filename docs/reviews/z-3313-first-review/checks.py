from pathlib import Path
import json, subprocess, time
p=Path("docs/reviews/z-3313-first-review")
commands=[
 ("types",["node","--max-old-space-size=1024","--require",str((p/"network-guard.cjs").resolve()),str(p/"types.mjs")]),
 ("lint",["node","--max-old-space-size=512","--require",str((p/"network-guard.cjs").resolve()),"node_modules/eslint/bin/eslint.js",'app/api/backup/files/route.ts','lib/backup-files-contract.ts','lib/backup-files-source.ts','lib/backup-files-r2.ts','lib/backup-files-review.ts','lib/data-families.ts','tests/plan-cost-registry.ts','tests/store-data-registry.ts','tests/backup-files-contract.test.ts','tests/backup-files-route.test.ts','tests/backup-files-off.test.ts','tests/backup-files-r2.test.ts','tests/backup-files-world.ts','tests/backup-files-review-fixture.ts','docs/reviews/z-3313-first-review/z-3313-admission.proof.ts','docs/reviews/z-3313-first-review/z-3313-secret-reuse.proof.ts','docs/reviews/z-3313-first-review/z-3313-r2-xml.proof.ts',str(p/"runner.mjs"),str(p/"types.mjs")]),
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
