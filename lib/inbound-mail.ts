/**
 * Mail written to the site's own addresses, passed on to the inbox that
 * reads it.
 *
 * The addresses printed on the site (support@marktmorgen.com) and the ones
 * our own emails are sent from (hello@, orders@) are on a domain that sends
 * through Resend. Resend receives for that domain too: each message it takes
 * in is announced to app/api/mail/inbound, and this file fetches it and sends
 * it on to one inbox, with Reply-To set to whoever wrote, so pressing Reply
 * there answers them.
 *
 * Three settings switch it on, and without all three nothing is received
 * here at all:
 *
 *   RESEND_WEBHOOK_SECRET    signs each announcement (whsec_…)
 *   RESEND_INBOUND_API_KEY   reads a received message and its files; kept
 *                            apart from RESEND_API_KEY, which can only send
 *   SUPPORT_FORWARD_TO       the inbox the mail goes on to; a setting, never
 *                            written in the code or shown on the site
 *
 * What cannot go wrong quietly:
 *
 *   - an announcement is believed only with Resend's signature (Svix:
 *     HMAC-SHA256 of "<id>.<timestamp>.<body>") from the last five minutes;
 *   - a message we sent on ourselves is never sent on again (it carries
 *     FORWARD_HEADER), and the inbox it goes to may not be on this site's own
 *     domain, so mail cannot go round in a circle;
 *   - a file is fetched only from Resend's own hosts, and files are left out,
 *     and named in the message, once they pass MAX_FILES_BYTES together;
 *   - sending on carries an idempotency key made from the message's id, so an
 *     announcement repeated by Resend cannot deliver the same message twice.
 *
 * The message itself stays in Resend's dashboard (Emails, Receiving) whatever
 * happens here.
 *
 * Resend announces every message its account receives to the one address it
 * was given, whichever domain the message was written to. So mail for another
 * site of the same studio that receives through the same account — Hazelsong's
 * support@hazelsong.com is one — arrives here too, and is sent on to the same
 * inbox. It is sent from this site's own address, which is the one this
 * deployment may send from, and it names the domain it was written to instead
 * of this site, so the inbox can tell which product a message is about.
 *
 * One kind of message does not go to that inbox at all. A creator's email
 * to people is sent from the store's own address on a domain set apart for
 * it (lib/mail-from.ts), and carries Reply-To with the creator's real
 * address, so an answer goes straight to them. A mail app that ignores
 * Reply-To answers the store's address instead, and that answer is the
 * creator's and nobody else's to read: it is sent on to the address the
 * store's account is under, from the store's own address, with Reply-To
 * whoever wrote. Mail to a name on that domain that is no store's is
 * dropped, and a store is sent on no more than CREATOR_HOURLY an hour, so
 * that the address cannot be used to pour mail on a creator through us.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { NIMBUS_FROM, RESEND_BASE, headerText, oneAddress, sendEmail } from "@/lib/email";
import { creatorDomain } from "@/lib/mail-from";
import { withinLimit } from "@/lib/request-guard";
import { HANDLE_PATTERN, storeForHandle } from "@/lib/store";
import { RESEND_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import { SITE_URL } from "@/lib/site-url";

/** The header a message sent on by this file carries. */
export const FORWARD_HEADER = "X-Marktmorgen-Forwarded";
/** Files sent on with one message, together, before base64. */
const MAX_FILES_BYTES = 15_000_000;
/** A message's own text or page, each, sent on. */
const MAX_BODY_CHARS = 400_000;
/** Messages sent on to one store in an hour, at the most. */
export const CREATOR_HOURLY = 40;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const platformDomain = () => new URL(SITE_URL).hostname;

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** The inbox mail goes on to, or null: one plain address, not on this site's own domain. */
export function forwardTarget(): string | null {
  const address = oneAddress(env("SUPPORT_FORWARD_TO"));
  if (!address) return null;
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return domain === platformDomain() || domain.endsWith(`.${platformDomain()}`) ? null : address;
}

export function isInboundConfigured(): boolean {
  return Boolean(env("RESEND_WEBHOOK_SECRET") && env("RESEND_INBOUND_API_KEY") && forwardTarget());
}

/**
 * Whether Resend's announcements can be believed at all: the one setting that
 * signs them. Enough for the announcements that carry what they say in
 * themselves — an email bounced, an email was marked as spam
 * (lib/mail-health.ts) — which need nothing fetched and nothing sent on.
 */
export function canHearResend(): boolean {
  return Boolean(env("RESEND_WEBHOOK_SECRET"));
}

