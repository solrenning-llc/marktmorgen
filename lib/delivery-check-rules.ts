/**
 * Checking that what a product delivers still works (479 [SB2], unit 1;
 * added 2 November 2026): the rules, before anything is read. Pure; the
 * reading itself (storage for a file, lib/safe-fetch.ts for an address) is
 * the next unit, and it hands its answers to these.
 *
 * What a product delivers, and what is checked:
 *
 *   - a file, the product's own or a price option's: it is still in the
 *     store's private storage, at the size kept when it was put there;
 *   - a link, the product's own or a price option's: the address answers. It is read through lib/safe-fetch.ts,
 *     which refuses an address inside a private network, so an address only
 *     the creator's own network could reach is a problem for buyers too;
 *   - a call's meeting links: the creator's own link (also behind a Google
 *     Meet or Zoom meeting, where it is used when the meeting cannot be made)
 *     and each dated session's link still to come. A call in person or in a
 *     video room of our own has no link to check;
 *   - a membership's file or link like any product's; a course's lessons and
 *     a bundle's products are not checked here (a bundle's products are
 *     checked on their own).
 *
 * What is said is only what was seen. A page that asks to sign in, or one
 * that did not answer properly just now, is "not checked", never "fine" and
 * never "broken": a buyer who signs in may open it, and a slow site is not a
 * dead one. Only a missing file, a page that says it is gone, or an address
 * that cannot be reached by anyone is a problem, with what to do about it.
 */

import type { SafeFetchProblem } from "@/lib/safe-fetch";

export type DeliveryState = "ok" | "problem" | "not-checked";

export type DeliveryVerdict = {
  state: DeliveryState;
  /** What was seen, in plain words for the creator. */
  found: string;
  /** What to do, for a problem. */
  fix?: string;
};

/** One thing a product hands over, as far as a check can read it. */
export type DeliveryTarget =
  | { kind: "file"; pathname: string; bytes: number; name: string }
  | { kind: "link"; url: string }
  | { kind: "room"; url: string }
  | { kind: "none" };

/** A thing to check, with the words that say which one it is ("Your link", "The "1 week" option's file"). */
export type DeliveryItem = { what: string; target: Exclude<DeliveryTarget, { kind: "none" }> };

type Handed = { file: { pathname: string; bytes: number; name: string } | null; link: string | null };

/** Only what is needed to know what a product delivers. */
export type DeliveryProduct = Handed & {
  /** Price options, each handing over its own file or link (lib/product-option.ts). */
  options?: (Handed & { label: string })[];
  call?: { room: string | null; video?: boolean; meet?: unknown; place?: unknown; kind?: string; sessions?: { start: number; minutes: number; room: string | null }[] } | null;
  course?: unknown;
  bundle?: unknown;
};

function handed(item: Handed, file: string, link: string): DeliveryItem[] {
  if (item.file) return [{ what: file, target: { kind: "file", pathname: item.file.pathname, bytes: item.file.bytes, name: item.file.name } }];
  if (item.link) return [{ what: link, target: { kind: "link", url: item.link } }];
  return [];
}

/**
 * Every thing one product hands over that can be checked: its own file or
 * link, each price option's own file or link (a course's or a membership's
 * options too), and a call's meeting links: the creator's own link, also when
 * it stands behind a Google Meet or Zoom meeting that could not be made, and
 * the link of each dated session still to come. Nothing for a call in person
 * or in a video room of our own, and nothing for a bundle, whose products are
 * checked on their own.
 */
export function deliveryItems(product: DeliveryProduct, now = Date.now()): DeliveryItem[] {
  if (product.bundle) return [];
  const items: DeliveryItem[] = [];
  const call = product.call;
  if (call) {
    if (!call.place && !call.video) {
      if (call.kind === "live") {
        for (const session of call.sessions ?? []) {
          if (session.room && session.start + session.minutes * 60_000 > now) {
            items.push({ what: `The meeting link of the session on ${new Date(session.start).toISOString().slice(0, 10)}`, target: { kind: "room", url: session.room } });
          }
        }
      } else if (call.room) {
        items.push({ what: call.meet ? "Your meeting link, used when a Google Meet or Zoom meeting cannot be made" : "Your meeting link", target: { kind: "room", url: call.room } });
      }
    }
    return items;
  }
  if (!product.course) items.push(...handed(product, "Your file", "Your link"));
  for (const option of product.options ?? []) items.push(...handed(option, `The "${option.label}" option's file`, `The "${option.label}" option's link`));
  return items;
}

/** The first thing a product hands over; none when nothing is checked. */
export function deliveryTarget(product: DeliveryProduct): DeliveryTarget {
  return deliveryItems(product)[0]?.target ?? { kind: "none" };
}

/**
 * What storage said about a product's file: its size, "missing" when it is
 * not there, or null when storage could not be asked just now.
 */
export function fileVerdict(name: string, kept: number, seen: { size: number } | "missing" | null): DeliveryVerdict {
  if (seen === null) return { state: "not-checked", found: `We could not look for ${name} just now. It is checked again tomorrow.` };
  if (seen === "missing") {
    return { state: "problem", found: `${name} is not in your store's storage anymore, so buyers cannot download it.`, fix: "Upload the file again on the product." };
  }
  if (!Number.isSafeInteger(seen.size) || seen.size <= 0) {
    return { state: "problem", found: `${name} is empty in your store's storage, so buyers would download nothing.`, fix: "Upload the file again on the product." };
  }
  if (seen.size !== kept) {
    return { state: "problem", found: `${name} in storage is not the file you uploaded (its size changed), so buyers may get the wrong file.`, fix: "Upload the file again on the product." };
  }
  return { state: "ok", found: `${name} is in place.` };
}

