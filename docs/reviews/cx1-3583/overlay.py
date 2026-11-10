from pathlib import Path
r=Path('.git/cx1-review-3583')
s=(r/'lib/submission-notice.ts').read_text(encoding='utf8')
old='  const message = replyNoticeMessage(input);'
assert s.count(old)==1
s=s.replace(old,'''  const fresh = await recipient(store, to);
  if (fresh !== "open") return fresh;
  const message = replyNoticeMessage(input);''')
s=s.replace('  const went = await send({','  let uncertain = false;\n  const went = await send({')
old='  }).catch(() => false);\n  return went ? "sent" : "unsent";'
assert s.count(old)==1
s=s.replace(old,'  }).catch(() => { uncertain = true; return false; });\n  return uncertain ? "unknown" : went ? "sent" : "unsent";')
p=r/'.cx1-evidence/fix/lib/submission-notice.ts'
p.parent.mkdir(parents=True,exist_ok=True)
p.write_text(s,encoding='utf8')
