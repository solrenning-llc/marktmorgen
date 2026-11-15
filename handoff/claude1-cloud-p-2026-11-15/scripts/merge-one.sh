#!/usr/bin/env bash
# Usage: merge-one.sh <PR> <ref> <sha> [target]
# Merges target (default origin/main; for a stacked PR, its parent's prepared head)
# into the PR head in ${WT:-/home/user/wt}. Reservations and generated files take the
# target's version (ALL-203); any other conflict stops for manual work.
set -u
S=/tmp/claude-0/-home-user-marktmorgen/840044e9-b6db-557f-ad53-ac5781de3272/scratchpad
n=$1; ref=$2; sha=$3; target=${4:-origin/main}
cd ${WT:-/home/user/wt} || exit 9
git merge --abort 2>/dev/null
git reset -q --hard && git clean -qfd -e node_modules
git checkout -q --detach "$sha" || exit 9
git merge --no-ff --no-commit "$target" > $S/merge-$n.log 2>&1
for f in $(git diff --name-only --diff-filter=U); do
  case "$f" in
    docs/reservations/*|docs/accessibility-inventory.json|docs/pricing-*|docs/margin-alignment*)
      git checkout --theirs -- "$f" && git add -- "$f" ;;
  esac
done
what="origin/main"; [ "$target" != origin/main ] && what="the updated base branch (which carries origin/main)"
{ echo "Merge $what into $ref"; echo; echo "Reservation and generated files take main's version (ALL-203); both sides kept elsewhere."; cat $S/trailer.txt; } > $S/msg-$n.txt
if [ "$(git diff --name-only --diff-filter=U)" = lib/accessibility-statement.ts ]; then
  # Only the statement's review line: resolve it the reviewed way (fix-statement.sh) and say so.
  if $S/fix-statement.sh; then sed -i '3s|$| lib/accessibility-statement.ts STATEMENT_REVIEW: the later review date of the two sides and the digest of the merged records, as tests/accessibility-statement.test.ts computes it.|' $S/msg-$n.txt; fi
fi
left=$(git diff --name-only --diff-filter=U)
if [ -n "$left" ]; then echo "MANUAL $n: $left"; exit 2; fi
git commit -q -F $S/msg-$n.txt
if git diff --quiet origin/main HEAD; then echo "SUPERSEDED $n (tree equals main)"; exit 3; fi
echo "MERGED $n $(git rev-parse --short=10 HEAD)"
