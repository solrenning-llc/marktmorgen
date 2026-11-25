/**
 * A buyer asks to move their purchases from a store to another email, and
 * each address confirms by the link emailed to it (611 [WP10], unit 3,
 * 10 November 2026). The rules are lib/purchase-move-rules.ts; the request
 * is kept by lib/purchase-moves.ts.
 *
 * Asking is for a buyer holding a live link to their purchases at this store
 * (lib/buyer-orders.ts ordersGrant): that link is the proof they read the
 * current inbox, as it is for every other buyer action on that page. Every
 * request first holds a public request of the store's buyers' side
 * (lib/traffic.ts), before anything is read, so nobody can make the store
 * read more than it was paid for; it is refused, with nothing read, when the
 * store has no room. Then: at most three attempts an address a day
 * (lib/purchase-moves.ts); an address the store deleted, the current one or
 * the new one, is never contacted and its deletion is not disclosed
 * (lib/suppression.ts: what the person-data registry promises for an
 * `expires` module, "never acted on for a deleted address"). The current
 * address then gets one email with no link, the same words whether or not the
 * new address can be moved to; the new address, unless the store deleted it,
 * gets its link after the answer is sent; and the current address gets its
 * own link only once the new address confirmed. So neither the answer, nor
 * the current inbox, nor the day's count, nor the answer's timing tells the
 * buyer that the new address asked this store to delete it (Codex L on #3621;
 * coordinator's decision (C), 19 November 2026). Each email is taken from the
 * store's access emails before it goes (lib/email.ts, EmailMeter "store",
 * "transactional"; the new address, typed by the buyer, as `asked`, so a
 * stranger's inbox only ever gets a share of them). The sender may answer
 * false after an unknown delivery: every admitted request gets the same
 * neutral notice ("received"), and the new address's Confirm says that the
 * next link is not confirmed ("resend"), never that it did not go.
 *
 * A link opens a page that says what would move, from where to where, and
 * asks for Confirm: opening it confirms nothing (mail scanners open links).
 * Confirm records that address's confirmation once, and only for this
 * store's request. The move itself, once both confirmed, is a later unit;
 * until then lib/purchase-move-open.ts keeps all of this closed.
 *
 * Cost: what each request reads besides the hold is counted below
 * (MOVE_ASK_COMMANDS, MOVE_LINK_COMMANDS, MOVE_CONFIRM_COMMANDS) and held
 * under the public requests it holds (tests/purchase-move-flow.test.ts,
 * line public-requests in tests/plan-cost-registry.ts). The request's own
 * keys are priced with its two emails (tests/store-data-registry.ts,
 * MAIL("purchase-move")).
 */
import { type NextRequest, after } from "next/server";
import { normaliseEmail } from "@/lib/auth";
import { type Store, normaliseHandle, storeForHandle } from "@/lib/store";
import { displayName, ordersGrant, senderAddress } from "@/lib/buyer-orders";
import { sendEmail } from "@/lib/email";
import { suppressedAmong } from "@/lib/suppression";
import { takePublicRequest } from "@/lib/traffic";
import { type MoveSide, type MoveState, moveState, readMoveAddresses } from "@/lib/purchase-move-rules";
import { type MoveAskTo, askPurchaseMove, confirmPurchaseMove, issueMoveLink, readMoveLink, takePurchaseMoveDay } from "@/lib/purchase-moves";
import { PURCHASE_MOVE_DELIVERED, purchaseMoveOpen } from "@/lib/purchase-move-open";
import { type AskState, type ConfirmState, moveWords } from "@/lib/purchase-move-words";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { linkOrigin, originFrom } from "@/lib/request-origin";

