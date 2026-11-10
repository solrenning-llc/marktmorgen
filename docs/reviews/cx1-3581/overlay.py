from pathlib import Path
r=Path('.git/cx1-review-3581')
s=(r/'lib/template-text-rules.ts').read_text(encoding='utf8')
old='const MARKED = /⟦[^⟧\\n]*⟧/;'
assert s.count(old)==1
p=r/'.cx1-evidence/fix/lib/template-text-rules.ts'
p.parent.mkdir(parents=True,exist_ok=True)
p.write_text(s.replace(old,'const MARKED = /⟦[^⟧]*⟧/;'),encoding='utf8')
