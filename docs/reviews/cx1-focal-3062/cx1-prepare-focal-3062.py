from pathlib import Path
import hashlib,json
r=Path('.git/cx1-focal-3062')
old=Path('.git/cx1-review-3062/tests/cx1-directory-last-shape.proof.ts').read_bytes()
(r/'tests/cx1-directory-last-shape.proof.ts').write_bytes(old)
src=(r/'tests/directory-assembly-ceiling.test.ts').read_text(encoding='utf8')
start=src.index('  part("A save every second for twenty minutes:')
end=src.index('  part("Past the ceiling:',start)
(r/'tests/cx1-directory-author-bounded.proof.ts').write_text(src[:start]+src[end:],encoding='utf8')
print(json.dumps({'proof_sha256':hashlib.sha256(old).hexdigest(),'omitted_chars':end-start,'ledger':json.loads(Path('.git/cx1-3062-ledger.json').read_text())}))
