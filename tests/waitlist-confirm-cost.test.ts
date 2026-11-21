/**
 * What pressing a waitlist's confirm button costs in database commands, at its worst, against what pays for it
 * (#4404, cost criterion: every charged command named by a line with room). The press (app/api/store/waitlist/
 * confirm/route.ts) reads its link and the store, then confirmSpot reads the link and the entry again, writes the
 * entry back in WAIT_CONFIRM (#4268: one EVAL and the calls inside it, in place of a plain HSET) and, for an address
 * that asked to join the list, runs the fenced sign-up (lib/contacts.ts, at most CONTACT_COMMANDS_MOST.upsertPublic
 * for its first round with the read back of an answer in another shape; each round more pays first, payRound).
 *
 * The page the button is on is a later page, which pays one public request (COMMANDS.laterPage + laterCount);
 * every public request the press takes itself pays as much again. Upstash bills a script as one command plus every
 * redis.call it runs (lib/capped-count.ts), so a script counts at its worst calls, never as 1. The room's own charge
 * scripts (lib/store-data.ts) are priced by the data room's line and left out, as in tests/contacts-write-cost.test.ts.
 * Synthetic only (in-memory Redis stand-in, no email sent).
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { CONTACT_COMMANDS_MOST, CONTACT_FENCED_WRITE_CALLS } from "@/lib/contacts";
import { confirmSpot, joinWaitlist, readWaitToken, setSoon } from "@/lib/waitlist";
import { store as redis } from "./redis-stub";
import { COMMANDS } from "./traffic-cost";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
const sent: string[] = [];

const waitlistSource = readFileSync("lib/waitlist.ts", "utf8");
/** WAIT_CONFIRM's text, as lib/waitlist.ts holds it. */
const waitConfirmText = waitlistSource.match(/const WAIT_CONFIRM = \[([\s\S]*?)\]\.join/)?.[1] ?? "";
/** The most redis.call one run of WAIT_CONFIRM makes, read off its text. */
const waitConfirmCalls = (waitConfirmText.match(/redis\.call\(/g) ?? []).length;
/** The figure lib/waitlist.ts states for it. */
const statedCalls = Number(waitlistSource.match(/export const WAIT_CONFIRM_CALLS = (\d+);/)?.[1] ?? NaN);

/**
 * Commands as Upstash bills them; the public requests taken are counted apart, by what they add to the window, and
 * the sign-up's own (its list's rows, its deleted marks, its fenced write) apart too, to be priced at their figure.
 */
function billed(commands: Commands): { commands: number; taken: number; signUp: number } {
  let total = 0;
  let taken = 0;
  let signUp = 0;
  for (const c of commands) {
    const head = String(c[1] ?? "");
    if (c[0] === "INCRBY" && head.startsWith("nl:traffic:r:")) taken += Number(c[2]);
    if (head.startsWith("nl:store:leads:") || head.startsWith("nl:erased:")) signUp += 1;
    else if (c[0] === "EVAL" && head.startsWith("-- marktmorgen:contact-fenced-write-if:")) signUp += 1 + CONTACT_FENCED_WRITE_CALLS;
    if (c[0] !== "EVAL") total += 1;
    else if (head.startsWith("-- marktmorgen:store-data:")) continue;
    else if (head.startsWith("-- marktmorgen:waitlist-confirm:")) total += 1 + waitConfirmCalls;
    else if (head.startsWith("-- marktmorgen:contact-fenced-write-if:")) total += 1 + CONTACT_FENCED_WRITE_CALLS;
    else total += 1000; // a script this test does not know is not free
  }
  return { commands: total, taken, signUp };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com") {
      sent.push(String((JSON.parse(String(init?.body)) as { text?: string }).text ?? ""));
      return new Response(JSON.stringify({ id: "email_1" }));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  await claimHandle("wait-cost-owner@example.com", "waitcost", "Wait Cost", "");
  await ensureStatsId("wait-cost-owner@example.com");
  await ensureListId("wait-cost-owner@example.com");
  const made = await addProduct("wait-cost-owner@example.com", "The Soon Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail("wait-cost-owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  await setSoon(store, product.id, true);
  const page = COMMANDS.laterPage + COMMANDS.laterCount;

  /** One press as the route makes it: the link and the store, then confirmSpot. */
  async function press(token: string) {
    let commands = 0;
    let taken = 0;
    let signUp = 0;
    redis.pipeline = async (c: Commands) => {
      const b = billed(c);
      commands += b.commands;
      taken += b.taken;
      signUp += b.signUp;
      return real(c);
    };
    let ok: boolean;
    try {
      const grant = await readWaitToken(token);
      const found = grant ? await storeForHandle(grant.h) : null;
      ok = grant ? (await confirmSpot(token, found)).ok : false;
    } finally {
      redis.pipeline = real;
    }
    // At its worst the sign-up's first round is CONTACT_COMMANDS_MOST.upsertPublic (the deleted mark's time read and
    // the read back of an answer in another shape, which a healthy run does not make); each round more pays first.
    const worst = commands - signUp + (signUp > 0 ? CONTACT_COMMANDS_MOST.upsertPublic : 0);
    return { commands, taken, ok, worst, signUp };
  }
  const join = async (email: string, consent: boolean) => {
    is(`(control) ${email} joins`, await joinWaitlist({ store, product, email, consent, ip: "4.4.4.4", origin: "https://marktmorgen.com" }), "sent");
    return sent[sent.length - 1].match(/token=([0-9a-f]{48})/)?.[1] ?? "";
  };

  part("WAIT_CONFIRM is a charged script, stated and named");
  is("(control) WAIT_CONFIRM's text was found", waitConfirmCalls > 0, true);
  is("WAIT_CONFIRM_CALLS is the most redis.call a run of WAIT_CONFIRM makes", statedCalls, waitConfirmCalls);
  const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
  for (const name of ["WAIT_CONFIRM", "WAIT_CONFIRM_CALLS", "WAIT_CONFIRM_UNITS"]) {
    is(`tests/plan-cost-registry.ts names ${name} for lib/waitlist.ts`, new RegExp(`file: "lib/waitlist\\.ts", names: \\[[^\\]]*"${name}"`).test(registry), true);
  }

  part("a press stays inside what pays for it: the page's request and each one the press takes");
  {
    const token = await join("wait-cost-joiner@example.com", true);
    const first = await press(token);
    const worst = first.worst;
    is("(control) the first press confirms, and its sign-up ran within its figure", [first.ok, first.signUp > 0, first.signUp <= CONTACT_COMMANDS_MOST.upsertPublic], [true, true, true]);
    is(`the first press, at its worst (${worst} commands), is inside the page's request and the ${first.taken} it took (${(1 + first.taken) * page})`, worst <= (1 + first.taken) * page, true);
    const again = await press(token);
    is("(control) pressed again, still confirmed", again.ok, true);
    is(`a second press (${again.worst} at its worst) is inside what it pays for (${(1 + again.taken) * page})`, again.worst <= (1 + again.taken) * page, true);
    const quiet = await join("wait-cost-quiet@example.com", false);
    const plain = await press(quiet);
    is("(control) a press without the list's box confirms", plain.ok, true);
    is(`a press without the list's box (${plain.worst}) is inside what it pays for (${(1 + plain.taken) * page})`, [plain.signUp, plain.worst <= (1 + plain.taken) * page], [0, true]);
  }
  done();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
