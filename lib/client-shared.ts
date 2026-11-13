/**
 * What a creator shares with one client from calls, notes and tasks: 34 [F3]
 * (individual mentoring portal), unit 1. Pure rules, no page, no Redis and no
 * AI; the portal page and the share switch in the studio come in later units.
 *
 * The creator's side already keeps:
 *   - paid calls, read from the creator's Stripe account (lib/calls.ts, paidCalls);
 *   - notes about a person (lib/buyer-profile.ts, PersonNote), private to the team;
 *   - tasks about a person (lib/person-tasks.ts, PersonTask), private to the team.
 *
 * The rules here:
 *   1. A note or a task is private unless the creator marked it shared with
 *      the client in so many words: `sharedWithClient` exactly `true`. Notes
 *      and tasks as they are kept today carry no mark, so none of them is
 *      shown by these rules.
 *   2. A mark that is absent or unreadable ("true", 1, null, ...) is unknown,
 *      and an unknown mark never shows the item (rule 24).
 *   3. A client sees only their own bookings: calls whose buyer address is
 *      theirs. A shared note or task shows only when it is about them AND
 *      tied to one of those bookings.
 *   4. What comes out is a fixed set of fields: nothing of another client,
 *      no address (not even the client's own), no teammate who wrote a note
 *      or is responsible for a task, no payment, answer or host detail.
 *
 * An unknown client, or a list that cannot be read, answers `{ ok: false }`
 * rather than an empty view, so a page never says "nothing shared" when it
 * could not tell (rule 24).
 */
import type { PaidCall } from "@/lib/calls";
import type { PersonNote } from "@/lib/buyer-profile";
import { type PersonTask, parseTasks } from "@/lib/person-tasks";

/** The parts of the portal these rules feed, in the order a page shows them. */
export const CLIENT_SHARED_SECTIONS = ["calls", "notes", "tasks"] as const;

export type ShareState = "shared" | "private" | "unknown";

/** A share mark as kept: exactly `true` shares, exactly `false` keeps it private, anything else is unknown. */
export function shareState(raw: unknown): ShareState {
  if (raw === true) return "shared";
  if (raw === false) return "private";
  return "unknown";
}

/** A paid call as lib/calls.ts reads it; only these fields are looked at. */
export type SharedCallIn = Pick<PaidCall, "session" | "start" | "end" | "title" | "email">;

/** What the creator may mark on a note or task: the booking it belongs to, who it is about, and the share mark. */
type ShareMarks = {
  /** The booking's checkout session (a call's `session`). */
  session?: unknown;
  /** The address of the person it is about, as the caller read it (notes and tasks are kept per person). */
  about?: unknown;
  /** Exactly `true` to show it to that client; anything else keeps it from them. */
  sharedWithClient?: unknown;
};

export type ShareableNote = PersonNote & ShareMarks;
export type ShareableTask = PersonTask & ShareMarks;

export type ClientCall = { session: string; start: number; end: number; title: string };
export type ClientNote = { id: string; session: string; at: number; text: string };
export type ClientTask = { id: string; session: string; text: string; due: string; done: boolean };

export type ClientShared =
  | { ok: true; calls: ClientCall[]; notes: ClientNote[]; tasks: ClientTask[] }
  /** "client": no readable client address; "unreadable": a list, or a call in it, could not be read. */
  | { ok: false; reason: "client" | "unreadable" };

/** A checkout session reference, as lib/calls.ts reads one (paidCall). */
const SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
/** A note's id as lib/buyer-profile.ts makes one. */
const NOTE_ID = /^[0-9a-f]{8}$/;

/** An address as lib/auth.ts normalises one (trimmed, lower case), or null when it is not one. */
function address(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return EMAIL.test(value) ? value : null;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Who each booking belongs to. A call that cannot be read (no session text,
 * an address that is neither text nor null, no real time) makes the whole
 * list unknown: a booking of this client could be the one that was dropped.
 * A booking read twice under two different addresses belongs to nobody.
 */
function owners(calls: readonly SharedCallIn[]): Map<string, { owner: string | null; call: ClientCall }> | null {
  const out = new Map<string, { owner: string | null; call: ClientCall }>();
  for (const raw of calls) {
    if (!raw || typeof raw !== "object") return null;
    const { session, email, start, end, title } = raw as Record<string, unknown>;
    if (typeof session !== "string" || (email !== null && typeof email !== "string") || !finite(start) || !finite(end) || typeof title !== "string") return null;
    if (!SESSION.test(session)) continue;
    const owner = address(email);
    const seen = out.get(session);
    if (seen) {
      if (seen.owner !== owner) seen.owner = null;
      continue;
    }
    out.set(session, { owner, call: { session, start, end, title } });
  }
  return out;
}

/** True when an item is marked shared, is about this client, and belongs to one of their bookings. */
function visible(item: ShareMarks, client: string, own: ReadonlySet<string>): boolean {
  return shareState(item.sharedWithClient) === "shared" && address(item.about) === client && typeof item.session === "string" && own.has(item.session);
}

/**
 * What one client may see of what the creator shared with them. `client` is
 * the client's own address, as the page knows it from their signed-in
 * session; `calls`, `notes` and `tasks` are the creator's, as read for this
 * store.
 */
export function sharedWithClient(input: {
  client: string;
  calls: readonly SharedCallIn[];
  notes: readonly ShareableNote[];
  tasks: readonly ShareableTask[];
}): ClientShared {
  const client = address(input.client);
  if (!client) return { ok: false, reason: "client" };
  if (!Array.isArray(input.calls) || !Array.isArray(input.notes) || !Array.isArray(input.tasks)) return { ok: false, reason: "unreadable" };
  const booked = owners(input.calls);
  if (!booked) return { ok: false, reason: "unreadable" };

  const calls: ClientCall[] = [];
  for (const { owner, call } of booked.values()) if (owner === client) calls.push(call);
  calls.sort((a, b) => a.start - b.start || a.session.localeCompare(b.session));
  const own = new Set(calls.map((call) => call.session));

  const notes: ClientNote[] = [];
  for (const raw of input.notes) {
    if (!raw || typeof raw !== "object" || !visible(raw, client, own)) continue;
    if (typeof raw.id !== "string" || !NOTE_ID.test(raw.id) || typeof raw.text !== "string" || !raw.text.trim()) continue;
    notes.push({ id: raw.id, session: raw.session as string, at: finite(raw.at) ? raw.at : 0, text: raw.text });
  }
  notes.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));

  const tasks: ClientTask[] = [];
  for (const raw of input.tasks) {
    if (!raw || typeof raw !== "object" || !visible(raw, client, own)) continue;
    // The task read as the CRM reads it (lib/person-tasks.ts): one that is not a whole, valid task is not shown.
    const [task] = parseTasks([raw]);
    if (!task) continue;
    tasks.push({ id: task.id, session: raw.session as string, text: task.text, due: task.due, done: task.done });
  }
  // Open before done; within each, the order the creator keeps them in.
  tasks.sort((a, b) => Number(a.done) - Number(b.done));

  return { ok: true, calls, notes, tasks };
}
