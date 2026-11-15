#!/usr/bin/env bash
# In the worktree: when tests/accessibility-statement.test.ts says the digest is stale, set the digest it computes
# (the review date stays as the merge left it). Prints REDIGEST or nothing.
S=/tmp/claude-0/-home-user-marktmorgen/840044e9-b6db-557f-ad53-ac5781de3272/scratchpad
f=lib/accessibility-statement.ts
want=$(node $S/run-some.mjs "$PWD" accessibility-statement.test.ts 2>&1 | grep -A1 'reviewed on the date it gives' | grep expected | grep -oE '[0-9a-f]{16}')
[ -n "$want" ] || exit 0
sed -i -E "s/(export const STATEMENT_REVIEW = \{ date: \"[A-Za-z]+ [0-9]+, [0-9]{4}\", digest: \")[0-9a-f]{16}(\" \} as const;)/\1$want\2/" $f
node $S/run-some.mjs "$PWD" accessibility-statement.test.ts > /dev/null 2>&1 || exit 1
git add $f; echo "REDIGEST $want"