/** Public requests an ask holds before it reads. */
export const MOVE_ASK_UNITS = 1;
/** Public requests a link's page, or its Confirm, holds before it reads. */
export const MOVE_LINK_UNITS = 1;
/** Commands an ask makes besides the hold and its emails: the purchases link, the deleted people, the day's count (one script, billed 3: lib/purchase-moves.ts MOVE_DAY_COUNT) and the request with the new address's link (2). */
export const MOVE_ASK_COMMANDS = 7;
/** Commands a link's page reads: the link, the request with both confirmations and the claim (4), the deleted people. */
export const MOVE_LINK_COMMANDS = 6;
/** Commands a Confirm makes: the page's reads, then the link, the request, the mark (with its read-back) and the request again. */
export const MOVE_CONFIRM_COMMANDS = MOVE_LINK_COMMANDS + 1 + 4 + 2 + 4;
/**
 * Commands the new address's Confirm adds when it makes the current address's link (issueMoveLink): the sent mark with
 * its read-back (2), the link (1), and, when its email may not have gone, the link deleted (1) and the mark let go in
 * one script billed as three (lib/redis-lock.ts RELEASE: the EVAL, GET and DEL). Its email is one of the store's
 * access emails, taken from its figure.
 */
export const MOVE_ISSUE_COMMANDS = 2 + 1 + 1 + 3;

const MAX_BODY_BYTES = 2_000;
const sec = (ms: number) => Math.floor(ms / 1000);

/** Whether either address was deleted from this store; "unknown" when that cannot be read whole. */
async function deletedAmong(store: Store, addresses: string[]): Promise<boolean | "unknown"> {
  try {
    return (await suppressedAmong(store.listId, addresses)).size > 0;
  } catch {
    return "unknown";
  }
}

/** The address the purchases link is for, normalised; null when there is none; "unknown" when it cannot be read. */
async function signedIn(store: Store, token: string): Promise<string | null | "unknown"> {
  try {
    const email = await ordersGrant(store, token);
    // Kept as typed at checkout (lib/buyer-orders.ts); the request keeps it as sign-in reads it.
    return email ? normaliseEmail(email) : null;
  } catch {
    return "unknown";
  }
}

export type MoveAskView = { kind: "busy" | "signed-out" | "error" } | { kind: "open"; from: string };

/** What the asking page shows: the address the purchases are on, after holding a public request. */
export async function moveAskView(store: Store, token: string, now = Date.now()): Promise<MoveAskView> {
  if (!(await takePublicRequest(store, "buyer", now, MOVE_ASK_UNITS))) return { kind: "busy" };
  const from = await signedIn(store, token);
  if (from === "unknown") return { kind: "error" };
  return from ? { kind: "open", from } : { kind: "signed-out" };
}

/** A buyer's ask, as the page will say it (lib/purchase-move-words.ts, asked). */
export async function askToMovePurchases(input: { store: Store; token: string; to: string; origin: string; now?: number }): Promise<AskState> {
  const { store } = input;
  const now = input.now ?? Date.now();
  // Held before anything is read: the link, the deleted people, the day's count and the request's writes.
  if (!(await takePublicRequest(store, "buyer", now, MOVE_ASK_UNITS))) return "busy";
  const current = await signedIn(store, input.token);
  if (current === "unknown") return "error";
  if (!current) return "signed-out";
  const addresses = readMoveAddresses(current, input.to);
  if (addresses === "email" || addresses === "same") return addresses;
  let day: Awaited<ReturnType<typeof takePurchaseMoveDay>>;
  try {
    day = await takePurchaseMoveDay(addresses.from, now);
  } catch {
    return "error";
  }
  if (!day.ok) return day.reason === "over" || day.reason === "email" ? day.reason : "error";
  let deleted: Set<string>;
  try {
    deleted = await suppressedAmong(store.listId, [addresses.from, addresses.to]);
  } catch {
    return "error";
  }
  // An erased current address is never contacted, and its deletion is not said either.
  if (deleted.has(addresses.from)) return "received";

  const words = moveWords;
  const from = `"${words.mailFrom(displayName(store.name))}" <${senderAddress()}>`;
  const link = (token: string) => `${input.origin}/@${store.handle}/orders/move/confirm?${new URLSearchParams({ t: token })}`;
  const send = async (message: Parameters<typeof sendEmail>[0]) => {
    try {
      return await sendEmail(message);
    } catch (error) {
      console.error("a purchase move email could not be sent", error);
      return false;
    }
  };
  // The current address hears the same words, in the same step, whether or not the new address can be moved to, and
  // gets no link yet: its link goes only once the new address confirmed (confirmMoveLink). So neither the answer, nor
  // that inbox, nor the day's count, nor the answer's timing tells the buyer that the new address asked this store to
  // delete it (Codex L on #3621, MEDIUM privacy; coordinator's decision (C), 19 November 2026). For an erased new
  // address nothing holding it is written and nothing is sent to it. No delivery is claimed: always "received".
  await send({
    meter: { by: "store", store, kind: "transactional" },
    from,
    to: addresses.from,
    subject: words.heldSubject(store.name),
    text: words.heldText(store.name),
  });
  // For a new address that can be moved to, the request and its link after the answer is sent: the answer waits for
  // the same work either way.
  if (!deleted.has(addresses.to)) {
    await afterAnswer(async () => {
      const asked: MoveAskTo = await askPurchaseMove({ from: addresses.from, to: addresses.to, scope: store.sid, now, day, links: "to" });
      if (!asked.ok) return;
      await send({
        meter: { by: "store", store, kind: "transactional", asked: true },
        from,
        to: addresses.to,
        subject: words.newSubject(store.name),
        text: words.newText(store.name, addresses.from, link(asked.toToken)),
      });
    });
  }
  return "received";
}

