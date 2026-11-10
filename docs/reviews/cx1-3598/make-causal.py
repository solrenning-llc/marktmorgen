from pathlib import Path
b=Path(__file__).resolve().parent;r=b/'cx1-review-3598'
s=(r/'lib/move-members.ts').read_text(encoding='utf8')
valid='["active", "trialing", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]'
old='if (typeof status !== "string") return null;'
assert s.count(old)==1
s=s.replace(old,'if (typeof status !== "string" || !'+valid+'.includes(status)) return null;\n        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || Object.values(metadata).some((value) => typeof value !== "string")) return null;')
old='    if (list.some((s) => LIVE.has(String(s.status)) && s.metadata?.product === productId)) return true;'
assert s.count(old)==1
s=s.replace(old,'    if (list.some((s) => !s || typeof s !== "object" || typeof s.status !== "string" || !'+valid+'.includes(s.status) || !s.metadata || typeof s.metadata !== "object" || Array.isArray(s.metadata) || Object.values(s.metadata).some((value) => typeof value !== "string"))) throw new Error("unknown membership row");\n'+old)
target=r/'.cx1-causal/lib/move-members.ts';target.parent.mkdir(parents=True,exist_ok=True)
target.write_text(s,encoding='utf8',newline='\n')
print('causal overlay only; not a proposed production fix, no added requests',flush=True)
