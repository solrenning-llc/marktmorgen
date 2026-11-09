/**
 * Pictures a function answers, paced (18 October 2026,
 * docs/security-audit-2026-10-18.md, MM-SA-04).
 *
 * A product picture (app/api/image), a store photo (app/api/photo) and a
 * store's home-screen icon (app/[handle]/app-icon) are costed as requests the
 * CDN answers (tests/traffic-cost.ts): their addresses never change what is
 * behind them, so they are kept for a year and almost never reach a function.
 * Nothing held that true for an address the CDN had not seen. The CDN keeps
 * an answer per address, query string included, so `?1`, `?2`, `?3` on one
 * picture were each read again from the file store (up to a megabyte) or the
 * database (up to 200 KB), and a made-up name was a function and a read each
 * time: no store's figure counted any of it, so a loop from one machine was a
 * bill with no ceiling.
 *
 * Now:
 *   - an address with anything after its path is sent, with no read, to the
 *     one address the CDN keeps (`canonicalPicture`); the icon, whose one
 *     query is its fingerprint, is sent to its current one before it is drawn;
 *   - every answer a function gives, the read or the "not found", is paced in
 *     this server's memory (lib/local-limit.ts), by connection and by file,
 *     which costs no store command; an answer it lets through then reads the
 *     picture's child-safety mark once (lib/held-files.ts, one GET). A
 *     visitor's browser asks the CDN, not us;
 *     a first visitor in a region, who does reach us, asks for a page's worth
 *     of pictures, far inside either pace.
 */
import { clientAddress } from "@/lib/request-guard";
import { visitorAddress } from "@/lib/traffic-rules";
import { withinLocalLimit } from "@/lib/local-limit";

/** Pictures one connection may have a function answer in a minute, on one server. */
export const PICTURES_PER_MINUTE = 120;
/** Times one picture may be read by a function in a minute, on one server: the CDN answers the rest. */
export const PICTURE_READS_PER_MINUTE = 30;
const MINUTE = 60_000;

type HeaderSource = { headers: Headers };

/**
 * The connection a pace is held for: an address of the old kind as it is, and
 * the new kind by its first three groups (a /48), which is what one site is
 * handed, so one machine with a network of its own is one connection.
 */
export function paceAddress(ip: string): string {
  const address = visitorAddress(ip);
  const v6 = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/.exec(address);
  return v6 ? `${v6[1]}:${v6[2]}:${v6[3]}::/48` : address;
}

const NO_STORE = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } as const;

const tooMany = () => new Response("Too many requests. Try again in a minute.", { status: 429, headers: { ...NO_STORE, "Retry-After": "60" } });

/**
 * A refusal when this connection has had its minute of answers from a
 * function, whatever they were; null to go on. Counted before anything is
 * read, so a refusal reads nothing.
 */
export function connectionRefusal(request: HeaderSource, now: number = Date.now()): Response | null {
  return withinLocalLimit("picture-ip", paceAddress(clientAddress(request)), PICTURES_PER_MINUTE, MINUTE, now) ? null : tooMany();
}

/**
 * A refusal when this one file has been read its minute's times on this
 * server; null to go on. Asked only just before a read, so the answers that
 * read nothing (a query string sent to the plain address) never use it up for
 * the visitors the CDN has not served yet.
 */
export function readRefusal(file: string, now: number = Date.now()): Response | null {
  return withinLocalLimit("picture-file", file, PICTURE_READS_PER_MINUTE, MINUTE, now) ? null : tooMany();
}

/**
 * The address the CDN keeps, when this one asks for the same picture with a
 * query string; null when it is that address already. Kept for a year, like
 * the picture, and nothing is read for it.
 */
export function canonicalPicture(request: Request): Response | null {
  const url = new URL(request.url);
  if (!url.search && !request.url.includes("?")) return null;
  return new Response(null, {
    status: 308,
    headers: { Location: url.pathname, "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
