/**
 * Addresses the server fetches (a webhook endpoint, a calendar to read),
 * checked in the browser when their field is left (487 [IT4], pattern 1;
 * added 1 November 2026).
 *
 * The server's guard is checkUrl in lib/safe-fetch.ts. It stays where it is,
 * untouched: it uses the server's own address reading, and it decides every
 * request the server sends out. This is a part of it, never more:
 * tests/fetch-url-check.test.ts holds that it never refuses an address the
 * server keeps, keeps it the same way, and refuses only in the server's own
 * words. An address written as a number (an IP) is left to the server, which
 * alone says whether it is on a private network.
 *
 * Browser-safe: plain functions.
 */
import { NEEDS_HTTPS, type LinkCheck } from "@/lib/url-check";

/** The length each of those servers keeps (MAX_ENDPOINT_URL, MAX_FEED_URL, MAX_ICS_URL). */
export const MAX_FETCH_URL = 1000;

/** Names that only mean something inside a network: the same list as the server's. */
const LOCAL_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|invalid|example|arpa)$/i;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/** The address as the server would keep it, or the server's words for why not; an IP is passed on to the server. */
export function fetchableShape(raw: string): { ok: true; url: string } | { ok: false; words: string } {
  let text = (raw ?? "").trim();
  // webcal://, which calendar apps hand out, is the same address over https.
  if (/^webcals?:\/\//i.test(text)) text = text.replace(/^webcals?:\/\//i, "https://");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, words: "That is not a web address." };
  }
  if (url.protocol !== "https:") return { ok: false, words: "Only https:// addresses are accepted." };
  if (url.username || url.password) return { ok: false, words: "An address with a user name or password in it is not accepted." };
  const port = url.port ? Number(url.port) : 443;
  if (port !== 443 && port < 1024) return { ok: false, words: "Only port 443, or a port above 1023, is accepted." };
  const host = url.hostname;
  const written = host.startsWith("[") || IPV4.test(host);
  if (!written && (!host.includes(".") || LOCAL_NAME.test(host.replace(/\.$/, "")))) {
    return { ok: false, words: "That address is on a private or local network." };
  }
  return { ok: true, url: url.toString() };
}

const LOCAL_OR_NUMBER = (url: string) => {
  const host = new URL(url).hostname;
  return host.startsWith("[") || IPV4.test(host);
};

/**
 * On leaving the field: what is wrong, and https:// offered back when that is
 * all it lacks, and only when the server then keeps it (never an address
 * written as a number, which the server alone may refuse as private, and
 * never one that becomes too long once its letters are written out).
 * `longWords` is the field's own server's words for too long; `required`
 * says an empty field; `noWebcal` refuses webcal://, as the webhook server does.
 */
export function fetchCheck(options: { longWords?: string; required?: boolean; noWebcal?: boolean } = {}): LinkCheck {
  const long = options.longWords ?? "That address is too long.";
  return (raw) => {
    const typed = (raw ?? "").trim();
    if (!typed) return options.required ? { problem: "That is not a web address.", fix: null } : { problem: null, fix: null };
    if (typed.length > MAX_FETCH_URL) return { problem: long, fix: null };
    if (options.noWebcal && /^webcals?:/i.test(typed)) return { problem: "Only https:// addresses are accepted.", fix: null };
    const read = fetchableShape(typed);
    if (read.ok) return { problem: null, fix: null };
    const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(typed);
    if (!hasScheme || /^http:\/\//i.test(typed)) {
      const tried = `https://${typed.replace(/^http:\/\//i, "")}`;
      const fixed = tried.length <= MAX_FETCH_URL ? fetchableShape(tried) : null;
      if (fixed?.ok && fixed.url.length <= MAX_FETCH_URL && !LOCAL_OR_NUMBER(fixed.url)) return { problem: NEEDS_HTTPS, fix: fixed.url };
      if (!hasScheme && fixed && !fixed.ok) return { problem: fixed.words, fix: null };
    }
    return { problem: read.words, fix: null };
  };
}

export const fetchOnLeave: LinkCheck = fetchCheck();

const CALENDAR_LONG = "That address is longer than any calendar address we know of.";
/** A webhook endpoint (lib/webhooks.ts addEndpoint): required, and never webcal://. */
export const WEBHOOK_CHECK = fetchCheck({ required: true, noWebcal: true });
/** A calendar a store reads (lib/calendar-sync.ts addFeed): required. */
export const CALENDAR_CHECK = fetchCheck({ required: true, longWords: CALENDAR_LONG });
/** A host's private iCal address (lib/host-calendar.ts addHostIcs). */
export const HOST_ICS_CHECK = fetchCheck({ longWords: CALENDAR_LONG });
