/** Actual askStore/sendYearlyAsks, with inert IO boundaries and real eligibility rules. */
import { askStore, sendYearlyAsks } from "@/lib/yearly-ask";
import { fixture, NOW, owner, reset } from "./yearly-ask-read-world";
import { done, is, part } from "./check";

let visits = 0;
const malformed: [string, () => unknown][] = [
  ["missing", () => []], ["undefined", () => [undefined]], ["extra", () => [0, 0]],
  ["text", () => ["0"]], ["boolean", () => [false]], ["null", () => [null]],
  ["negative", () => [-1]], ["fraction", () => [0.5]],
  ["extra field", () => Object.assign([0], { extra: true })],
  ["symbol", () => Object.assign([0], { [Symbol("extra")]: true })],
  ["inherited", () => { const a = new Array(1); Object.setPrototypeOf(a, { 0: 0 }); return a; }],
  ["accessor", () => { const a = [0]; Object.defineProperty(a, "0", { get() { visits++; return 0; } }); return a; }],
  ["proxy", () => new Proxy([0], { get(t, p, r) { if (p !== "then") visits++; return Reflect.get(t, p, r); } })],
];
async function ask(): Promise<void> { try { await askStore(owner, Date.now() + 20_000, NOW); } catch { /* Unknown may reject, but must have no dependent effects. */ } }
async function main(): Promise<void> {
  part("Unknown EXISTS evidence cannot authorize contacts, a claim, a link or mail");
  for (const [name, shape] of malformed) {
    reset(); fixture.seen = shape(); await ask();
    is(name, [fixture.tokens, fixture.claims, fixture.mints, fixture.mails], [0, 0, 0, 0]);
  }
  part("Only an exact SET NX acknowledgement authorizes the link and mail");
  for (const [name, shape] of malformed) {
    reset(); fixture.claim = shape(); await ask();
    is(name, [fixture.claims, fixture.mints, fixture.mails], [1, 0, 0]);
  }
  reset(); await ask();
  is("confirmed fresh member and claim preserve the successful offer", [fixture.tokens, fixture.claims, fixture.mints, fixture.mails], [1, 1, 1, 1]);
  reset(); fixture.seen = [1]; await ask();
  is("confirmed earlier offer is skipped before contacts", [fixture.tokens, fixture.claims, fixture.mints, fixture.mails], [0, 0, 0, 0]);
  reset(); fixture.claim = [null]; await ask();
  is("confirmed busy claim never mints or sends", [fixture.claims, fixture.mints, fixture.mails], [1, 0, 0]);

  part("Unknown resume evidence never restarts the paid store scan");
  const cursors: [string, unknown][] = [
    ["missing", []], ["extra", ["0|0", null]], ["number", [0]], ["empty", [""]],
    ["partial", ["42"]], ["negative skip", ["42|-1"]], ["unsafe skip", ["42|9007199254740992"]],
    ["fraction skip", ["42|1.5"]], ["extra field", ["42|1|0"]],
  ];
  for (const [name, reply] of cursors) {
    reset(); fixture.cursor = reply;
    try { await sendYearlyAsks(Date.now() + 20_000); } catch { /* Unknown stops this run. */ }
    is(name, [fixture.scans.length, fixture.saves], [0, 0]);
  }
  reset(); await sendYearlyAsks(Date.now() + 20_000);
  is("confirmed absent cursor starts the first scan", fixture.scans, ["0"]);
  reset(); fixture.cursor = ["42|0"]; await sendYearlyAsks(Date.now() + 20_000);
  is("confirmed cursor resumes its own batch", fixture.scans, ["42"]);
  is("no executable reply property was read", visits, 0);
  done();
}
void main().catch(error => { console.error(error); process.exit(1); });