/** Runs after the answer is sent when there is a request to wait for (next/server `after`); otherwise now, awaited. */
function afterAnswer(task: () => Promise<void>): Promise<void> {
  const run = () => task().catch((error) => console.error("a purchase move request could not be made", error));
  try {
    after(run);
    return Promise.resolve();
  } catch {
    return run();
  }
}

export type MoveLinkView =
  | { kind: "busy" | "link" | "deleted" | "error" }
  | { kind: "open"; side: MoveSide; from: string; to: string; state: MoveState; confirmed: boolean };

/** What a link is for, at this store, read without confirming anything. */
async function linkAt(store: Store, token: string, now: number): Promise<MoveLinkView> {
  let found: Awaited<ReturnType<typeof readMoveLink>>;
  try {
    found = await readMoveLink(token);
  } catch {
    return { kind: "error" };
  }
  // Only this store's request: a link of another store, or for every store, does nothing here.
  if (!found || found.request.scope.kind !== "store" || found.request.scope.sid !== store.sid) return { kind: "link" };
  const { request, side } = found;
  const deleted = await deletedAmong(store, [request.from, request.to]);
  if (deleted === "unknown") return { kind: "error" };
  if (deleted) return { kind: "deleted" };
  const state = moveState(request, sec(now));
  if (state === "unknown") return { kind: "error" };
  const confirmed = (side === "from" ? request.fromConfirmedAt : request.toConfirmedAt) !== null;
  return { kind: "open", side, from: request.from, to: request.to, state, confirmed };
}

/** What the page a link opens shows, after holding a public request. Confirms nothing. */
export async function moveLinkView(store: Store, token: string, now = Date.now()): Promise<MoveLinkView> {
  if (!(await takePublicRequest(store, "buyer", now, MOVE_LINK_UNITS))) return { kind: "busy" };
  return linkAt(store, token, now);
}

/** Confirm pressed on a link's page: that address's confirmation, recorded once. */
export async function confirmMoveLink(input: { store: Store; token: string; origin?: string; now?: number }): Promise<ConfirmState> {
  const { store, token } = input;
  const now = input.now ?? Date.now();
  if (!(await takePublicRequest(store, "buyer", now, MOVE_LINK_UNITS))) return "busy";
  const found = await linkAt(store, token, now);
  if (found.kind !== "open") return found.kind;
  if (found.state === "expired" || found.state === "done") return found.state;
  let confirmed: Awaited<ReturnType<typeof confirmPurchaseMove>>;
  try {
    confirmed = await confirmPurchaseMove(token, now);
  } catch {
    return "error";
  }
  if (!confirmed.ok) return confirmed.reason === "unknown" ? "error" : confirmed.reason;
  if (confirmed.state === "ready") return "both";
  if (confirmed.state === "done" || confirmed.state === "expired") return confirmed.state;
  // The new address confirmed: now, and only now, the current address gets its link (Codex L on #3621, decision (C)).
  if (confirmed.state === "waiting-from" && confirmed.side === "to") return sendCurrentLink(store, confirmed.id, found, input.origin ?? "", now);
  if (confirmed.state === "waiting-from" || confirmed.state === "waiting-to") return "waiting";
  // "waiting-both" after a confirmation that was kept cannot be read as either: said as an error, never as done.
  return "error";
}

