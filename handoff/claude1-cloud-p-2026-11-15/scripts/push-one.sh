#!/usr/bin/env bash
# Usage: push-one.sh <PR>. Pushes prep/<PR> to the PR's branch as a fast-forward, only when the
# branch's remote head is still the one the merge was made on and the result still merges cleanly
# with the newest origin/main. Never forces. Prints PUSHED <PR> <sha10> or why not.
S=/tmp/claude-0/-home-user-marktmorgen/840044e9-b6db-557f-ad53-ac5781de3272/scratchpad
n=$1
cd /home/user/marktmorgen || exit 9
ref=$(awk -v n=$n '$1==n{print $2}' $S/open-prs.txt); old=$(awk -v n=$n '$1==n{print $3}' $S/open-prs.txt)
prep=$(git rev-parse -q --verify refs/heads/prep/$n) || { echo "NOPREP $n"; exit 1; }
remote=$(git ls-remote origin "refs/heads/$ref" | awk '{print $1}')
if [ "$remote" != "$old" ]; then
  # Already pushed by this session (the prep is the remote head), or someone else pushed: never overwrite.
  [ "$remote" = "$prep" ] && { echo "ALREADY $n"; exit 0; }
  echo "MOVED $n remote=${remote:0:10} expected=${old:0:10}"; exit 2
fi
git merge-base --is-ancestor "$old" "$prep" || { echo "NOTFF $n"; exit 3; }
git fetch -q origin main
git merge-tree --write-tree --name-only origin/main "$prep" > $S/mt-push.out 2>&1 || { echo "CONFLICT-NOW $n $(sed -n '2,/^$/p' $S/mt-push.out | tr '\n' ' ')"; exit 4; }
for i in 1 2 3 4; do
  if git push -q origin "$prep:refs/heads/$ref" 2> $S/push-$n.err; then echo "PUSHED $n ${prep:0:10}"; exit 0; fi
  grep -qiE 'rejected|non-fast-forward|fetch first' $S/push-$n.err && { echo "REJECTED $n"; cat $S/push-$n.err; exit 5; }
  sleep $((2 ** i))
done
echo "PUSHFAIL $n"; cat $S/push-$n.err; exit 6
