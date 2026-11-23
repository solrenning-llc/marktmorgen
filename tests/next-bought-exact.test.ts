/**
 * Issue #4071 (Codex C2, MEDIUM; rule 24): what buyers bought next (lib/next-bought.ts) is kept as one snapshot and
 * read back by parsePaths, which dropped any count, path or step that did not read and returned the rest as an
 * ordinary reading. get_product_numbers (lib/mcp-tools.ts) then published the survivors as the store's whole "bought
 * next" evidence, so an agent could recommend the wrong follow-up or conclude a product has no path. Now a snapshot
 * with any entry that does not read, in the shape this code writes it, is no reading at all (null): the MCP tool says
 * `bought_next: null` (unavailable), and the studio reads the paths again (pathsStale). A whole snapshot reads as before.
 *
 * Synthetic only.
 */
import { MIN_NEXT, NEXT_KEPT, parsePaths } from "@/lib/next-bought";
import { done, is, part } from "./check";

const step = (id: string, buyers = MIN_NEXT, days = 4) => ({ id, buyers, days });
const whole = { at: 1_700_000_000_000, starts: { prodaaaaaaaa: 7, prodbbbbbbbb: 4 }, next: { prodaaaaaaaa: [step("prodbbbbbbbb"), step("prodcccccccc", 5, 0)] } };

part("A whole snapshot reads as it was written");
is("the same", parsePaths(whole), whole);
is("no paths yet: empty", parsePaths({ at: 1, starts: {}, next: {} }), { at: 1, starts: {}, next: {} });

part("Any entry that does not read: no reading, never the rest of it");
const broken: [string, unknown][] = [
  ["a count that is text", { ...whole, starts: { ...whole.starts, prodbbbbbbbb: "4" } }],
  ["a count of 0", { ...whole, starts: { ...whole.starts, prodbbbbbbbb: 0 } }],
  ["a count that is a fraction", { ...whole, starts: { ...whole.starts, prodbbbbbbbb: 2.5 } }],
  ["a path that is not a list", { ...whole, next: { ...whole.next, prodbbbbbbbb: { id: "prodaaaaaaaa" } } }],
  ["a path with no steps", { ...whole, next: { ...whole.next, prodbbbbbbbb: [] } }],
  ["a step whose buyers are text", { ...whole, next: { prodaaaaaaaa: [step("prodbbbbbbbb"), { id: "prodcccccccc", buyers: "3", days: 1 }] } }],
  ["a step under the least buyers", { ...whole, next: { prodaaaaaaaa: [step("prodbbbbbbbb", MIN_NEXT - 1)] } }],
  ["a step with negative days", { ...whole, next: { prodaaaaaaaa: [step("prodbbbbbbbb", MIN_NEXT, -1)] } }],
  ["a step that is null", { ...whole, next: { prodaaaaaaaa: [step("prodbbbbbbbb"), null] } }],
  ["more steps than are kept", { ...whole, next: { prodaaaaaaaa: Array.from({ length: NEXT_KEPT + 1 }, (_, i) => step(`prod${i}aaaaaaa`)) } }],
  ["the counts are not an object", { ...whole, starts: [7] }],
  ["the paths are not an object", { ...whole, next: "x" }],
  ["no counts", { at: whole.at, next: whole.next }],
  ["no paths", { at: whole.at, starts: whole.starts }],
];
for (const [label, value] of broken) is(`${label}: null`, parsePaths(value), null);

done();
