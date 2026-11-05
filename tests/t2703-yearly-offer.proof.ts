/** Independent exact-head review; synthetic boundaries, actual offer flow. */
import { askStore, sendYearlyAsks } from "@/lib/yearly-ask";
import { fixture, NOW, owner, reset } from "./yearly-ask-read-world";
import { done, is, part } from "./check";

async function offered(): Promise<void> {
  try { await askStore(owner, Date.now() + 20_000, NOW); } catch { /* Unknown stops effects. */ }
}

async function main(): Promise<void> {
  part("Additional malformed history and claim slots never authorize effects");
  const malformed = [
    ["nested result", () => [{ result: "OK" }]],
    ["NaN", () => [Number.NaN]],
    ["infinity", () => [Number.POSITIVE_INFINITY]],
    ["wrong string", () => ["OK\n"]],
    ["sparse", () => new Array(1)],
    ["undefined own", () => [undefined]],
  ] as const;
  for (const [name, make] of malformed) {
    reset(); fixture.seen = make(); await offered();
    is(`${name}: no contact read or dependent offer`, [fixture.tokens, fixture.claims, fixture.mints, fixture.mails], [0, 0, 0, 0]);
    reset(); fixture.claim = make(); await offered();
    is(`${name}: claim uncertainty does not mint or mail`, [fixture.claims, fixture.mints, fixture.mails], [1, 0, 0]);
  }

  part("Cursor grammar never normalizes malformed stored evidence");
  for (const value of [undefined, false, {}, "01|0", "42|01", "-1|0", "42|9007199254740992", "42|0|0", " 42|0", "42|0\n"]) {
    reset(); fixture.cursor = [value];
    try { await sendYearlyAsks(Date.now() + 20_000); } catch { /* Unknown remains unknown. */ }
    is(`cursor ${JSON.stringify(value)}`, [fixture.scans, fixture.saves], [[], 0]);
  }

  part("Confirmed history, claims and cursor controls retain their meaning");
  reset(); await offered();
  is("fresh plus OK sends exactly once", [fixture.claims, fixture.mints, fixture.mails], [1, 1, 1]);
  reset(); fixture.seen = [1]; await offered();
  is("confirmed earlier claim stops before contacts", [fixture.tokens, fixture.claims, fixture.mints, fixture.mails], [0, 0, 0, 0]);
  reset(); fixture.claim = [null]; await offered();
  is("NX contention never mints or sends", [fixture.claims, fixture.mints, fixture.mails], [1, 0, 0]);
  reset(); fixture.cursor = ["42|2"]; await sendYearlyAsks(Date.now() + 20_000);
  is("confirmed cursor is passed unchanged", fixture.scans, ["42"]);
  done();
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