/**
 * The current address's link, made and emailed once the new address confirmed. Pressing Confirm again sends nothing
 * more ("waiting"); an email that may not have gone lets its link go, so the next Confirm sends a new one ("resend").
 */
async function sendCurrentLink(store: Store, id: string, found: Extract<MoveLinkView, { kind: "open" }>, origin: string, now: number): Promise<ConfirmState> {
  const issued = await issueMoveLink(id, "from", now);
  if (!issued.ok) return issued.reason === "sent" ? "waiting" : "error";
  const words = moveWords;
  let sent = false;
  try {
    sent = await sendEmail({
      meter: { by: "store", store, kind: "transactional" },
      from: `"${words.mailFrom(displayName(store.name))}" <${senderAddress()}>`,
      to: found.from,
      subject: words.oldSubject(store.name),
      text: words.oldText(store.name, found.to, `${origin}/@${store.handle}/orders/move/confirm?${new URLSearchParams({ t: issued.token })}`),
    });
  } catch (error) {
    console.error("a purchase move email could not be sent", error);
  }
  if (sent) return "waiting";
  await issued.undo();
  return "resend";
}

/** A form's fields, at most MAX_BODY_BYTES; null when it cannot be read. */
async function fields(request: NextRequest, names: string[]): Promise<Record<string, string> | null> {
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const out: Record<string, string> = {};
    for (const name of names) {
      const value = form.get(name);
      out[name] = typeof value === "string" ? value.slice(0, 400) : "";
    }
    return out;
  } catch {
    return null;
  }
}

/** The store a form names, when the move is open there; a Response to answer otherwise. */
async function storeOf(handle: string, delivered: boolean): Promise<Store | Response> {
  if (!normaliseHandle(handle)) return new Response("Bad request", { status: 400 });
  let store: Store | null;
  try {
    store = await storeForHandle(normaliseHandle(handle));
  } catch {
    return new Response("unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!store || !purchaseMoveOpen(store, delivered)) return new Response("Not found", { status: 404 });
  return store;
}

const away = (location: string) => new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });

/**
 * POST /api/store/purchase-move: the asking page's form (handle, the
 * purchases link's token, the new address). A plain form, so it works
 * without JavaScript; the answer is always the asking page with what
 * happened, and never puts an address in the URL. Not found, with nothing
 * read, while lib/purchase-move-open.ts is closed.
 */
export async function askMoveRoute(request: NextRequest, delivered = PURCHASE_MOVE_DELIVERED): Promise<Response> {
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (!delivered) return new Response("Not found", { status: 404 });
  const form = await fields(request, ["handle", "token", "to"]);
  if (!form) return new Response("Bad request", { status: 400 });
  const store = await storeOf(form.handle, delivered);
  if (store instanceof Response) return store;
  const answer = await askToMovePurchases({ store, token: form.token.slice(0, 200), to: form.to, origin: linkOrigin(request, store) });
  return away(`${originFrom(request)}/@${store.handle}/orders/move?${new URLSearchParams({ token: form.token.slice(0, 200), m: answer })}`);
}

/**
 * POST /api/store/purchase-move/confirm: the Confirm button of the page a
 * link opens (handle, the link's token). Answers with that page and what
 * happened. Not found, with nothing read, while lib/purchase-move-open.ts
 * is closed.
 */
export async function confirmMoveRoute(request: NextRequest, delivered = PURCHASE_MOVE_DELIVERED): Promise<Response> {
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (!delivered) return new Response("Not found", { status: 404 });
  const form = await fields(request, ["handle", "t"]);
  if (!form) return new Response("Bad request", { status: 400 });
  const store = await storeOf(form.handle, delivered);
  if (store instanceof Response) return store;
  const token = form.t.slice(0, 100);
  const answer = await confirmMoveLink({ store, token, origin: linkOrigin(request, store) });
  return away(`${originFrom(request)}/@${store.handle}/orders/move/confirm?${new URLSearchParams({ t: token, c: answer })}`);
}
