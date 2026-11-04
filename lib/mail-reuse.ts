/**
 * An email that has gone out, used again.
 *
 * A creator writes an email, sends it, and it works. Until now that was the
 * end of it: the people who joined the list the next morning never saw it,
 * and to send it to them the creator had to find it, copy it out and build a
 * sequence by hand. Most never did, so the best thing they had written was
 * read once by whoever happened to be on the list that day.
 *
 * Two things can be done with a sent email, both from the list of what was
 * sent:
 *
 *   Write it again    its subject and text are put back in the composer, as a
 *                     new email, to change and send or schedule.
 *
 *   Keep sending it   it becomes one more email of a sequence, so everybody
 *                     who joins the list from now on gets it by themselves —
 *                     or, when it was written to the people who got one
 *                     product, everybody who gets that product from now on.
 *
 * "Keep sending" invents nothing. It is a sequence (lib/flows.ts) like any
 * other: one the creator can open, reorder, pause or delete under Sequences,
 * counted against the same month of emails, sent only to people who agreed
 * and are still on the list, once each. All this file decides is which
 * sequence the email joins and how long after the one before it.
 *
 * An email written to only some of those people — the ones who have not
 * bought yet, or who do not own another product — keeps that narrowing as
 * the condition of its email in the sequence (lib/flow-rules.ts), read just
 * before it goes, so "you have not bought this yet" never reaches somebody
 * who has. (Until conditions existed, such an email was refused.)
 *
 * What it still refuses, and says so: an email narrowed two ways at once —
 * to buyers of one product who do not own another, say. An email in a
 * sequence carries one condition.
 */
import { readFlowListStrict } from "@/lib/flow-list";
import { MAX_DELAY_HOURS, MAX_FLOW_NAME, MAX_STEPS, type Flow, type FlowResult, saveFlow } from "@/lib/flows";
import { type Broadcast, readBroadcast } from "@/lib/broadcasts";
import type { Store } from "@/lib/store";
import type { StepCondition } from "@/lib/flow-rules";

/** How long after joining (or getting the product) the first kept email goes. */
export const KEEP_FIRST_HOURS = 24;
/** And how long after the one before it each later one goes. */
export const KEEP_GAP_HOURS = 48;

export type KeepRefusal =
  | "unknown"
  /** Scheduled, going out, canceled or stopped: there is nothing proven to repeat. */
  | "unsent"
  /** It was narrowed two ways at once, and an email in a sequence carries one condition. */
  | "excludes"
  /** It was narrowed by spending, a channel, quiet days, a recent purchase or a kind of buyer, which a sequence's step cannot read for each person (lib/segments.ts). */
  | "money"
  /** The same subject and text are already in that sequence. */
  | "already"
  /** That sequence has all the emails one may hold. */
  | "full";

export type KeepPlan =
  | { ok: true; raw: Record<string, unknown>; name: string; waitHours: number; position: number }
  | { ok: false; reason: KeepRefusal };

/** As a sequence stores them (lib/flows.ts, cleanStep), so the same email is recognised as the same. */
const subjectOf = (text: string) => text.replace(/\s+/g, " ").trim();
const bodyOf = (text: string) => text.replace(/\r\n?/g, "\n").trim();

/** The sequence for an email that was written to everybody who has bought something. */
export const KEEP_BUYERS_NAME = "Kept sending to everyone who buys";

/** What the sequence is called, so the creator finds it under Sequences. */
export function keepName(productTitle: string | null): string {
  const name = productTitle ? `Kept sending to everyone who gets ${productTitle}` : "Kept sending to everyone who joins";
  return name.slice(0, MAX_FLOW_NAME);
}

/**
 * Which sequence a sent email joins, and where. No reading and no writing:
 * the caller hands in what is there and saves what comes back.
 *
 * The sequence is the one this made before for the same people (`kept`), so
 * pressing the button on five emails builds one sequence of five, each two
 * days after the last, and not five sequences that all arrive on day one.
 */