/** Why lib/safe-fetch.ts did not get an answer (SafeFetchProblem), or the status that came back. */
export type AddressAnswer = { status: number } | { problem: SafeFetchProblem };

/**
 * What an address's answer means for buyers. `what` names it ("Your link",
 * "Your meeting link"); `where` is the address, said as typed.
 */
export function addressVerdict(what: string, where: string, answer: AddressAnswer): DeliveryVerdict {
  if ("problem" in answer) {
    switch (answer.problem) {
      // Too long to read whole, and its status not known (lib/delivery-check.ts passes it on when it is): an error
      // page can be long too, so this is never called fine (Codex C2 on #3623).
      case "too_big":
        return { state: "not-checked", found: `${what} answered with more than we read, and we could not tell whether it opens. Open it yourself to check.` };
      case "scheme":
        return { state: "problem", found: `${what}, ${where}, is not a secure web address (https), so buyers' browsers may warn about it or not open it.`, fix: "Change it to the https address of the page." };
      case "address":
        return { state: "problem", found: `${what}, ${where}, is not a web address we can open (it may hold a name and password, or be written in a way browsers do not read).`, fix: "Copy the address again from your browser's address bar, without any name or password in it." };
      case "port":
        return { state: "problem", found: `${what}, ${where}, uses a port (the number after the colon) that buyers' browsers and networks may not open.`, fix: "Use the page's usual address, without a number after the colon." };
      case "private":
        return { state: "problem", found: `${what}, ${where}, cannot be reached from outside: its name points to a private network, or ends like one.`, fix: "Use the public address of the page, the one that opens on any phone with mobile data." };
      case "redirect":
        return { state: "not-checked", found: `${what} sends visitors on through more redirects than we follow. Open it yourself to check it lands where buyers should be.` };
      // The name was not found, or the lookup failed: a lost domain looks the same as a slow one here,
      // so it is said as found, and the reading (unit 2) tells the two apart before calling it a problem.
      case "dns":
        return { state: "not-checked", found: `We could not find the name of ${what.toLowerCase()}, ${where}. If you let the domain go, buyers cannot open it; if not, it is checked again tomorrow.` };
      case "timeout":
      case "network":
      default:
        return { state: "not-checked", found: `${what} did not answer just now. It is checked again tomorrow.` };
    }
  }
  const status = answer.status;
  if (status >= 200 && status < 400) return { state: "ok", found: `${what} answers.` };
  if (status === 401 || status === 403) {
    return { state: "not-checked", found: `${what} asks to sign in, so we cannot tell whether a buyer can open it. Open it in a private browser window to check what a buyer sees.` };
  }
  if (status === 404 || status === 410) {
    return { state: "problem", found: `${what}, ${where}, says the page is not there (${status}), so buyers cannot open it.`, fix: "Put the right address on the product, or bring the page back." };
  }
  if (status === 429 || status >= 500) return { state: "not-checked", found: `${what} did not answer properly just now (${status}). It is checked again tomorrow.` };
  return { state: "not-checked", found: `${what} answered in a way we cannot read (${status}). Open it yourself to check.` };
}

/** One product's verdict, from its target and what was read; null for a product with nothing checked here. */
export function verdictFor(target: DeliveryTarget, read: { size: number } | "missing" | AddressAnswer | null): DeliveryVerdict | null {
  if (target.kind === "none") return null;
  if (target.kind === "file") {
    const seen = read === "missing" ? "missing" : read && "size" in read ? read : null;
    return fileVerdict(target.name, target.bytes, seen);
  }
  const what = target.kind === "room" ? "Your meeting link" : "Your link";
  // A file's answer, or none, for an address: nothing was asked of it.
  if (!read || read === "missing" || "size" in read) return { state: "not-checked", found: `${what} could not be checked just now. It is checked again tomorrow.` };
  return addressVerdict(what, target.url, read);
}

// ---- The reading (479 [SB2], unit 2; added 10 November 2026) -----------------
// lib/delivery-check.ts reads what deliveryItems names and hands each answer to the verdicts above. These are its
// ceilings, here so the help and the studio can read them without the database.

/** At most this many things of one product are read in one check; the rest are counted and said as not checked. */
export const MAX_DELIVERY_ITEMS = 16;
/** Each thing is given at most this long, whatever reads it; an answer later is "not checked", never fine. */
export const DELIVERY_ITEM_MS = 20_000;
/** An address is read this far and no further: a longer page is judged by its status (too_big, above). */
export const ADDRESS_READ_BYTES = 16_384;
/** How long an address is waited on, redirects included. */
export const ADDRESS_TIMEOUT_MS = 8_000;
/** Redirects followed before an address is said to send visitors on too far. */
export const ADDRESS_REDIRECTS = 5;
/**
 * The studio requests one check takes, before anything is read: what a check of MAX_DELIVERY_ITEMS things costs at
 * its worst, held in tests/delivery-check.test.ts (the function waiting DELIVERY_ITEM_MS at 2 GB, each file looked at
 * twice at the dearer storage, each address's bytes). From the store's own studio figure, so no new limit is made.
 */
export const DELIVERY_CHECK_UNITS = 5;

/** What is said of the things past MAX_DELIVERY_ITEMS: counted, not read, never said to be fine. */
export function leftWords(left: number): string {
  if (!Number.isSafeInteger(left) || left <= 0) return "";
  return `${left} more ${left === 1 ? "thing this product hands over was" : "things this product hands over were"} not checked this time: we check ${MAX_DELIVERY_ITEMS} at a time.`;
}
