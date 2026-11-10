from pathlib import Path
r=Path('.git/cx1-review-3062')
s=(r/'lib/affiliate-directory.ts').read_text(encoding='utf8')
old='  const listed = await stillListed(sids as string[]);'
assert s.count(old)==1
new='''  if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row)
    || !Array.isArray(row.products) || !["en", "es", "fr", "de", "it", "nl", "pt"].includes(row.language))) {
    throw new UnknownReplyError("the directory's last display rows");
  }
  const listed = await stillListed(sids as string[]);'''
p=r/'.cx1-evidence/fix/lib/affiliate-directory.ts'
p.parent.mkdir(parents=True,exist_ok=True)
p.write_text(s.replace(old,new),encoding='utf8')