/**
 * Whether an announcement is Resend's: signed under RESEND_WEBHOOK_SECRET,
 * no more than five minutes ago. The signature header may hold several
 * ("v1,<base64> v1,<base64>"); one that matches is enough.
 */
export function inboundSigned(
  body: string,
  id: string | null,
  timestamp: string | null,
  signatures: string | null,
  now = Date.now(),
): boolean {
  const secret = env("RESEND_WEBHOOK_SECRET");
  if (!secret || !id || !timestamp || !signatures) return false;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !/^\d{9,11}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (key.length < 16) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signatures
    .split(" ")
    .slice(0, 8)
    .some((one) => {
      const [version, value] = one.split(",");
      if (version !== "v1" || !value) return false;
      const given = Buffer.from(value, "base64");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

type Received = {
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  received_for?: unknown;
  reply_to?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  headers?: unknown;
};

type FileEntry = { filename?: unknown; size?: unknown; download_url?: unknown };

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 50) : [];

/** "Jane Doe <jane@example.com>" taken apart; a bare address has no name. */
export function parseSender(from: string): { name: string; address: string | null } {
  const match = from.match(/^\s*"?([^"<]*)"?\s*<([^<>]+)>\s*$/);
  if (match) return { name: headerText(match[1], 80), address: oneAddress(match[2]) };
  return { name: "", address: oneAddress(from) };
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A page as plain words, for a message that came with no text of its own. */
function pageToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

async function read(path: string): Promise<{ status: number; data: unknown }> {
  const response = await timed(RESEND_TIMEOUT_MS, (signal) =>
    fetch(`${RESEND_BASE}${path}`, {
      headers: { Authorization: `Bearer ${env("RESEND_INBOUND_API_KEY")}` },
      cache: "no-store",
      redirect: "error",
      signal,
    }),
  );
  return { status: response.status, data: response.ok ? ((await response.json()) as unknown) : null };
}

/** A file's address, only when it is on one of Resend's own hosts (or the local stand-in of a test). */
function fileUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4000) return null;
  try {
    const url = new URL(value);
    if (RESEND_BASE.startsWith("http://127.0.0.1:") && url.origin === RESEND_BASE) return url.href;
    return url.protocol === "https:" && (url.hostname === "resend.com" || url.hostname.endsWith(".resend.com")) ? url.href : null;
  } catch {
    return null;
  }
}

