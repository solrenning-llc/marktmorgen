/**
 * Selling something that lives somewhere else.
 *
 * Not every product fits in a file we host. A course of twelve videos, a
 * Notion workspace, a private podcast feed — these already live somewhere, and
 * a creator should be able to sell one without first moving it. This is the
 * same escape hatch Stan calls "Redirect to URL", and it costs a creator
 * nothing to use and costs us nothing to run.
 *
 * The link is the whole product, so it is checked like one. A buyer who has
 * paid is about to be sent wherever this points, and the person who typed it
 * is not us.
 */

/** Long enough for a signed cloud link, short enough to store without care. */
export const MAX_LINK_LENGTH = 2000;

export type LinkProblem =
  /** Nothing was typed. */
  | "empty"
  /** Not a URL at all. */
  | "shape"
  /** Not https. A buyer is not sent anywhere we cannot promise is encrypted. */
  | "scheme"
  /** A username or password baked into the URL. */
  | "credentials"
  /** No real host: localhost, a bare name, a raw IP address. */
  | "host"
  /** Past the length we keep. */
  | "long";

/** What to tell the creator about each way a link can be wrong. */
export const LINK_PROBLEMS: Record<LinkProblem, string> = {
  empty: "Paste the link your buyer should open.",
  shape: "That does not look like a web address.",
  scheme: "The link has to start with https:// so the page is encrypted.",
  credentials:
    "That link carries a username or password in it. Use a sharing link instead.",
  host: "That link has no public address a buyer could open.",
  long: "That link is too long to keep.",
};

/**
 * Whether a host name is one that only exists on the visitor's own machine: localhost and any name under it,
 * with or without the final dot that makes the same name (a URL keeps it: "localhost." is "localhost").
 */
export function hostIsLocal(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  return host === "localhost" || host.endsWith(".localhost");
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Reads what the creator typed and returns the link we would actually store.
 *
 * Returning the parsed URL rather than the raw text is deliberate: it is
 * normalised once, here, so what the buyer is sent to is exactly what was
 * checked, with no second parse to disagree with the first.
 */
export function readLink(
  raw: string,
): { ok: true; url: string } | { ok: false; reason: LinkProblem } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_LINK_LENGTH) return { ok: false, reason: "long" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "shape" };
  }

  // Only https. http can be read on the way, and everything else — javascript:,
  // data:, file: — is a way of running something in the buyer's browser or
  // reaching their own machine rather than sending them to a page.
  if (url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };

  const host = url.hostname.toLowerCase();
  if (!host.includes(".")) return { ok: false, reason: "host" };
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "host" };
  }
  // A raw address is either a mistake or an attempt to point a buyer at
  // something that is not a published page. Either way it is not a product.
  if (IPV4.test(host)) return { ok: false, reason: "host" };

  const normalised = url.toString();
  if (normalised.length > MAX_LINK_LENGTH) return { ok: false, reason: "long" };
  return { ok: true, url: normalised };
}

/** The part of a link worth showing a person: the site it leads to. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