export function planKeep(broadcast: Broadcast | null, listId: string | null, flows: Flow[], productTitle: string | null): KeepPlan {
  if (!broadcast || !listId || broadcast.listId !== listId) return { ok: false, reason: "unknown" };
  if (broadcast.status !== "sent") return { ok: false, reason: "unsent" };
  // Whatever narrowed the email beyond what starts the sequence becomes its
  // condition: not owning a product, not having bought yet (everybody who
  // joins includes the ones who join by buying), or, for the buyers of one
  // product, having paid.
  const narrowing: StepCondition[] = [];
  // Spending, a channel and quiet days are read from the store's sales when
  // an email starts, which a sequence's step cannot do for each person.
  if (broadcast.narrow) return { ok: false, reason: "money" };
  if (broadcast.notProductId) narrowing.push({ if: "lacks", productId: broadcast.notProductId });
  if (broadcast.who === "leads") narrowing.push({ if: "lead" });
  if (broadcast.who === "buyers" && broadcast.productId) narrowing.push({ if: "buyer" });
  // Only the people with a label (99 [E2-TAG-BROADCAST]): a sequence's step reads it for each person.
  if (broadcast.label) narrowing.push({ if: "tag", tag: broadcast.label });
  if (narrowing.length > 1) return { ok: false, reason: "excludes" };
  const when = narrowing[0];

  const trigger: Flow["trigger"] = broadcast.who === "buyers" && !broadcast.productId ? "bought" : broadcast.productId ? "product" : "joined";
  const productId = broadcast.productId;
  const subject = subjectOf(broadcast.subject);
  const body = bodyOf(broadcast.body);

  const home = flows.find((f) => f.kept === true && f.trigger === trigger && f.productId === productId) ?? null;
  if (home?.steps.some((s) => s.subject === subject && s.body === body)) return { ok: false, reason: "already" };
  if (home && home.steps.length >= MAX_STEPS) return { ok: false, reason: "full" };

  const last = home?.steps.reduce((most, s) => Math.max(most, s.delayHours), 0) ?? 0;
  const waitHours = home ? Math.min(last + KEEP_GAP_HOURS, MAX_DELAY_HOURS) : KEEP_FIRST_HOURS;
  const name = home?.name ?? (trigger === "bought" ? KEEP_BUYERS_NAME : keepName(productTitle));
  return {
    ok: true,
    name,
    waitHours,
    position: (home?.steps.length ?? 0) + 1,
    raw: {
      ...(home ? { id: home.id } : {}),
      name,
      trigger,
      productId,
      // The creator has just asked for it to be sent: a sequence they paused
      // earlier is switched on again, and the studio says so.
      active: true,
      kept: true,
      steps: [...(home?.steps ?? []), { delayHours: waitHours, subject, body, ...(when ? { when, otherwise: "skip" } : {}) }],
    },
  };
}

export type KeepResult =
  | { ok: true; flows: Flow[]; name: string; waitHours: number; position: number }
  | { ok: false; reason: KeepRefusal | Exclude<FlowResult, { ok: true }>["reason"] };

/** Makes a sent email part of a sequence that sends itself. Under the store's own list only. */
export async function keepSending(
  store: Store,
  broadcastId: string,
  productTitle: (id: string) => Promise<string | null>,
): Promise<KeepResult> {
  const broadcast = await readBroadcast(broadcastId);
  const flows = await readFlowListStrict(store.listId);
  const plan = planKeep(broadcast, store.listId, flows, broadcast?.productId ? await productTitle(broadcast.productId) : null);
  if (!plan.ok) return plan;
  // Every rule a sequence has — the plan, the setup, the product still being
  // there, ten sequences at most — is checked by the one place that saves them.
  // "Keep sending it" is the creator asking for it to go out: an explicit switch on.
  const saved = await saveFlow(store, plan.raw, { activate: true });
  if (!saved.ok) return saved;
  return { ok: true, flows: saved.flows, name: plan.name, waitHours: plan.waitHours, position: plan.position };
}

/** A sent email's subject and text, to write again. Only the store's own. */
export async function copyOf(
  store: Store,
  broadcastId: string,
): Promise<{ subject: string; body: string; productId: string | null; who: Broadcast["who"]; notProductId: string | null; narrow: Broadcast["narrow"]; label?: string } | null> {
  const broadcast = await readBroadcast(broadcastId);
  if (!broadcast || broadcast.id !== broadcastId || !store.listId || broadcast.listId !== store.listId) return null;
  return { subject: broadcast.subject, body: broadcast.body, productId: broadcast.productId, who: broadcast.who, notProductId: broadcast.notProductId, narrow: broadcast.narrow, ...(broadcast.label ? { label: broadcast.label } : {}) };
}
