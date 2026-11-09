/**
 * A member's way out of a membership a store sold (ALTO 2 of the audit of the
 * subscriptions creators sell, 9 November 2026): Cancel, Stripe's billing
 * page, Pause or Resume, the pages that list them, and the emailed link to
 * them. The store's month of requests and its access-email figure count them,
 * but never refuse them: a store that has used its month must not keep a
 * member in a charge they want to stop (lib/membership-manage.ts).
 *
 * What one is taken from, in order:
 *
 *   - the store's own figure, as before (its window of buyer requests, or its
 *     access emails), while it has room;
 *   - past it, figures of its own, each confirmed before any work, and fail
 *     closed when a count cannot be made: one member (one customer on the
 *     creator's account) a day, and the store a month. The store's month is
 *     what tests/plan-cost-registry.ts prices (line member-exit), inside each
 *     plan's worst month.
 *
 * Before either, every press is counted per connection a day
 * (EXIT_PER_CONNECTION_DAY) and the emailed link is read, so an invented link
 * spends nothing of the store's (exitConnection, in lib/membership-manage.ts
 * admitManage).
 */
import { headers } from "next/headers";
import { allowanceWindow } from "@/lib/allowance-window";
import { type LimitState, clientAddress, essentialLimitState } from "@/lib/request-guard";
import type { Store } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { EXIT_LINKS_PER_STORE_MONTH, EXIT_PER_CONNECTION_DAY, EXIT_PER_MEMBER_DAY, EXIT_PRESSES_PER_STORE_MONTH } from "@/lib/essential-exit-rules";

/** A day, the window of the connection's and the member's counts. */
const DAY_SECONDS = 86_400;
/** Longer than any store window (lib/allowance-window.ts); the key also names the window, so a month holds one. */
const MONTH_SECONDS = 32 * DAY_SECONDS;

/** Room, no room past the store's figure ("daily": the notice of that name), or a count that could not be made. */
export type ExitAdmission = "ok" | "daily" | "unknown";

const admission = (state: LimitState): ExitAdmission => (state === "within" ? "ok" : state === "exceeded" ? "daily" : "unknown");

/** One press or page on the way out from this connection, counted before the link is read. */
export async function exitConnection(store: Pick<Store, "handle">, address: string): Promise<ExitAdmission> {
  return admission(await essentialLimitState("exit-ip", `${address}|${store.handle}`, EXIT_PER_CONNECTION_DAY, DAY_SECONDS));
}

/**
 * Past the store's own figure: the member's day, then the store's month of
 * `kind`. The member's is asked first, so one member cannot use up the store's.
 */
export async function pastFigure(store: Store, member: string, kind: "press" | "link", now = Date.now()): Promise<ExitAdmission> {
  const own = admission(await essentialLimitState("exit-member", `${kind}|${member}`, EXIT_PER_MEMBER_DAY, DAY_SECONDS));
  if (own !== "ok") return own;
  const window = allowanceWindow(store, now);
  if (!window) return "unknown";
  const most = kind === "press" ? EXIT_PRESSES_PER_STORE_MONTH : EXIT_LINKS_PER_STORE_MONTH;
  return admission(await essentialLimitState("exit-store", `${kind}|${store.sid || store.handle}|${window.id}`, most, MONTH_SECONDS));
}

/**
 * One press or page on the way out, for a member whose link was read: one of
 * the store's buyer requests while its window has room, else pastFigure.
 */
export async function admitExit(store: Store, member: string, now = Date.now()): Promise<ExitAdmission> {
  let room: boolean;
  try {
    room = await takePublicRequest(store, "buyer", now);
  } catch {
    // A count that came back in a shape that cannot be read (#3068): not known, never room and never "used".
    return "unknown";
  }
  return room ? "ok" : pastFigure(store, member, "press", now);
}

/**
 * A member's page reached by a link of another kind (a card link, lib/card-update.ts): counted per connection, then
 * as admitExit for the member the link names. The link is read by the caller first; what it reads is one GET.
 */
export async function admitMemberPage(store: Store, address: string, member: string): Promise<ExitAdmission> {
  const door = await exitConnection(store, address);
  return door === "ok" ? admitExit(store, member) : door;
}

/** The connection a member's page is drawn for, as clientAddress reads it; "unknown" outside a request (a test, a build). */
export async function pageAddress(): Promise<string> {
  try {
    return clientAddress({ headers: await headers() });
  } catch {
    return "unknown";
  }
}
