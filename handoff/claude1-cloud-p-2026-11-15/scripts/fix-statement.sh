#!/usr/bin/env bash
# Resolves a STATEMENT_REVIEW conflict in lib/accessibility-statement.ts (run inside the worktree):
# the later review date of the two sides, and the digest the test computes for the merged records.
S=/tmp/claude-0/-home-user-marktmorgen/840044e9-b6db-557f-ad53-ac5781de3272/scratchpad
f=lib/accessibility-statement.ts
python3 -I - "$f" <<'PY' || exit 1
import re, sys, datetime
p=sys.argv[1]; s=open(p).read()
blocks=list(re.finditer(r'<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n', s, re.S))
if len(blocks)!=1: sys.exit(1)
b=blocks[0]; sides=[b.group(1), b.group(2)]
pat=r'^export const STATEMENT_REVIEW = \{ date: "([A-Za-z]+ \d+, \d{4})", digest: "[0-9a-f]+" \} as const;\n$'
ds=[re.match(pat, x) for x in sides]
if not all(ds): sys.exit(1)
day=max((datetime.datetime.strptime(d.group(1), "%B %d, %Y"), d.group(1)) for d in ds)[1]
s=s[:b.start()]+f'export const STATEMENT_REVIEW = {{ date: "{day}", digest: "0000000000000000" }} as const;\n'+s[b.end():]
open(p,'w').write(s)
PY
want=$(node $S/run-some.mjs "$PWD" accessibility-statement.test.ts 2>&1 | grep -A1 'reviewed on the date it gives' | grep expected | grep -oE '[0-9a-f]{16}')
[ -n "$want" ] || exit 1
sed -i "s/digest: \"0000000000000000\" } as const;/digest: \"$want\" } as const;/" $f
node $S/run-some.mjs "$PWD" accessibility-statement.test.ts > /dev/null 2>&1 || exit 1
git add $f
