from pathlib import Path
r=Path('.git/cx1-review-3332')
s=(r/'lib/closed-store-data.ts').read_text()
old='  return typeof ownField(row, "status") === "string" && plainObject(ownField(row, "metadata"));'
new='''  const metadata = ownField(row, "metadata");
  return typeof ownField(row, "status") === "string" && plainObject(metadata)
    && typeof ownField(metadata, "store") === "string" && (ownField(metadata, "store") as string).length > 0;'''
assert s.count(old)==1
p=r/'.cx1-evidence/fix/lib/closed-store-data.ts'
p.parent.mkdir(parents=True,exist_ok=True)
p.write_text(s.replace(old,new))
