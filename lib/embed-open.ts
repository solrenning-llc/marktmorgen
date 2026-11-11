/**
 * What a page opened by the checkout script (lib/embed-sdk.ts) may do, worked
 * out on the server for each open: the product's card at /embed/<store>/<product>
 * and the sign-up form at /embed/<store>/join, with ?mm=overlay or ?mm=page.
 *
 * An open is a person who pressed a link, never a page view, and it is paid
 * for like a visit to the store's own pages:
 *
 *   - counted toward the visits the store's plan covers (lib/traffic.ts), once
 *     a person a day, never a robot's or the store's own people's: by the
 *     page itself (components/store-beacon.tsx), through the host's browser
 *     check (app/api/store/hit), never here, where any program can ask;
 *   - refused its buy button and form when the store is past them
 *     (isResting), as its other pages rest, and when one connection has
 *     opened more than OPENS_PER_TEN_MINUTES in ten minutes: the frame then
 *     shows the plain link to the product's page;
 *   - in a frame, given its buttons and its messages only on a site the
 *     creator listed (lib/embed-sites.ts), read from the Referer.
 */
import { headers } from "next/headers";
import { type Store } from "@/lib/store";
import { clientAddress, withinLimit } from "@/lib/request-guard";
import { isResting } from "@/lib/traffic";
import { SITE_URL } from "@/lib/site-url";
import { OPENS_PER_TEN_MINUTES, type ScriptMode, listedReturn, listedSite, scriptTags, scriptVia } from "@/lib/embed-sites";

export type ScriptOpen = {
  mode: ScriptMode;
  /** The listed site the frame is on, which alone is messaged; null on any other, or with no Referer. */
  site: string | null;
  /** Where to send the buyer back to after paying or signing up, on a listed site; null when none was given or it is not listed. */
  back: string | null;
  /** An affiliate's code on the link: the buy button then leads to the product's page with it, where the store's consent rules apply. */
  via: string | null;
  /** The link's utm tags, cleaned. */
  tags: Record<string, string>;
  /** Whether the card may show its buy button and the form its box; false shows the plain link. */
  live: boolean;
  /** Why not, for the page to say nothing more than it must. */
  reason: "" | "site" | "resting" | "limited";
};

/** Whether a Referer is a page of this site (or of the host this request was sent to). */
function fromThisSite(referer: string | null, host: string | null): boolean {
  if (!referer) return false;
  try {
    const url = new URL(referer);
    return url.origin === new URL(SITE_URL).origin || (Boolean(host) && url.host === host);
  } catch {
    return false;
  }
}

/** Reads the open and says what the page may show; the page counts the visit itself (components/store-beacon.tsx). Never throws. */
export async function readScriptOpen(store: Store, mode: ScriptMode, query: Record<string, unknown>): Promise<ScriptOpen> {
  const asked = await headers();
  const ip = clientAddress({ headers: asked });
  const referer = asked.get("referer");
  // A frame that moved on inside itself (the sign-up form's answer) was sent
  // here by a page of this site, which carried the listed site along; one
  // opened by any other page is judged by that page's own address alone.
  const site = listedSite(store.embedSites, referer) ?? (fromThisSite(referer, asked.get("host")) ? listedSite(store.embedSites, typeof query.site === "string" ? query.site : null) : null);
  const base = {
    mode,
    site,
    back: listedReturn(store.embedSites, query.return),
    via: scriptVia(query.via),
    tags: scriptTags(query),
  };
  // The visit itself is not counted here: an open is a request any program can send, and a visit is counted only
  // when the host's check says a person's browser sent it (app/api/store/hit). The page sends that count itself
  // (components/store-beacon.tsx, on the card and the sign-up form opened by the script).
  // A frame on a site the creator did not list shows the plain link and asks nothing more.
  if (mode === "overlay" && !site) return { ...base, live: false, reason: "site" };
  if (!(await withinLimit("embed-open", `${ip}|${store.handle}`, OPENS_PER_TEN_MINUTES, 600))) return { ...base, live: false, reason: "limited" };
  if (await isResting(store).catch(() => true)) return { ...base, live: false, reason: "resting" };
  return { ...base, live: true, reason: "" };
}
