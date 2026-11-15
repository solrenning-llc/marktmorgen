#!/usr/bin/env bash
# Runs the whole unit suite (tests/run.mjs, 4 shards in parallel) on prep/<PR> for each PR given,
# in /home/user/wt3, and writes "<PR> FULL ok|FAIL <failing files>" to full.txt.
S=/tmp/claude-0/-home-user-marktmorgen/840044e9-b6db-557f-ad53-ac5781de3272/scratchpad
cd /home/user/wt3 || exit 9
for n in "$@"; do
  grep -q "^$n FULL" $S/full.txt 2>/dev/null && continue
  git reset -q --hard; git clean -qfd -e node_modules
  r=prep/$n; [ "$n" = main ] && r=origin/main
  git checkout -q --detach $r || { echo "$n FULL NOPREP" >> $S/full.txt; continue; }
  for k in 1 2 3 4; do TEST_SHARD=$k/4 node tests/run.mjs > $S/full-$n-$k.log 2>&1 & done
  wait
  fails=$(cat $S/full-$n-?.log | awk '/^=== /{f=$2} /^not ok|  FAIL |exited with|timed out/{print f}' | sort -u | tr '\n' ' ')
  bad=$(grep -l 'test file(s) failed\|Browser bundles: .* passed' $S/full-$n-?.log | xargs grep -l 'test file(s) failed' 2>/dev/null)
  if [ -z "$bad" ]; then echo "$n FULL ok $(rev=$(git rev-parse --short=10 HEAD); echo $rev)" >> $S/full.txt
  else echo "$n FULL FAIL $(git rev-parse --short=10 HEAD) $fails" >> $S/full.txt; fi
done
echo "FULL RUNNER DONE $*" >> $S/full.txt
