import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { SEGMENTS as LISTED, SEGMENT_GROUPS, SHARD_COUNT, assignShards, parseShard, shardFilter } from "./e2e/store-copy-shards.mjs";

// The Firefox and WebKit "Cross-browser" jobs run tests/e2e/store-copy.mjs in
// SHARD_COUNT matrix shards. Coverage must stay identical to the unsharded run:
// every segment in exactly one shard, each shard in the original order, and
// every check call in store-copy.mjs guarded by a segment listed here.
const SEGMENTS = LISTED as [string, number][];
const names = SEGMENTS.map(([name]) => name);
const source = readFileSync("tests/e2e/store-copy.mjs", "utf8");
const workflow = readFileSync(".github/workflows/product-checks.yml", "utf8");
const proof = readFileSync("scripts/ci_full_tree_proof.py", "utf8");

part("Every shard count from 1 to 8 covers every segment exactly once, in run order");
for (let count = 1; count <= 8; count++) {
  const shards = assignShards(count);
  is(`${count}: ${count} shards`, shards.length, count);
  const all = shards.flat();
  is(`${count}: no segment in two shards`, all.length, new Set(all).size);
  is(`${count}: the union is every segment`, [...all].sort(), [...names].sort());
  is(`${count}: each shard keeps the run order`, shards.every((s) => s.join() === names.filter((n) => s.includes(n)).join()), true);
  if (count <= names.length) is(`${count}: no shard is empty`, shards.every((s) => s.length > 0), true);
}

part("The split is deterministic and balanced");
is("the same input gives the same split", JSON.stringify(assignShards(SHARD_COUNT)), JSON.stringify(assignShards(SHARD_COUNT)));
{
  const weight = new Map<string, number>(SEGMENTS);
  const loads = assignShards(SHARD_COUNT).map((s) => s.reduce((sum, n) => sum + weight.get(n)!, 0));
  const heaviest = Math.max(...SEGMENTS.map(([, w]) => w));
  // Longest-processing-time first: no shard exceeds the ideal share by more than one segment.
  const ideal = loads.reduce((a, b) => a + b, 0) / SHARD_COUNT;
  is("no shard is more than one segment above the ideal share", loads.every((l) => l <= ideal + heaviest), true);
}
is("segment names are unique", new Set(names).size, names.length);
is("weights are positive numbers", SEGMENTS.every(([, w]) => Number.isFinite(w) && w > 0), true);
let threw = "";
try { assignShards(0); } catch (error) { threw = String(error); }
is("zero shards is refused", /positive integer/.test(threw), true);
threw = "";
try { assignShards(2, [["a", 1], ["a", 2]]); } catch (error) { threw = String(error); }
is("a repeated segment is refused", /repeat/.test(threw), true);

part("E2E_SHARD is read strictly");
is("unset is the whole run", parseShard(undefined), null);
is("empty is the whole run", parseShard(""), null);
is("2/4", parseShard("2/4"), { index: 2, count: 4 });
for (const bad of ["0/4", "5/4", "2", "2/", "/4", "a/b", " 1/4", "1/4 ", "1/0", "-1/4"]) {
  threw = "";
  try { parseShard(bad); } catch (error) { threw = String(error); }
  is(`${JSON.stringify(bad)} is refused`, threw.includes("E2E_SHARD"), true);
}
{
  const quiet = () => {};
  const whole = shardFilter(undefined, quiet);
  is("without a shard every segment runs", names.every((n) => whole(n)), true);
  threw = "";
  try { whole("checkSomethingNew"); } catch (error) { threw = String(error); }
  is("an unlisted segment throws instead of running nowhere or everywhere", threw.includes("not listed"), true);
  const runs = Array.from({ length: SHARD_COUNT }, (_, i) => shardFilter(`${i + 1}/${SHARD_COUNT}`, quiet));
  is("through take(), every segment runs in exactly one shard", names.every((n) => runs.filter((take) => take(n)).length === 1), true);
}

part("store-copy.mjs guards exactly the listed segments");
{
  const taken = [...source.matchAll(/take\("([^"]+)"\)/g)].map((m) => m[1]);
  is("every listed segment is guarded in the script", [...new Set(taken)].sort(), [...names].sort());
  is("guards appear in the listed order", [...new Set(taken)].join(), names.join());
  // After the studio flow closes, every awaited check runs only behind its own guard.
  const tail = source.slice(source.indexOf('if(take("path-growth"))await checkPostSalePath('), source.indexOf('is("no page threw"'));
  const calls = tail.split("\n").filter((line) => /await (check|capture)\w+\(/.test(line));
  is("every check after the studio flow is guarded", calls.every((line) => /^\s*if\((publicStandardAx2Run\(\)&&)?take\("[^"]+"\)\)await (check|capture)\w+\(/.test(line)), true);
  is("each guard names its own check or a group holding it", calls.every((line) => {
    const [, guard, fn] = /take\("([^"]+)"\)\)await (\w+)\(/.exec(line) ?? [];
    return guard === fn || (SEGMENT_GROUPS[guard] ?? []).includes(fn);
  }), true);
  for (const [group, members] of Object.entries(SEGMENT_GROUPS)) {
    const guarded = calls.filter((line) => line.includes(`take("${group}")`)).map((line) => /await (\w+)\(/.exec(line)?.[1]);
    is(`group ${group} guards exactly its members, in order`, guarded, members);
    is(`group ${group} is a listed segment`, names.includes(group), true);
    is(`no member of ${group} is also its own segment`, members.some((m) => names.includes(m)), false);
  }
  is("the shipment is seeded only where its checks run", /const shipment=take\("shipment"\)&&services\.seedShipment\(/.test(source), true);
  is("the studio flow is one guarded block", /if\(take\("studio-flow"\)\)\{\n\s*const studio = await browser\.newContext/.test(source), true);
  is("the final page-error check runs in every shard", /\n\s*is\("no page threw", errors, \[\]\);/.test(source), true);
}

part("The workflow runs SHARD_COUNT shards per browser and the proof expects their names");
{
  const job = workflow.slice(workflow.indexOf("\n  cross-browser:\n"), workflow.indexOf("\n  all-checks:\n"));
  is("the matrix lists shards 1..SHARD_COUNT", /\n {8}shard: \[([0-9, ]+)\]\n/.exec(job)?.[1], Array.from({ length: SHARD_COUNT }, (_, i) => i + 1).join(", "));
  is("the matrix keeps both browsers", /\n {8}browser: \[firefox, webkit\]\n/.test(job), true);
  is("each job passes its shard", job.includes(`E2E_SHARD: \${{ matrix.shard }}/${SHARD_COUNT}`), true);
  is("each job is named by browser and shard", job.includes(`name: Cross-browser (\${{ matrix.browser }}, \${{ matrix.shard }}/${SHARD_COUNT})`), true);
  is("the runner is still store-copy.mjs on the CI build", job.includes("run: node tests/e2e/store-copy.mjs --no-build"), true);
  is("one failing shard does not cancel the others", job.includes("fail-fast: false"), true);
  is("the full-tree proof uses the same shard count", new RegExp(`\\nCROSS_BROWSER_SHARDS = ${SHARD_COUNT}\\n`).test(proof), true);
  is("the aggregate check still needs cross-browser", /name: All checks \(product-checks\)\n\s+needs: \[[^\]]*\bcross-browser\b/.test(workflow), true);
}

done();
