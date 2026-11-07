/**
 * The sign-up box on a store page: an address joins the creator's list
 * (lib/contacts.ts) only once the button in the email it is sent has been
 * pressed. So every address on the list is one somebody holds, nobody is
 * signed up by a stranger, and a page that shows the button — not the link
 * itself — is what confirms, because mail scanners open links on their own.
 *
 *   nl:join:t:<sha(token)>  string  who asked to join which store, 7 days
 *
 * Asking is limited per connection and per inbox, as the free copies and the
 * waitlists are, so the form cannot be used to flood anybody's inbox. Nothing
 * is read or written on a plain visit to the store page.
 */
import { withinStore } from "@/lib/metered-limits";
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { DataRoomError } from "@/lib/store-data";
import { withinEssentialLimit } from "@/lib/request-guard";
import { isPaidUp } from "@/lib/billing";
import { type AddResult, upsertContact } from "@/lib/contacts";
import type { Store } from "@/lib/store";
import { isHouseStore } from "@/lib/house-store";
import { joinWords } from "@/lib/buyer-words/join";
import { givingWords } from "@/lib/buyer-words/giving";
import { noteForErasure } from "@/lib/erasure-index";

export const JOIN_SECONDS = 7 * 24 * 60 * 60;
export const JOIN_TOKEN = /^[0-9a-f]{48}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenKey = (token: string) => `nl:join:t:${sha(`nimbus-join:${token}`)}`;

/** `k`: they also allowed their link use in sequences to be seen (lib/mail-clicks.ts). */
/** `f`: the store's form it was asked from (lib/forms.ts), so a sequence that starts with that form starts on confirming. */
/** `w`: the creator's own site it was asked from, through the checkout script (lib/embed-sites.ts), for the list.joined webhook. */
/** `f`: the form it came from; `r`: that form's quiz result for them, so a workflow for one result starts on confirming. */
/** `a`: the affiliate the visit was credited to, when the store pays per sign-up (lib/affiliate-leads.ts): credited only on confirming. */
type Grant = { s: string; h: string; e: string; at: string; k?: boolean; f?: string; r?: string; w?: string; a?: string };

/**
 * Whether this store's page shows the box and takes sign-ups: switched on, a
 * list to join, a subscription in good standing and email to send with. Never
 * the demo store, which writes to nobody (lib/house-store.ts): a form anybody
 * can fill in must never be a way to send somebody an email.
 */
export function joinOpen(store: Store): boolean {
  return store.join.on && listOpen(store);
}

/**
 * Whether an address can be asked to join this store's list at all: a list
 * to join, a subscription in good standing and email to send with. The
 * sign-up box needs this and its switch; a form that offers the list
 * (lib/forms.ts) needs this alone, because offering it is the form's own
 * setting.
 */
export function listOpen(store: Store): boolean {
  return !isHouseStore(store) && !store.suspended && Boolean(store.listId) && Boolean(store.statsId) && isPaidUp(store) && isRedisConfigured() && isSenderConfigured();
}

function sender(store: Store): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  const address = (match ? match[1] : NIMBUS_FROM).trim();
  const name = store.name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
  return `"${name} via Marktmorgen" <${address}>`;
}

export type JoinResult = "sent" | "email" | "limited" | "closed" | "error";

/** Emails a button to confirm. Nothing is added to the list here. */
export async function askToJoin(input: { store: Store; email: string; clicks?: boolean; ip: string; origin: string; fromForm?: boolean; formId?: string; formOutcome?: string; site?: string; lead?: string | null }): Promise<JoinResult> {
  const { store, ip, origin } = input;
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!(input.fromForm ? listOpen(store) : joinOpen(store)) || !store.statsId) return "closed";
  const email = normaliseEmail(raw);
  if (!(await withinStore("join-ip", `${store.statsId}:${ip}`, 10, 3_600, store))) return "limited";
  if (!(await withinEssentialLimit("join-address", sha(email), 5, 3_600))) return "limited";

  const token = randomBytes(24).toString("hex");
  const grant: Grant = { s: store.statsId, h: store.handle, e: email, at: new Date().toISOString(), ...(input.clicks ? { k: true } : {}), ...(input.formId && /^[a-z0-9]{10}$/.test(input.formId) ? { f: input.formId, ...(input.formOutcome && /^[a-z0-9]{6}$/.test(input.formOutcome) ? { r: input.formOutcome } : {}) } : {}), ...(input.site && /^https:\/\/[^/\s]{1,300}$/.test(input.site) ? { w: input.site } : {}), ...(input.lead && /^[0-9a-f]{12}$/.test(input.lead) ? { a: input.lead } : {}) };
  const [saved] = await redisPipeline([["SET", tokenKey(token), JSON.stringify(grant), "EX", JOIN_SECONDS], ...noteForErasure(store.statsId, grant.e, tokenKey(token))]);
  // Never spend an email on a confirmation link whose grant was not saved.
  if (saved !== "OK") return "error";

  const w = joinWords(store.language);
  const sent = await sendEmail({ meter: { by: "store", store: store, kind: "transactional", asked: true },
    from: sender(store),
    to: email,
    subject: w.mailSubject(store.name).slice(0, 200),
    text: [
      w.mailAsked(store.name),
      "",
      w.mailOpen,
      `${origin}/@${store.handle}/join?token=${token}`,
      "",
      w.mailWorks,
      w.mailIgnore,
      "",
      givingWords(store.language).sentBy(store.name),
    ].join("\n"),
  });
  return sent ? "sent" : "error";
}

/** What a link is for, without using it: for the page that shows the button. */
export async function readJoinToken(token: string): Promise<Grant | null> {
  if (!JOIN_TOKEN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", tokenKey(token)]]);
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<Grant>;
    if (typeof value.s !== "string" || typeof value.h !== "string" || typeof value.e !== "string" || !EMAIL_PATTERN.test(value.e)) return null;
    return { s: value.s, h: value.h, e: value.e, at: typeof value.at === "string" ? value.at : "", ...(value.k === true ? { k: true } : {}), ...(typeof value.f === "string" && /^[a-z0-9]{10}$/.test(value.f) ? { f: value.f, ...(typeof value.r === "string" && /^[a-z0-9]{6}$/.test(value.r) ? { r: value.r } : {}) } : {}), ...(typeof value.w === "string" && /^https:\/\/[^/\s]{1,300}$/.test(value.w) ? { w: value.w } : {}), ...(typeof value.a === "string" && /^[0-9a-f]{12}$/.test(value.a) ? { a: value.a } : {}) };
  } catch {
    return null;
  }
}

export type ConfirmResult = { ok: true; grant: Grant; added: AddResult } | { ok: false; reason: "expired" | "full" };

/**
 * Presses the button: the address joins the list as someone who asked to
 * hear from the creator. The link is used up, so a forwarded email cannot
 * sign anybody else up.
 */
export async function confirmJoin(token: string, store: Store | null): Promise<ConfirmResult> {
  const grant = await readJoinToken(token);
  if (!grant || !store || store.statsId !== grant.s || !store.listId) return { ok: false, reason: "expired" };
  // The list's room in the store's data room is its room too: past it, the address is not added, as on a full list.
  const added = await upsertContact(store.listId, grant.e, { agreed: true, explicit: true, clicks: grant.k === true, source: "free", at: new Date().toISOString(), sid: store.sid }, store).catch((error) => {
    if (error instanceof DataRoomError) return { joined: false, gotProduct: false, full: true };
    throw error;
  });
  if (added.full) return { ok: false, reason: "full" };
  await redisPipeline([["DEL", tokenKey(token)]]);
  return { ok: true, grant, added };
}
