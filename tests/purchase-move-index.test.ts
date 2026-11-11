/**
 * 611 [WP10], unit 4a: once both addresses confirmed, the move is written,
 * once, into an index of moved addresses that nobody reads yet.
 *
 * What is checked, on the in-memory database with a stand-in sender: only
 * through claimPurchaseMove, only when both confirmed; an address the store
 * deleted is never written; the index switches the purchases from the old
 * address to the new one at one write, so no moment leaves neither with
 * them (the old keeps them until the new has them); a crash midway, at any
 * write, resumes on the next try and never writes twice; a second move of
 * an address already moved elsewhere is refused and gives its room back;
 * the room is taken from the store's data room before anything is
 * written; the creator is told once, from the store's emails, taken before
 * it goes, and told on a later try when the first could not go; and the
 * store deleting either address takes the index's lines with it.
 */
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { suppressCommand } from "@/lib/suppression";
import { askPurchaseMove, confirmPurchaseMove, readPurchaseMove } from "@/lib/purchase-moves";
import { applyPurchaseMove, copyMovedPerson, forgetMovedPerson, readMovedIndex } from "@/lib/purchase-move-index";
import { COPY_PLAN } from "@/lib/person-copy";
import { MOVE_APPLY_COMMANDS, confirmMoveLink } from "@/lib/purchase-move-flow";
import { PURCHASE_MOVE_DELIVERED } from "@/lib/purchase-move-open";
import { ERASERS } from "@/lib/person-erasure";
import { CLOSING, COUNTED_FAMILIES } from "@/lib/data-families";
import { UnknownReplyError } from "@/lib/redis-reply";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
// A synthetic key the Resend fallback fixture already knows (tests/resend-fixture-credentials.ts).
process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_purchase_move_only_a_stand_in";

/** Every email handed to the sender. */
const mails: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname.includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: [body.to ?? ""].flat()[0] ?? "", subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000000" }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

/** Answers `reply` to `command` on keys starting with `prefix`, the next `times` times. */
let odd: { command: string; prefix: string; reply: unknown; times: number } | null = null;
/** Commands run while recording, besides the store's email figure and the sender's own. */
let seen: string[] | null = null;
const run = redis.run.bind(redis);
redis.run = (c: (string | number)[]) => {
  seen?.push(String(c[1] ?? ""));
  if (odd && odd.times > 0 && String(c[0]).toUpperCase() === odd.command && String(c[1]).startsWith(odd.prefix)) {
    odd.times -= 1;
    return odd.reply;
  }
  return run(c);
};

