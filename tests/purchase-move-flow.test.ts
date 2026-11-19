/**
 * 611 [WP10], unit 3: a buyer asks, from their purchases page, to move their
 * purchases to another email, and each address confirms by its own link.
 *
 * What is checked, on the in-memory database with a stand-in sender: the
 * route answers nothing and reads nothing while lib/purchase-move-open.ts is
 * closed, and refuses another site first; only a buyer holding a live
 * purchases link may ask; a public request of the store is held before
 * anything is read; three a day; the two emails, one to each address, each
 * taken from the store's access emails before it goes, and none (or the
 * second not) when the figure is spent or cannot be read, said as it is;
 * an address the store deleted is never contacted or disclosed when asking,
 * and is refused when confirming;
 * opening a link confirms nothing, pressing Confirm records that address's
 * confirmation once; a link from another store does nothing here; and what
 * each request reads costs less than the public request held for it.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { ordersLinkFor } from "@/lib/buyer-orders";
import { allowanceUsed } from "@/lib/store-allowance";
import { suppressCommand } from "@/lib/suppression";
import { readPurchaseMove } from "@/lib/purchase-moves";
import { MAX_MOVES_PER_ADDRESS_DAY } from "@/lib/purchase-move-rules";
import { PURCHASE_MOVE_DELIVERED } from "@/lib/purchase-move-open";
import { moveWords } from "@/lib/purchase-move-words";
import {
  MOVE_ASK_COMMANDS,
  MOVE_ASK_UNITS,
  MOVE_CONFIRM_COMMANDS,
  MOVE_ISSUE_COMMANDS,
  MOVE_LINK_COMMANDS,
  MOVE_LINK_UNITS,
  askMoveRoute,
  askToMovePurchases,
  confirmMoveLink,
  confirmMoveRoute,
  moveAskView,
  moveLinkView,
} from "@/lib/purchase-move-flow";
import { POST as askPost } from "@/app/api/store/purchase-move/route";
import { POST as confirmPost } from "@/app/api/store/purchase-move/confirm/route";
import { request } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
// A synthetic key the Resend fallback fixture already knows (tests/resend-fixture-credentials.ts).
process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_purchase_move_only_a_stand_in";

const ORIGIN = "https://marktmorgen.com";

/** Every email handed to the sender. */
const mails: { to: string; subject: string; text: string }[] = [];
/** The next `ackLost` emails are taken by the sender, then its answer is lost on the way back. */
let ackLost: { skip: number; times: number } = { skip: 0, times: 0 };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname.includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: [body.to ?? ""].flat()[0] ?? "", subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    if (ackLost.skip > 0) ackLost.skip -= 1;
    else if (ackLost.times > 0) {
      ackLost.times -= 1;
      throw new TypeError("fetch failed: the connection closed after the request was sent");
    }
    return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000000" }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

/** Every command run, with its key, while recording. */
let seen: string[] | null = null;
/** Answers `reply` to `command` on keys starting with `prefix`, the next `times` times. */
let odd: { command: string; prefix: string; reply: unknown; times: number; skip: number } | null = null;
const run = redis.run.bind(redis);
redis.run = (c: (string | number)[]) => {
  seen?.push(`${String(c[0]).toUpperCase()} ${String(c[1] ?? "")}`);
  if (odd && String(c[0]).toUpperCase() === odd.command && String(c[1]).startsWith(odd.prefix)) {
    if (odd.skip > 0) odd.skip -= 1;
    else if (odd.times > 0) {
      odd.times -= 1;
      return odd.reply;
    }
  }
  return run(c);
};

const post = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.70", ...headers },
    body: new URLSearchParams(fields),
  });

