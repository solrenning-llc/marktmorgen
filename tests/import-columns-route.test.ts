/**
 * POST /api/store/import-columns, called as the import screen calls it (out-of-family review of #3559 at
 * c720cc496a, MEDIUM 2: the route was checked only as text). The studio guard and the suggestion are synthetic
 * (tests/import-columns-route-world.ts); the readers, the cost pause and the rate limit are the real ones, on the
 * in-memory store. Checked, by status and body:
 *
 *   - the guard is asked for the "import" permission with the 24,000-byte cap, and its refusal is sent as it is;
 *   - an unpaid renewal or a disputed plan payment is refused with 409 before anything is read or counted;
 *   - a kind, header or guess out of shape is 400 "invalid", and nothing is asked;
 *   - the eleventh ask in ten minutes is 429 "slow", and nothing is asked;
 *   - a suggestion is 200 with its columns; a soft refusal is 200 with its reason; "failed" is 502; a throw is 500;
 *     every answer from the suggestion is no-store.
 */
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/import-columns/route";
import { reset, state } from "./import-columns-route-world";
import { done, is, part } from "./check";

const header = ["Correo", "Nombre completo", "Opt-in status"];
const guess = { email: -1, name: 1, tags: -1, consent: -1 };
const good = { kind: "contacts", header, guess };
const request = {} as NextRequest;
let n = 0;
/** A fresh store for each case, so the rate limit of one never counts against another. */
function fresh(body: Record<string, unknown> = good): void {
  reset(`import-columns-${++n}`, body);
}
async function call(): Promise<{ status: number; body: unknown; store: string | null }> {
  const response = await POST(request);
  return { status: response.status, body: await response.json(), store: response.headers.get("Cache-Control") };
}

async function main(): Promise<void> {
  part("The guard");
  fresh();
  state.denial = Response.json({ ok: false, error: "role" }, { status: 403 });
  is("a refusal of the guard is sent as it is, and nothing is asked", [await call(), state.asked.length], [{ status: 403, body: { ok: false, error: "role" }, store: null }, 0]);
  is("it asks for the import permission, the 24,000-byte cap, as the act 'suggest'", state.checks, [{ need: "import", max: 24_000, act: "suggest" }]);

  part("What costs is stopped first");
  fresh();
  state.store.renewalUnpaidSince = 1_700_000_000;
  is("an unpaid renewal: 409 renewal_unpaid, nothing asked", [await call(), state.asked.length], [{ status: 409, body: { ok: false, error: "renewal_unpaid" }, store: null }, 0]);
  fresh({ kind: "nope" });
  state.store.renewalUnpaidSince = 1_700_000_000;
  is("before the body is even read", (await call()).status, 409);

  part("Only names and the guess, in their exact shape");
  for (const [name, body] of [
    ["a kind that is not an import", { ...good, kind: "constructor" }],
    ["a header that is not a list of names", { ...good, header: "Email" }],
    ["an empty header", { ...good, header: [] }],
    ["a guess missing a field", { ...good, guess: { email: 0 } }],
    ["a guess naming a column the file does not have", { ...good, guess: { ...guess, email: 3 } }],
  ] as const) {
    fresh(body as Record<string, unknown>);
    is(`${name}: 400 invalid, nothing asked`, [await call(), state.asked.length], [{ status: 400, body: { ok: false, error: "invalid" }, store: null }, 0]);
  }

  part("Ten asks in ten minutes");
  fresh();
  state.outcome = { ok: false, why: "not_needed" };
  const statuses: number[] = [];
  for (let i = 0; i < 10; i++) statuses.push((await call()).status);
  is("ten asks are answered", [statuses.every((s) => s === 200), state.asked.length], [true, 10]);
  is("the eleventh: 429 slow, and the suggestion is not asked", [await call(), state.asked.length], [{ status: 429, body: { ok: false, error: "slow" }, store: null }, 10]);

  part("What the suggestion said");
  fresh();
  state.outcome = { ok: true, columns: { email: { column: 0, from: "ai" }, name: { column: 1, from: "name" }, tags: { column: -1, from: "none" }, consent: { column: 2, from: "ai" } } };
  is(
    "a suggestion: 200, its columns, no-store; the suggestion got the store, the kind, the names and the guess",
    [await call(), state.asked],
    [
      { status: 200, body: { ok: true, columns: { email: { column: 0, from: "ai" }, name: { column: 1, from: "name" }, tags: { column: -1, from: "none" }, consent: { column: 2, from: "ai" } } }, store: "no-store" },
      [{ sid: `import-columns-${n}`, kind: "contacts", header, guess }],
    ],
  );
  for (const why of ["off", "not_needed", "no_header", "cost_unknown", "used", "unreadable"] as const) {
    fresh();
    state.outcome = { ok: false, why };
    is(`${why}: 200 with its reason, no-store`, await call(), { status: 200, body: { ok: false, error: why }, store: "no-store" });
  }
  fresh();
  state.outcome = { ok: false, why: "failed" };
  is("failed: 502, no-store", await call(), { status: 502, body: { ok: false, error: "failed" }, store: "no-store" });
  fresh();
  state.throws = true;
  const prior = console.error;
  console.error = () => {};
  try {
    is("a throw inside: 500 server_error, never a suggestion", await call(), { status: 500, body: { ok: false, error: "server_error" }, store: null });
  } finally {
    console.error = prior;
  }
}

main().then(done);
