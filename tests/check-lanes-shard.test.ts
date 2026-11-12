/**
 * The two CI runs of tests/e2e/store-copy.mjs (E2E_SHARD=1/2 and 2/2) split its lanes between them: every lane runs
 * whole, in its order, in exactly one run, and a malformed E2E_SHARD stops the script instead of running a part.
 */
import { lanesOfShard, parseShard } from "./e2e/check-lanes.mjs";
import { done, is, part } from "./check";

const step = (name: string) => ({ name, run: async () => {} });
const lanes = [[step("a1"), step("a2")], [step("b")], [step("c1"), step("c2"), step("c3")], [step("d")]];
const order = ["a1", "b", "c1", "a2", "d", "c2", "c3"];
const ownerOf = (lane: Array<{ name: string }>) => (lane[0].name === "b" || lane[0].name === "c1" ? 2 : 1);
const thrown = (fn: () => unknown) => { try { fn(); return null; } catch (error) { return (error as Error).message; } };

part("parseShard");
is("unset is one run", parseShard(undefined), { index: 1, count: 1 });
is("empty is one run", parseShard(""), { index: 1, count: 1 });
is("2/2", parseShard("2/2"), { index: 2, count: 2 });
for (const bad of ["0/2", "3/2", "1", "1/0", "a/b", " 1/2", "1/2 ", "-1/2", "1.5/2"]) {
  is(`refuses ${JSON.stringify(bad)}`, typeof thrown(() => parseShard(bad)), "string");
}

part("lanesOfShard");
const one = lanesOfShard(lanes, order, { index: 1, count: 2 }, ownerOf);
const two = lanesOfShard(lanes, order, { index: 2, count: 2 }, ownerOf);
is("run 1 keeps its lanes whole and in order", one.lanes.map((lane) => lane.map((c) => c.name)), [["a1", "a2"], ["d"]]);
is("run 2 keeps its lanes whole and in order", two.lanes.map((lane) => lane.map((c) => c.name)), [["b"], ["c1", "c2", "c3"]]);
is("run 1 prints in the listed order", one.order, ["a1", "a2", "d"]);
is("run 2 prints in the listed order", two.order, ["b", "c1", "c2", "c3"]);
is("the two runs together run every check exactly once", [...one.order, ...two.order].sort(), [...order].sort());
is("each run names what the other runs", [one.elsewhere, two.elsewhere], [["b", "c1", "c2", "c3"], ["a1", "a2", "d"]]);
const all = lanesOfShard(lanes, order, { index: 1, count: 1 }, () => 99);
is("one run keeps everything, whatever the owner rule says", [all.lanes.length, all.order, all.elsewhere], [4, order, []]);
is("a lane with no valid owner stops the split", typeof thrown(() => lanesOfShard(lanes, order, { index: 1, count: 2 }, () => 3)), "string");
is("an order missing a check stops the split", typeof thrown(() => lanesOfShard(lanes, order.slice(1), { index: 1, count: 2 }, ownerOf)), "string");
is("a repeated name stops the split", typeof thrown(() => lanesOfShard([[step("x")], [step("x")]], ["x", "x"], { index: 1, count: 2 }, () => 1)), "string");

done();