const linkIn = (text: string) => /\/@moss\/orders\/move\/confirm\?t=([0-9a-f]{48})/.exec(text)?.[1] ?? null;
const moveKeys = () => redis.keys().filter((k) => k.startsWith("nl:pm:"));
/** The link in the last email to `to` since `from` (an index into mails). */
const linkTo = (to: string, from = 0) => linkIn(mails.slice(from).filter((x) => x.to === to).at(-1)?.text ?? "") ?? "";

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
  const used = () => allowanceUsed(moss, "transactional");
  /** A live purchases link for an address, as the purchase emails make one. */
  const signIn = async (email: string) => {
    const link = await ordersLinkFor(moss, email, `${ORIGIN}/@moss`);
    const token = link ? new URL(link).searchParams.get("token") : null;
    if (!token) throw new Error("no purchases link");
    return token;
  };

  part("Closed until the move itself is built");
  {
    is("the gate is shut", PURCHASE_MOVE_DELIVERED, false);
    const token = await signIn("closed.buyer@example.com");
    const [m, keys] = [mails.length, redis.keys().length];
    const asked = await askPost(post(`${ORIGIN}/api/store/purchase-move`, { handle: "moss", token, to: "closed.new@example.com" }));
    const confirmed = await confirmPost(post(`${ORIGIN}/api/store/purchase-move/confirm`, { handle: "moss", t: "a".repeat(48) }));
    is("the ask route is not there", asked.status, 404);
    is("the confirm route is not there", confirmed.status, 404);
    is("nothing was written and nothing sent", [redis.keys().length - keys, mails.length - m], [0, 0]);
  }

  part("Another site is refused before anything");
  {
    const token = await signIn("cross.buyer@example.com");
    const [m, keys] = [mails.length, redis.keys().length];
    const evil = { origin: "https://evil.example" };
    const asked = await askMoveRoute(post(`${ORIGIN}/api/store/purchase-move`, { handle: "moss", token, to: "cross.new@example.com" }, evil), true);
    const confirmed = await confirmMoveRoute(post(`${ORIGIN}/api/store/purchase-move/confirm`, { handle: "moss", t: "a".repeat(48) }, evil), true);
    is("both refused", [asked.status, confirmed.status], [403, 403]);
    is("nothing was written and nothing sent", [redis.keys().length - keys, mails.length - m], [0, 0]);
  }

  part("Only a buyer with a live purchases link may ask");
  {
    const [m, q] = [mails.length, await used()];
    is("no link", await askToMovePurchases({ store: moss, token: "", to: "new@example.com", origin: ORIGIN }), "signed-out");
    is("an unknown link", await askToMovePurchases({ store: moss, token: "b".repeat(64), to: "new@example.com", origin: ORIGIN }), "signed-out");
    is("no request kept, no email, no store email taken", [moveKeys().length, mails.length - m, (await used()) - q], [0, 0, 0]);
    is("the page says the link expired", await moveAskView(moss, "b".repeat(64)), { kind: "signed-out" });
  }

  part("A public request of the store is held before anything is read");
  {
    const token = await signIn("busy.buyer@example.com");
    seen = [];
    odd = { command: "INCRBY", prefix: "nl:traffic:r:", reply: "not a count", times: 1, skip: 0 };
    const answer = await askToMovePurchases({ store: moss, token, to: "busy.new@example.com", origin: ORIGIN });
    odd = null;
    const read = seen.filter((c) => /nl:(orders:link|erased|pm|allow):/.test(c));
    seen = null;
    is("no room: busy", answer, "busy");
    is("neither the link, the deleted people, a request nor a store email was touched", read, []);
    odd = { command: "INCRBY", prefix: "nl:traffic:r:", reply: "not a count", times: 2, skip: 0 };
    is("the page too", await moveAskView(moss, token), { kind: "busy" });
    is("and a link's page", await moveLinkView(moss, "c".repeat(48)), { kind: "busy" });
    odd = null;
  }

  part("Asking: the current address told with no link, the new address's link, each a store email taken before it goes");
  let fromLink = "";
  let toLink = "";
  {
    const token = await signIn("Ana.Buyer@example.com");
    is("the page shows the address the purchases are on", await moveAskView(moss, token), { kind: "open", from: "ana.buyer@example.com" });
    is("not an address", await askToMovePurchases({ store: moss, token, to: "nope", origin: ORIGIN }), "email");
    is("the same address", await askToMovePurchases({ store: moss, token, to: " ANA.buyer@example.com", origin: ORIGIN }), "same");
    is("neither kept a request", moveKeys().length, 0);

    const [m, q] = [mails.length, await used()];
    seen = [];
    const answer = await askToMovePurchases({ store: moss, token, to: "ana.new@example.com", origin: ORIGIN });
    // The day's count is one script: its EVAL is billed too, besides the INCR and EXPIRE it runs (lib/purchase-moves.ts MOVE_DAY_COUNT).
    const commands = seen.filter((c) => /nl:(orders:link|erased|pm):/.test(c) || c.startsWith("EVAL -- marktmorgen:purchase-move-day:")).length;
    seen = null;
    is("received", answer, "received");
    const sent = mails.slice(m);
    is("one email to each address, the current one first", sent.map((s) => s.to), ["ana.buyer@example.com", "ana.new@example.com"]);
    is("two store access emails taken", (await used()) - q, 2);
    toLink = linkIn(sent[1]?.text ?? "") ?? "";
    is("only the new address gets a link now", [linkIn(sent[0]?.text ?? ""), Boolean(toLink)], [null, true]);
    is("the current address's email names neither the new address nor a link", sent[0]?.text.includes("ana.new@example.com"), false);
    is("the new address's email names the current one", sent[1]?.text.includes("ana.buyer@example.com"), true);
    is("the subjects say what happened and what to do", [sent[0]?.subject, sent[1]?.subject], ["You asked to move your purchases from Moss Notes", "Confirm this address for your purchases from Moss Notes"]);
    is(`what the ask reads and writes is MOVE_ASK_COMMANDS (${MOVE_ASK_COMMANDS})`, commands, MOVE_ASK_COMMANDS);
  }

  part("Opening a link confirms nothing; Confirm records that address once; the current address's link goes after the new one confirms");
  {
    const before = await moveLinkView(moss, toLink);
    is("the new address's link opens on the request", before.kind === "open" ? [before.side, before.from, before.to, before.state, before.confirmed] : before, [
      "to",
      "ana.buyer@example.com",
      "ana.new@example.com",
      "waiting-both",
      false,
    ]);
    const id = moveKeys().find((k) => k.startsWith("nl:pm:r:"))?.slice("nl:pm:r:".length) ?? "";
    is("opening it twice changed nothing", [(await moveLinkView(moss, toLink)).kind, (await readPurchaseMove(id))?.toConfirmedAt], ["open", null]);

    const viaRoute = async (t: string) =>
      (await confirmMoveRoute(post(`${ORIGIN}/api/store/purchase-move/confirm`, { handle: "moss", t }), true)).headers.get("location");
    const [m, q] = [mails.length, await used()];
    is("Confirm on the new address: waiting for the other", await viaRoute(toLink), `${ORIGIN}/@moss/orders/move/confirm?${new URLSearchParams({ t: toLink, c: "waiting" })}`);
    const once = (await readPurchaseMove(id))?.toConfirmedAt;
    is("its confirmation is kept", typeof once, "number");
    is("then, and only then, the current address gets its link, a store email taken", [mails.slice(m).map((x) => x.to), (await used()) - q], [["ana.buyer@example.com"], 1]);
    fromLink = linkTo("ana.buyer@example.com", m);
    is("its own link, naming the new address", [Boolean(fromLink), fromLink !== toLink, mails[m]?.text.includes("ana.new@example.com")], [true, true, true]);
    is("its subject says what to do", mails[m]?.subject, "Confirm moving your purchases from Moss Notes");
    const m2 = mails.length;
    is("pressing again changes nothing and sends nothing more", [await confirmMoveLink({ store: moss, token: toLink, origin: ORIGIN }), (await readPurchaseMove(id))?.toConfirmedAt, mails.length - m2], ["waiting", once, 0]);
    const after = await moveLinkView(moss, toLink);
    is("the new address's page says it confirmed", after.kind === "open" ? [after.confirmed, after.state] : after, [true, "waiting-from"]);
    is("Confirm on the current address: both", await viaRoute(fromLink), `${ORIGIN}/@moss/orders/move/confirm?${new URLSearchParams({ t: fromLink, c: "both" })}`);
    const request = await readPurchaseMove(id);
    is("both kept, nothing moved yet (a later unit)", [typeof request?.fromConfirmedAt, typeof request?.toConfirmedAt, request?.appliedAt], ["number", "number", null]);
  }

  part("A link that does not work here");
  {
    is("unknown", await confirmMoveLink({ store: moss, token: "d".repeat(48) }), "link");
    is("not a link", await confirmMoveLink({ store: moss, token: "nope" }), "link");
    is("its page", await moveLinkView(moss, "d".repeat(48)), { kind: "link" });
    const OTHER = "fern.owner@example.com";
    await claimHandle(OTHER, "fern", "Fern Studio", "");
    await ensureStoreId(OTHER);
    await ensureStatsId(OTHER);
    await setSubscription(OTHER, { customerId: "cus_fern000001", subscriptionId: "sub_fern000001", active: true, tier: "creator", period: paidPeriod() });
    const fern = (await storeForEmail(OTHER)) as Store;
    is("another store's link does nothing here", [await confirmMoveLink({ store: fern, token: fromLink }), await moveLinkView(fern, fromLink)], ["link", { kind: "link" }]);
  }


  part("Neutral answers also when the email allowance is unavailable");
  {
    const token = await signIn("privacy.allowance@example.com");
    const blocked = "privacy.allowance.gone@example.com";
    await redis.pipeline([suppressCommand(moss.listId!, blocked, Math.floor(Date.now() / 1000))]);
    const m = mails.length;
    odd = { command: "INCRBY", prefix: "nl:allow:transactional:",
      reply: "not a count", times: 1, skip: 0 };
    const eligible = await askToMovePurchases({
      store: moss, token, to: "privacy.allowance.fresh@example.com", origin: ORIGIN,
    });
    odd = null;
    const suppressed = await askToMovePurchases({
      store: moss, token, to: blocked, origin: ORIGIN,
    });
    // Decision (C): the asking buyer gets the same neutral email in both cases; the erased address never gets one.
    is("nothing went to the erased address", mails.slice(m).some((x) => x.to === blocked), false);
    is("public results reveal no suppression membership under an email failure", eligible, suppressed);
    is("both use the neutral receipt, not an assertion of delivery", [eligible, suppressed], ["received", "received"]);
    is("the neutral notice makes no delivery promise",
      moveWords.asked[suppressed].title, "Check the new address if this move is available");
  }

  part("An address the store deleted");
  {
    const fresh = await signIn("fresh.buyer@example.com");
    const freshAnswer = await askToMovePurchases({ store: moss, token: fresh, to: "fresh.new@example.com", origin: ORIGIN });
    const token = await signIn("dee.buyer@example.com");
    await redis.pipeline([suppressCommand(moss.listId!, "gone.new@example.com", Math.floor(Date.now() / 1000))]);
    const [m, q, k] = [mails.length, await used(), moveKeys().filter((key) => !key.startsWith("nl:pm:day:")).length];
    const erasedAnswer = await askToMovePurchases({ store: moss, token, to: "Gone.New@example.com", origin: ORIGIN });
    is("an erased destination is indistinguishable from a fresh one", [freshAnswer, erasedAnswer], ["received", "received"]);
    const gone = await signIn("gone.old@example.com");
    await redis.pipeline([suppressCommand(moss.listId!, "gone.old@example.com", Math.floor(Date.now() / 1000))]);
    is("an erased current address is not disclosed either", await askToMovePurchases({ store: moss, token: gone, to: "gone.other@example.com", origin: ORIGIN }), "received");

    const bounded = await signIn("bounded.buyer@example.com");
    await redis.pipeline([suppressCommand(moss.listId!, "bounded.new@example.com", Math.floor(Date.now() / 1000))]);
    const answers: string[] = [];
    for (let i = 0; i < MAX_MOVES_PER_ADDRESS_DAY + 1; i += 1) {
      answers.push(await askToMovePurchases({ store: moss, token: bounded, to: "bounded.new@example.com", origin: ORIGIN }));
    }
    is("suppressed probes use the same daily bound", answers, ["received", "received", "received", "over"]);
    const kept = moveKeys().filter((key) => !key.startsWith("nl:pm:day:")).length;
    // Decision (C): the asking buyers get only the neutral email with no link, one store email each, and nothing goes to
    // an erased address.
    const told = mails.slice(m);
    is("no request or link is made for erased addresses", kept - k, 0);
    is("nothing goes to an erased address", told.some((x) => /gone\.|bounded\.new/.test(x.to)), false);
    is("the asking buyers get only the neutral email, one store email each", [told.every((x) => x.subject === "You asked to move your purchases from Moss Notes" && linkIn(x.text) === null), (await used()) - q], [true, told.length]);

    // Asked first, then deleted before confirming.
    const late = await signIn("late.buyer@example.com");
    const m2 = mails.length;
    is("asked", await askToMovePurchases({ store: moss, token: late, to: "late.new@example.com", origin: ORIGIN }), "received");
    const lateLink = linkTo("late.new@example.com", m2);
    await redis.pipeline([suppressCommand(moss.listId!, "late.new@example.com", Math.floor(Date.now() / 1000))]);
    const marks = () => moveKeys().filter((key) => key.startsWith("nl:pm:c:")).length;
    const c0 = marks();
    is("its page says it can't be made", await moveLinkView(moss, lateLink), { kind: "deleted" });
    is("Confirm is refused", await confirmMoveLink({ store: moss, token: lateLink }), "deleted");
    is("and nothing was confirmed for it", marks() - c0, 0);

    // The deleted people that cannot be read are never "nobody".
    const unread = await signIn("unread.buyer@example.com");
    odd = { command: "HMGET", prefix: "nl:erased:", reply: "not a list", times: 1, skip: 0 };
    is("unreadable: an error, not a move", await askToMovePurchases({ store: moss, token: unread, to: "unread.new@example.com", origin: ORIGIN }), "error");
    odd = null;
  }

  part("Codex L on #3621 (MEDIUM, privacy), decision (C): the asker's inbox does not tell an erased new address apart either");
  {
    // The buyer reads the reply and the current inbox: neither may tell that the new address asked this store to
    // delete it (coordinator's decision (C), 19 November 2026, 01:33 UTC). Nothing holding that address is written.
    await redis.pipeline([suppressCommand(moss.listId!, "same.gone@example.com", Math.floor(Date.now() / 1000))]);
    const requestKeys = () => moveKeys().filter((k) => k.startsWith("nl:pm:r:") || k.startsWith("nl:pm:t:")).length;
    const dayKeys = () => moveKeys().filter((k) => k.startsWith("nl:pm:day:")).length;
    const seenBy = async (buyer: string, to: string) => {
      const token = await signIn(buyer);
      const [m, d, r] = [mails.length, dayKeys(), requestKeys()];
      const answer = await askToMovePurchases({ store: moss, token, to, origin: ORIGIN });
      const sent = mails.slice(m);
      return {
        answer,
        inbox: sent.filter((x) => x.to === buyer).map((x) => ({ subject: x.subject, text: x.text })),
        elsewhere: sent.filter((x) => x.to !== buyer).length,
        day: dayKeys() - d,
        written: requestKeys() - r,
      };
    };
    const normal = await seenBy("same.one@example.com", "same.new@example.com");
    const gone = await seenBy("same.two@example.com", "same.gone@example.com");
    is("the same reply", gone.answer, normal.answer);
    is("the same emails to the current address, word for word", gone.inbox, normal.inbox);
    is("the same day's count", gone.day, normal.day);
    is("the current address gets no link before the new one confirms", normal.inbox.some((x) => linkIn(x.text) !== null), false);
    is("nothing is written or sent for the erased address", [gone.written, gone.elsewhere], [0, 0]);
  }

  part("The current address's link that may not have gone is made again on the next Confirm, and never sent twice");
  {
    const token = await signIn("resend.buyer@example.com");
    const m = mails.length;
    is("asked", await askToMovePurchases({ store: moss, token, to: "resend.new@example.com", origin: ORIGIN }), "received");
    const toLink = linkTo("resend.new@example.com", m);
    const m1 = mails.length;
    ackLost = { skip: 0, times: 1 };
    const first = await confirmMoveLink({ store: moss, token: toLink, origin: ORIGIN });
    ackLost = { skip: 0, times: 0 };
    is("its answer lost: said as not confirmed, never as not sent", [first, /press confirm again/i.test(moveWords.confirmed[first].body)], ["resend", true]);
    const lost = linkTo("resend.buyer@example.com", m1);
    is("the link in that email no longer works, so only one link of the current address ever works", await confirmMoveLink({ store: moss, token: lost, origin: ORIGIN }), "link");
    const m2 = mails.length;
    is("Confirm again: a new link goes", [await confirmMoveLink({ store: moss, token: toLink, origin: ORIGIN }), mails.slice(m2).map((x) => x.to)], ["waiting", ["resend.buyer@example.com"]]);
    const fresh = linkTo("resend.buyer@example.com", m2);
    const m3 = mails.length;
    is("and pressing once more sends nothing", [await confirmMoveLink({ store: moss, token: toLink, origin: ORIGIN }), mails.length - m3], ["waiting", 0]);
    is("the new link confirms the current address: both", await confirmMoveLink({ store: moss, token: fresh, origin: ORIGIN }), "both");
  }

  part("Three a day");
  {
    const token = await signIn("tri.buyer@example.com");
    const answers: string[] = [];
    for (let i = 0; i < MAX_MOVES_PER_ADDRESS_DAY + 1; i += 1) answers.push(await askToMovePurchases({ store: moss, token, to: `tri.new${i}@example.com`, origin: ORIGIN }));
    is("the fourth is refused", answers, ["received", "received", "received", "over"]);
  }

  part("The store's access emails spent or unreadable: said as it is");
  {
    const one = await signIn("spent.buyer@example.com");
    const [m, q] = [mails.length, await used()];
    odd = { command: "INCRBY", prefix: "nl:allow:transactional:", reply: "not a count", times: 1, skip: 0 };
    is("none taken: no email, and the page cannot say more than that it is not confirmed", await askToMovePurchases({ store: moss, token: one, to: "spent.new@example.com", origin: ORIGIN }), "received");
    odd = null;
    is("nothing went to the current address", mails.slice(m).filter((x) => x.to === "spent.buyer@example.com").length, 0);
    const two = await signIn("half.buyer@example.com");
    const m2 = mails.length;
    odd = { command: "INCRBY", prefix: "nl:allow:transactional:", reply: "not a count", times: 1, skip: 1 };
    is("the second not taken: half", await askToMovePurchases({ store: moss, token: two, to: "half.new@example.com", origin: ORIGIN }), "received");
    odd = null;
    is("only the current address was emailed", mails.slice(m2).map((s) => s.to), ["half.buyer@example.com"]);
    is("the store's figure counts only what it took", (await used()) - q >= 1, true);
  }

  part("An email whose answer was lost is unknown, never said as not sent (Codex V on #3621)");
  {
    const one = await signIn("lost.buyer@example.com");
    const m = mails.length;
    ackLost = { skip: 0, times: 1 };
    const first = await askToMovePurchases({ store: moss, token: one, to: "lost.new@example.com", origin: ORIGIN });
    ackLost = { skip: 0, times: 0 };
    is("the current address's email taken, its answer lost: the page does not say it was not sent", [mails.slice(m).filter((x) => x.to === "lost.buyer@example.com").length, first, moveWords.asked[first].title], [1, "received", "Check the new address if this move is available"]);
    const two = await signIn("lost2.buyer@example.com");
    const m2 = mails.length;
    ackLost = { skip: 1, times: 1 };
    const second = await askToMovePurchases({ store: moss, token: two, to: "lost2.new@example.com", origin: ORIGIN });
    ackLost = { skip: 0, times: 0 };
    is("both taken, the second's answer lost: never \"only one link was sent\"", [mails.length - m2, second, /only one link was sent/i.test(moveWords.asked[second].title + moveWords.asked[second].body)], [2, "received", false]);
    is("and the current address's email never says the other link already went", mails.slice(m2, m2 + 1).map((x) => /we also sent/i.test(x.text)), [false]);
  }

  part("Through the route");
  {
    const token = await signIn("route.buyer@example.com");
    const answer = await askMoveRoute(post(`${ORIGIN}/api/store/purchase-move`, { handle: "moss", token, to: "route.new@example.com" }), true);
    is("back to the page with what happened", [answer.status, answer.headers.get("location")], [303, `${ORIGIN}/@moss/orders/move?${new URLSearchParams({ token, m: "received" })}`]);
    is("the new address is never in the URL", answer.headers.get("location")?.includes("route.new"), false);
    const unknown = await askMoveRoute(post(`${ORIGIN}/api/store/purchase-move`, { handle: "nobody", token, to: "route.new@example.com" }), true);
    is("no such store", unknown.status, 404);
  }

  part("What each request reads costs less than the public request held for it");
  {
    is("the ask", request("light", MOVE_ASK_COMMANDS, 4_096) <= MOVE_ASK_UNITS * laterPageCost(), true);
    is("a link's page", request("light", MOVE_LINK_COMMANDS, 4_096) <= MOVE_LINK_UNITS * laterPageCost(), true);
    is("a confirmation", request("light", MOVE_CONFIRM_COMMANDS, 8_192) <= MOVE_LINK_UNITS * laterPageCost(), true);
    is("the new address's confirmation, with the current address's link it makes", request("light", MOVE_CONFIRM_COMMANDS + MOVE_ISSUE_COMMANDS, 8_192) <= MOVE_LINK_UNITS * laterPageCost(), true);
    const token = await signIn("count.buyer@example.com");
    const m = mails.length;
    await askToMovePurchases({ store: moss, token, to: "count.new@example.com", origin: ORIGIN });
    const link = linkTo("count.new@example.com", m);
    const reads = (c: string[]) => c.filter((x) => /nl:(orders:link|erased|pm):/.test(x)).length;
    seen = [];
    await moveLinkView(moss, link);
    const viewed = reads(seen);
    seen = [];
    await confirmMoveLink({ store: moss, token: link, origin: ORIGIN });
    const confirmed = reads(seen);
    seen = null;
    is(`a link's page reads MOVE_LINK_COMMANDS (${MOVE_LINK_COMMANDS})`, viewed, MOVE_LINK_COMMANDS);
    is(`the new address's confirmation at most MOVE_CONFIRM_COMMANDS + MOVE_ISSUE_COMMANDS (${MOVE_CONFIRM_COMMANDS + MOVE_ISSUE_COMMANDS})`, confirmed <= MOVE_CONFIRM_COMMANDS + MOVE_ISSUE_COMMANDS, true);
  }

  done();
}

void main();