/** The files of a received message, as the sender's API takes them, and the names of the ones left out. */
async function files(id: string): Promise<{ sent: { filename: string; content: string }[]; left: string[] }> {
  const sent: { filename: string; content: string }[] = [];
  const left: string[] = [];
  const listed = await read(`/emails/receiving/${id}/attachments?limit=100`);
  const entries = (listed.data as { data?: unknown } | null)?.data;
  let total = 0;
  for (const entry of Array.isArray(entries) ? (entries as FileEntry[]).slice(0, 100) : []) {
    const name = headerText(typeof entry.filename === "string" && entry.filename ? entry.filename : "file", 150);
    const size = typeof entry.size === "number" && entry.size >= 0 ? entry.size : 0;
    const url = fileUrl(entry.download_url);
    if (!url || total + size > MAX_FILES_BYTES) {
      left.push(name);
      continue;
    }
    try {
      const response = await timed(RESEND_TIMEOUT_MS, (signal) => fetch(url, { cache: "no-store", signal }));
      if (!response.ok) throw new Error(`file answered ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (total + bytes.length > MAX_FILES_BYTES) {
        left.push(name);
        continue;
      }
      total += bytes.length;
      sent.push({ filename: name, content: bytes.toString("base64") });
    } catch (error) {
      console.error("an inbound file could not be fetched", error);
      left.push(name);
    }
  }
  return { sent, left };
}

/**
 * Sends one received message on.
 *
 *   "sent"     it went on to the inbox
 *   "skipped"  there was nothing to send on: no such message, or one of ours
 *   "retry"    it could not be read or sent just now; the announcement should
 *              be answered with a failure, so Resend makes it again
 */
export async function forwardInbound(id: string): Promise<"sent" | "skipped" | "retry"> {
  const target = forwardTarget();
  if (!target || !ID.test(id)) return "skipped";

  let got: { status: number; data: unknown };
  try {
    got = await read(`/emails/receiving/${id}`);
  } catch (error) {
    console.error("an inbound message could not be read", error);
    return "retry";
  }
  if (got.status === 404) return "skipped";
  if (!got.data || typeof got.data !== "object") return "retry";
  const mail = got.data as Received;

  const headers = mail.headers && typeof mail.headers === "object" ? (mail.headers as Record<string, unknown>) : {};
  if (Object.keys(headers).some((name) => name.toLowerCase() === FORWARD_HEADER.toLowerCase())) return "skipped";

  const from = typeof mail.from === "string" ? headerText(mail.from, 320) : "";
  const sender = parseSender(typeof headers.from === "string" && parseSender(headers.from).address ? headers.from : from);
  const replyTo = list(mail.reply_to).map((a) => parseSender(a).address).find(Boolean) ?? sender.address ?? undefined;
  // Each address once, however it was capitalised.
  const written: string[] = [];
  for (const one of [...list(mail.received_for), ...list(mail.to)]) {
    const address = parseSender(one).address;
    if (address && !written.some((held) => held.toLowerCase() === address.toLowerCase())) written.push(address);
  }
  const ours = written.find((a) => a.toLowerCase().endsWith(`@${platformDomain()}`)) ?? written[0] ?? `support@${platformDomain()}`;
  // Written to a store's own address: the creator's to read, not the site's.
  const creators = creatorDomain(NIMBUS_FROM);
  const toStore = creators ? written.find((a) => a.toLowerCase().endsWith(`@${creators}`)) : undefined;
  let creator: { name: string; email: string; address: string } | null = null;
  let store: Awaited<ReturnType<typeof storeForHandle>> = null;
  if (toStore) {
    const handle = toStore.slice(0, toStore.lastIndexOf("@")).toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) return "skipped";
    let found: Awaited<ReturnType<typeof storeForHandle>>;
    try {
      found = await storeForHandle(handle);
    } catch (error) {
      console.error("the store an inbound message was written to could not be read", error);
      return "retry";
    }
    const email = found ? oneAddress(found.email) : null;
    if (!found || !email) return "skipped";
    if (!(await withinLimit("creator-inbound", handle, CREATOR_HOURLY, 3_600))) return "skipped";
    creator = { name: headerText(found.name, 60).replace(/["\\<>]/g, "") || handle, email, address: `${handle}@${creators}` };
    store = found;
  }
  const subject = typeof mail.subject === "string" && mail.subject.trim() ? mail.subject : "(no subject)";
  const html = typeof mail.html === "string" ? mail.html.slice(0, MAX_BODY_CHARS) : "";
  const text = (typeof mail.text === "string" && mail.text.trim() ? mail.text : pageToText(html)).slice(0, MAX_BODY_CHARS);

  let attached: Awaited<ReturnType<typeof files>> = { sent: [], left: [] };
  try {
    attached = await files(id);
  } catch (error) {
    console.error("the files of an inbound message could not be listed", error);
    return "retry";
  }

  const who = sender.name ? `${sender.name} <${sender.address ?? "unknown"}>` : (sender.address ?? (from || "unknown sender"));
  const lines = [
    `From: ${who}`,
    `To: ${written.join(", ") || ours}`,
    // A creator has no way into the sender's dashboard, so is not pointed at it.
    ...(attached.left.length ? [`${creator ? "Not attached, too large to send on" : "Not attached (see Resend, Emails, Receiving)"}: ${attached.left.join(", ")}`] : []),
  ];
  const shown = (sender.name || sender.address || "Someone").replace(/["\\<>]/g, "").slice(0, 60);
  // Which site the message was written to: this one, or the domain of the
  // address it came in on (see the note at the top of this file).
  const writtenTo = ours.slice(ours.lastIndexOf("@") + 1).toLowerCase();
  const site = writtenTo === platformDomain() || !/^[a-z0-9.-]{3,80}$/.test(writtenTo) ? "Marktmorgen" : writtenTo;

  // To a creator, one of their store's emails; to our own support, a company cost.
  const ok = await sendEmail({ meter: store ? { by: "store", store, kind: "email" } : { by: "company" },
    from: creator ? `"${shown} via ${creator.name}" <${creator.address}>` : `"${shown} via ${site}" <support@${platformDomain()}>`,
    to: creator ? creator.email : target,
    subject,
    text: `${lines.join("\n")}\n\n${text}`,
    ...(html
      ? {
          html: `<div style="font:13px/1.5 system-ui,sans-serif;color:#555;border-bottom:1px solid #ddd;padding:0 0 8px;margin:0 0 12px">${lines
            .map(escapeHtml)
            .join("<br>")}</div>${html}`,
        }
      : {}),
    replyTo,
    attachments: attached.sent,
    headers: { [FORWARD_HEADER]: "1" },
    idempotencyKey: `inbound-${id}`,
  });
  return ok ? "sent" : "retry";
}