const indexKeys = () => redis.keys().filter((k) => k.startsWith("nl:pm:moved:") || k.startsWith("nl:pm:into:")).sort();
const indexState = () => indexKeys().map((k) => `${k}=${JSON.stringify(redis.run(["TYPE", k]) === "hash" ? redis.run(["HGETALL", k]) : redis.run(["GET", k]))}`);

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "moss.owner@example.com";
  await claimHandle(OWNER, "moss", "Moss Notes", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMoss000001", true);
  await setSubscription(OWNER, { customerId: "cus_moss000001", subscriptionId: "sub_moss000001", active: true, tier: "creator", period: paidPeriod() });
  const moss = (await storeForEmail(OWNER)) as Store;
  const told = () => mails.filter((m) => m.to === OWNER);
  const used = () => allowanceUsed(moss, "email");
  const roomField = (id: string) => redis.keys().some((k) => redis.run(["TYPE", k]) === "hash" && redis.run(["HEXISTS", k, `pm:${id}`]) === 1);
  /** The store's data room in use, as its own record says. */
  const roomTotal = () => {
    const key = redis.keys().find((k) => redis.run(["TYPE", k]) === "hash" && redis.run(["HEXISTS", k, "#"]) === 1 && String(redis.run(["HKEYS", k])).includes("pm:"));
    return key ? Number(redis.run(["HGET", key, "#"])) : null;
  };

  /** A request at this store, with the given sides confirmed through its own links. */
  const asked = async (from: string, to: string, sides: ("from" | "to")[] = ["from", "to"]) => {
    const made = await askPurchaseMove({ from, to, scope: moss.sid });
    if (!made.ok) throw new Error(`not asked: ${made.reason}`);
    for (const side of sides) {
      const confirmed = await confirmPurchaseMove(side === "from" ? made.fromToken : made.toToken);
      if (!confirmed.ok) throw new Error(`not confirmed: ${confirmed.reason}`);
    }
    return made;
  };

  part("Still closed");
  is("the gate is still shut: nobody reads the index yet", PURCHASE_MOVE_DELIVERED, false);
  is("the index is erased with a closing store, and counted in its room", ["nl:pm:moved:", "nl:pm:into:"].map((f) => [CLOSING[f]?.how, COUNTED_FAMILIES.includes(f)]), [["erase", true], ["erase", true]]);
  is("the store deleting a person reaches the index", ERASERS.some((e) => e.module === "lib/purchase-move-index.ts"), true);

  part("Only when both confirmed");
  {
    const one = await asked("una.old@example.com", "una.new@example.com", ["from"]);
    const t0 = told().length;
    is("one confirmation: nothing written", [(await applyPurchaseMove(moss, one.id)).state, indexKeys()], ["not-ready", []]);
    is("an unknown request", (await applyPurchaseMove(moss, "f".repeat(32))).state, "gone");
    is("nobody was told", told().length - t0, 0);
  }

  part("Moved: the new address has the purchases, the old one no longer, and the creator is told once");
  let firstId = "";
  {
    const both = await asked("ana.old@example.com", "ana.new@example.com");
    firstId = both.id;
    const [t0, q0] = [told().length, await used()];
    const result = await applyPurchaseMove(moss, both.id);
    is("moved, and told", result, { state: "moved", told: "sent" });
    is("the old address moved to the new one", await readMovedIndex(moss.sid, "Ana.Old@example.com"), { movedTo: "ana.new@example.com", movedFrom: [] });
    is("the new address holds the old one's purchases", await readMovedIndex(moss.sid, "ana.new@example.com"), { movedTo: null, movedFrom: ["ana.old@example.com"] });
    is("the request is marked moved", typeof (await readPurchaseMove(both.id))?.appliedAt, "number");
    is("its room taken from the store's data room", roomField(both.id), true);
    const notice = told().slice(t0);
    is("one notice to the creator, from the store's emails", [notice.length, (await used()) - q0], [1, 1]);
    is("it names both addresses", [notice[0]?.text.includes("ana.old@example.com"), notice[0]?.text.includes("ana.new@example.com")], [true, true]);
    is("it says refunds stay with the order", /refund/i.test(notice[0]?.text ?? ""), true);
    const [before, room] = [indexState(), roomTotal()];
    is("again: nothing written twice, nobody told twice, no room taken twice", [await applyPurchaseMove(moss, both.id), indexState(), told().length - t0, roomTotal()], [{ state: "moved", told: "already" }, before, 1, room]);
    is("the room is in use", typeof room === "number" && room > 0, true);
  }

  part("A crash at any write resumes, never twice, and never leaves the purchases with nobody");
  for (const [n, [what, command, prefix, reply]] of [
    ["the room", "EVAL", "-- marktmorgen:store-data:v1", "not a receipt"],
    ["the old address's mark", "SET", "nl:pm:moved:", "QUEUED"],
    ["the new address's line", "HSET", "nl:pm:into:", "QUEUED"],
  ].entries()) {
    const old = `crash${n}.old@example.com`;
    const fresh = `crash${n}.new@example.com`;
    const request = await asked(old, fresh);
    const t0 = told().length;
    odd = { command, prefix, reply, times: 1 };
    const first = await applyPurchaseMove(moss, request.id);
    odd = null;
    is(`${what} not answered exactly: unknown, nobody told`, [first.state, told().length - t0], ["unknown", 0]);
    is(`${what}: the old address still has its purchases`, (await readMovedIndex(moss.sid, old)).movedTo, null);
    is(`${what}: and the new one not yet`, (await readMovedIndex(moss.sid, fresh)).movedFrom, []);
    is(`${what}: the next try finishes it`, await applyPurchaseMove(moss, request.id), { state: "moved", told: "sent" });
    is(`${what}: moved once`, [(await readMovedIndex(moss.sid, old)).movedTo, (await readMovedIndex(moss.sid, fresh)).movedFrom], [fresh, [old]]);
    is(`${what}: the creator told once`, told().length - t0, 1);
  }

  part("The index switches at one write: a mark without its line moves nothing");
  {
    const request = await asked("half.old@example.com", "half.new@example.com");
    odd = { command: "HSET", prefix: "nl:pm:into:", reply: [], times: 1 };
    await applyPurchaseMove(moss, request.id);
    odd = null;
    const marked = redis.keys().some((k) => k.startsWith("nl:pm:moved:"));
    is("the old address's mark is written first", marked, true);
    is("but alone it moves nothing", [(await readMovedIndex(moss.sid, "half.old@example.com")).movedTo, (await readMovedIndex(moss.sid, "half.new@example.com")).movedFrom], [null, []]);
  }

  part("An address already moved elsewhere");
  {
    const again = await asked("ana.old@example.com", "ana.other@example.com");
    const t0 = told().length;
    const before = indexState();
    is("refused", await applyPurchaseMove(moss, again.id), { state: "already-moved", told: null });
    is("nothing written, nobody told, its room given back", [indexState(), told().length - t0, roomField(again.id)], [before, 0, false]);
    is("the first move stands", (await readMovedIndex(moss.sid, "ana.old@example.com")).movedTo, "ana.new@example.com");
  }

  part("A move stopped midway leaves no mark alone, and asking again moves it (Claude 3 on #3625, MEDIUM 1)");
  {
    const OLD = "stop.old@example.com";
    const NEW = "stop.new@example.com";
    const slots = () => {
      const key = redis.keys().find((k) => redis.run(["TYPE", k]) === "hash" && redis.run(["HEXISTS", k, "#"]) === 1 && String(redis.run(["HKEYS", k])).includes("pm:"));
      return key ? (redis.run(["HKEYS", key]) as string[]).filter((f) => f.startsWith("pm:")).length : 0;
    };
    const slotsBefore = slots();
    const r1 = await asked(OLD, NEW);
    const t0 = told().length;
    odd = { command: "HSET", prefix: "nl:pm:into:", reply: "QUEUED", times: 1 };
    const first = await applyPurchaseMove(moss, r1.id);
    odd = null;
    is("the line not written exactly: unknown, nobody told", [first.state, told().length - t0], ["unknown", 0]);
    is("nothing of the move is left in the index: no mark alone naming the new address", indexState().some((line) => line.includes(NEW)), false);
    // The buyer does not open the link again within its day: the request, its confirmations and its claim end.
    for (const key of redis.keys().filter((k) => k.includes(r1.id))) redis.run(["DEL", key]);
    const r2 = await asked(OLD, NEW);
    is("asked again, both confirmed: moved, not \"already moved\"", await applyPurchaseMove(moss, r2.id), { state: "moved", told: "sent" });
    is("the old address moved to the new one", (await readMovedIndex(moss.sid, OLD)).movedTo, NEW);
    is("the person's copy says the move that happened", (await copyMovedPerson(moss, OLD)).map((e) => (e as { movedTo?: string }).movedTo), [NEW]);
    is("one room slot for this move in the store's data room, none left for the stopped request", slots() - slotsBefore, 1);
  }

  part("Deleting the new address of a move stopped midway leaves it nowhere (Claude 3 on #3625, MEDIUM 2)");
  {
    const OLD = "erase.old@example.com";
    const NEW = "erase.new@example.com";
    const request = await asked(OLD, NEW);
    odd = { command: "HSET", prefix: "nl:pm:into:", reply: "QUEUED", times: 1 };
    is("stopped midway: unknown", (await applyPurchaseMove(moss, request.id)).state, "unknown");
    odd = null;
    await redis.pipeline([suppressCommand(moss.listId!, NEW, Math.floor(Date.now() / 1000))]);
    await forgetMovedPerson(moss, NEW);
    is("the deleted address is kept nowhere in the index", indexState().some((line) => line.includes(NEW)), false);
    is("and a later try of the move is refused", (await applyPurchaseMove(moss, request.id)).state, "deleted");
  }

  part("A line naming a move in another shape is unknown, never \"not moved\" (Claude 3 on #3625, LOW 4)");
  {
    odd = { command: "HGET", prefix: "nl:pm:into:", reply: "not a move id", times: 1 };
    let threw = false;
    try {
      await readMovedIndex(moss.sid, "ana.old@example.com");
    } catch (error) {
      threw = error instanceof UnknownReplyError;
    }
    odd = null;
    is("throws", threw, true);
  }

  part("An address the store deleted after both confirmed");
  {
    const request = await asked("del.old@example.com", "del.new@example.com");
    await redis.pipeline([suppressCommand(moss.listId!, "del.new@example.com", Math.floor(Date.now() / 1000))]);
    const [t0, before] = [told().length, indexState()];
    is("never written", [await applyPurchaseMove(moss, request.id), indexState()], [{ state: "deleted", told: null }, before]);
    is("nobody told", told().length - t0, 0);
    is("the old address keeps its purchases", (await readMovedIndex(moss.sid, "del.old@example.com")).movedTo, null);
  }

  part("The notice could not go: the move stands, the creator is told on a later try");
  {
    const request = await asked("late.old@example.com", "late.new@example.com");
    const t0 = told().length;
    odd = { command: "INCRBY", prefix: "nl:allow:email:", reply: "not a count", times: 1 };
    is("moved, not told", await applyPurchaseMove(moss, request.id), { state: "moved", told: "unsent" });
    odd = null;
    is("nothing went out", told().length - t0, 0);
    is("the next try tells", await applyPurchaseMove(moss, request.id), { state: "moved", told: "sent" });
    is("once", told().length - t0, 1);
  }

  part("Through the link's Confirm");
  {
    const made = await askPurchaseMove({ from: "flow.old@example.com", to: "flow.new@example.com", scope: moss.sid });
    if (!made.ok) throw new Error("not asked");
    is("the first Confirm waits", await confirmMoveLink({ store: moss, token: made.fromToken }), "waiting");
    is("nothing written yet", (await readMovedIndex(moss.sid, "flow.old@example.com")).movedTo, null);
    is("the second moves", await confirmMoveLink({ store: moss, token: made.toToken }), "both");
    is("written", (await readMovedIndex(moss.sid, "flow.old@example.com")).movedTo, "flow.new@example.com");
    is("pressing again resumes and says it is done", await confirmMoveLink({ store: moss, token: made.toToken }), "done");
  }

  part("What writing a move costs");
  {
    const request = await asked("cost.old@example.com", "cost.new@example.com");
    seen = [];
    await applyPurchaseMove(moss, request.id);
    const commands = seen.filter((k) => k.startsWith("nl:pm:") || k.startsWith("nl:erased:") || k.startsWith("-- marktmorgen:")).length;
    seen = null;
    is(`at most MOVE_APPLY_COMMANDS (${MOVE_APPLY_COMMANDS}), the data room's script billed as four`, commands + 3 <= MOVE_APPLY_COMMANDS, true);
    // Claude 3 on #3625, LOW 3: a later try of the same move reads its request again after the claim says "done".
    seen = [];
    is("a later try of the same move", (await applyPurchaseMove(moss, request.id)).state, "moved");
    const again = seen.filter((k) => k.startsWith("nl:pm:") || k.startsWith("nl:erased:") || k.startsWith("-- marktmorgen:")).length;
    seen = null;
    is(`a later try: at most MOVE_APPLY_COMMANDS (${MOVE_APPLY_COMMANDS}) too, each script's EVAL billed besides what it runs`, again + 3 <= MOVE_APPLY_COMMANDS, true);
  }

  part("Read exactly");
  {
    odd = { command: "GET", prefix: "nl:pm:moved:", reply: 7, times: 1 };
    let threw = false;
    try {
      await readMovedIndex(moss.sid, "ana.old@example.com");
    } catch (error) {
      threw = error instanceof UnknownReplyError;
    }
    odd = null;
    is("a mark that cannot be read throws, never \"not moved\"", threw, true);
    odd = { command: "HGETALL", prefix: "nl:pm:into:", reply: ["odd"], times: 1 };
    threw = false;
    try {
      await readMovedIndex(moss.sid, "ana.new@example.com");
    } catch (error) {
      threw = error instanceof UnknownReplyError;
    }
    odd = null;
    is("a list that cannot be read throws, never \"none\"", threw, true);
  }

  part("The person's own copy of their data says it");
  is("the old address: where it moved", (await copyMovedPerson(moss, "ana.old@example.com")).map((e) => (e as { movedTo?: string }).movedTo), ["ana.new@example.com"]);
  is("the new address: from where", await copyMovedPerson(moss, "ana.new@example.com"), [{ movedFrom: "ana.old@example.com" }]);
  is("the copy's plan names it", COPY_PLAN["lib/purchase-move-index.ts"]?.how, "copied");

  part("The store deleting either address takes the index's lines with it");
  {
    const removed = await forgetMovedPerson(moss, "Ana.New@example.com");
    is("the new address: its line and the mark that named it", removed, 2);
    is("neither address has anything moved now", [await readMovedIndex(moss.sid, "ana.old@example.com"), await readMovedIndex(moss.sid, "ana.new@example.com")], [
      { movedTo: null, movedFrom: [] },
      { movedTo: null, movedFrom: [] },
    ]);
    is("and the room given back", roomField(firstId), false);
    const removedOld = await forgetMovedPerson(moss, "flow.old@example.com");
    is("the old address: its mark and its line", removedOld, 2);
    is("nothing left of that move", (await readMovedIndex(moss.sid, "flow.new@example.com")).movedFrom, []);
    is("neither deleted address is written anywhere in the index now", ["ana.new@example.com", "flow.old@example.com"].map((a) => indexState().join("\n").includes(a)), [false, false]);
    is("an address never moved: nothing", await forgetMovedPerson(moss, "nobody@example.com"), 0);
  }

  done();
}

void main();
