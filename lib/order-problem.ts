/**
 * "Report a problem with this order" (567 [GD1] (a), unit 2): a buyer's
 * report is filed in the creator's inbox, and the creator is told by email.
 * The rules (reasons, the note, the seven days, the case's words) are in
 * lib/order-problem-rules.ts; the route is app/api/store/order-problem.
 *
 * One open case per order: the mark
 *
 *   nl:oprob:<sid>:<reference>   "pending" for PENDING_SECONDS while it is filed, then
 *                                "filed:<conversation id>" for the seven days
 *
 * is taken with SET NX before anything is filed, so two clicks never file
 * two cases. The conversation's id is kept so the seven days' check can tell
 * whether the creator answered. A report of an order whose case is open is
 * answered from the mark alone. The mark's bytes are counted in the store's
 * data room once it is ours and before anything is filed, and it goes by
 * itself. A filing that fails gives the mark back;
 * if even that fails, the "pending" mark ends by itself after a few minutes,
 * so a buyer is never told a case was filed when it was not.
 *
 * Cost: one inbox message from the store's own allowance (lib/inbox.ts,
 * open: takeAllowance before it is written), and the creator's notice from
 * the store's own email figure (tellTeam, at most one per conversation per
 * half hour). No model call. An unknown reply from Redis is an error, never
 * "filed" and never "already".
 */
import { dataBytes } from "@/lib/store-data-rules";
import { takeData } from "@/lib/store-data";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { fileOrderProblem } from "@/lib/inbox";
import { CONVERSATION_ID } from "@/lib/inbox-rules";
import type { Store } from "@/lib/store";
import type { Purchase } from "@/lib/buyer-orders";
import { ORDER_PROBLEM_REPLY_DAYS, type OrderProblem, caseText, replyDueAt } from "@/lib/order-problem-rules";

/** How long a filing in progress holds the order's mark before it ends by itself. */
export const ORDER_PROBLEM_PENDING_SECONDS = 300;

export const orderProblemKey = (sid: string, reference: string) => `nl:oprob:${sid}:${reference}`;

/**
 * "filed": in the creator's inbox, and the creator told; "already": this
 * order has an open case; "busy": a report of this order is being filed right
 * now; "limited": the store's inbox takes no more today; "full": the store's
 * data room is full; "error": nothing could be confirmed, nothing is said as
 * filed.
 */
export type ReportOutcome = "filed" | "already" | "busy" | "limited" | "full" | "error";

export async function reportOrderProblem(
  store: Store,
  purchase: Pick<Purchase, "reference" | "title" | "paidAt">,
  email: string,
  problem: OrderProblem,
  nowMs = Date.now(),
): Promise<ReportOutcome> {
  if (!store.sid || !isRedisConfigured() || problem.reference !== purchase.reference) return "error";
  const due = replyDueAt(nowMs);
  const text = caseText(problem, { title: purchase.title, paidAt: purchase.paidAt }, nowMs);
  if (due === null || !text) return "error";
  const key = orderProblemKey(store.sid, purchase.reference);

  // An open case answers before anything is taken; an unreadable mark is not known.
  const seen = await readMark(key);
  if (seen === "unknown") return "error";
  if (seen === "filed") return "already";
  if (seen === "pending") return "busy";

  let claim: unknown[] | null;
  try {
    claim = repliesFor(await redisPipeline([["SET", key, "pending", "NX", "EX", ORDER_PROBLEM_PENDING_SECONDS]]), 1);
  } catch {
    return "error";
  }
  if (!claim) return "error";
  if (claim[0] === null) {
    // Taken in the meantime: what it says decides the answer; anything else is not known.
    const now = await readMark(key);
    return now === "filed" ? "already" : now === "pending" ? "busy" : "error";
  }
  if (claim[0] !== "OK") return "error";

  // The room only once the mark is ours, so a report that lost the race takes none. A mark that expires by itself is
  // never given back early (lib/store-data.ts, giveData): a filing that then fails keeps it to the end of its month.
  const room = await takeData(store, [{ until: due, bytes: dataBytes([key, `filed:${"0".repeat(12)}`]) }], nowMs).catch(() => null);
  if (!room?.ok) {
    await redisPipeline([["DEL", key]]).catch(() => null);
    return room?.ok === false && room.reason === "full" ? "full" : "error";
  }

  const filed = await fileOrderProblem({ store, email, text, now: nowMs }).catch((error) => {
    console.error("filing a problem with an order failed", error);
    return "error" as const;
  });
  if (filed === "error" || filed.state !== "filed") {
    // Given back so the buyer can try again; if this fails too, the pending mark ends by itself.
    await redisPipeline([["DEL", key]]).catch(() => null);
    return filed === "error" ? "error" : filed.state;
  }
  let kept: unknown[] | null = null;
  try {
    kept = repliesFor(await redisPipeline([["SET", key, `filed:${filed.id}`, "XX", "EX", ORDER_PROBLEM_REPLY_DAYS * 86_400]]), 1);
  } catch {
    kept = null;
  }
  // The case is in the inbox either way; only the guard against a second case may end early.
  if (!kept || kept[0] !== "OK") console.error("a problem with an order was filed but its mark could not be kept");
  return "filed";
}

/** What an order's mark says: none, a filing in progress, an open case, or not known (no reply, or one of another shape). */
async function readMark(key: string): Promise<"none" | "pending" | "filed" | "unknown"> {
  let read: unknown[] | null;
  try {
    read = repliesFor(await redisPipeline([["GET", key]]), 1);
  } catch {
    return "unknown";
  }
  if (!read) return "unknown";
  const value = read[0];
  if (value === null) return "none";
  if (value === "pending") return "pending";
  if (typeof value === "string" && value.startsWith("filed:") && CONVERSATION_ID.test(value.slice(6))) return "filed";
  return "unknown";
}
