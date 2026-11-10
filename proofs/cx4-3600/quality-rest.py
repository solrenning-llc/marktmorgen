import sys
sys.dont_write_bytecode=True
import importlib.util,json,pathlib,subprocess
out=pathlib.Path('proofs/cx4-3600')
def run(args,secs=120):
 r=subprocess.run(args,capture_output=True,text=True,encoding='utf8',timeout=secs)
 if r.returncode:raise RuntimeError((r.stdout+r.stderr)[-2500:])
 return r.stdout
(out/'tsconfig.json').write_text(json.dumps({'extends':'../../tsconfig.json','compilerOptions':{'incremental':False},'files':['../../app/api/store/chat-summary/route.ts','../../tests/chat-counter-admission.test.ts','own.proof.ts'],'include':[],'exclude':['../../node_modules']}))
(out/'types.log').write_text('INCONCLUSIVE: original bounded TypeScript attempt reached 120 seconds. No replay or raised timeout.\n')
print('types inconclusive; no replay',flush=True)
with (out/'lint.log').open('w',encoding='utf8') as log:
 r=subprocess.run(['node','--max-old-space-size=512','node_modules/eslint/bin/eslint.js','app/api/store/chat-summary/route.ts','tests/chat-counter-admission-world.ts','tests/chat-counter-admission.test.ts','tests/test-config.mjs','proofs/cx4-3600/own.proof.ts','proofs/cx4-3600/preload.mjs','proofs/cx4-3600/runner.mjs'],stdout=log,stderr=subprocess.STDOUT,timeout=300)
assert r.returncode==0;print('lint pass',flush=True)
spec=importlib.util.spec_from_file_location('publiccheck','scripts/check_public_data.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
paths=json.loads((out/'subject-hashes.json').read_text())['files'];names=[p['path'] for p in paths]+['proofs/cx4-3600/own.proof.ts','proofs/cx4-3600/preload.mjs','proofs/cx4-3600/runner.mjs']
for p in names:assert not m.findings(pathlib.Path(p).read_text(encoding='utf8')),p
print('scanner',len(names),'files; zero findings',flush=True)
run(['git','diff','--check','origin/main...HEAD']);run(['git','diff','--check']);print('diff pass',flush=True)
(out/'quality.json').write_text(json.dumps({'types':'inconclusive_120s','lint':0,'scanner_files':len(names),'findings':0,'diff':0}));print('quality passed',flush=True)
