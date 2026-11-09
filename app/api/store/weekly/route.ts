import type { NextRequest } from "next/server";
import { STORE_ID_PATTERN, normaliseHandle, storeForHandle, storeForId, type Store } from "@/lib/store";
import { limited } from "@/lib/request-guard";
import { addressLinkHolds, leaveWeeklyTeam, setWeeklyOff, weeklyMemberTokenOk, weeklyStoreTokenOk, weeklyTokenOk } from "@/lib/stats-report";

/**
 * Stops — or starts again — a store's weekly email, from the link at the foot
 * of the email itself (lib/stats-report.ts). The link carries the store and a
 * token signed for it, so nobody can stop somebody else's. A GET only shows
 * the button: mail apps open links to check them, and a stop must be a press.
 * The stop is kept by the store's id (lib/store-stop.ts), so it holds after
 * the store is renamed. The link names the store by its id too (weeklyStopUrl),
 * so it reaches the same store after a rename and never the store that takes
 * an address it let go of; a link signed for an address, from an email sent
 * before, reaches only a store known to have held it then (addressLinkHolds).
 */
function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d1b29}button{font:inherit;padding:.6rem 1.1rem;border-radius:.6rem;border:0;background:#5b3fd6;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A link's own words, checked: the store's id (absent from a link signed for an address), the address it shows,
 * a team member's address for their own copy, and the token signed for all of them. Null when it does not check.
 */
type Link = { sid: string | null; handle: string; email: string | null; token: string };

function read(request: NextRequest): Link | null {
  const params = request.nextUrl.searchParams;
  const raw = params.get("s");
  const sid = raw === null ? null : raw.slice(0, 40);
  const handle = normaliseHandle((params.get("h") ?? "").slice(0, 40));
  const given = params.get("e");
  const email = given === null ? null : given.slice(0, 200).toLowerCase();
  const token = (params.get("t") ?? "").slice(0, 64);
  if (!handle || email === "") return null;
  if (sid !== null) {
    return STORE_ID_PATTERN.test(sid) && weeklyStoreTokenOk(sid, handle, token, email ?? undefined) ? { sid, handle, email, token } : null;
  }
  const ok = email === null ? weeklyTokenOk(handle, token) : weeklyMemberTokenOk(handle, email, token);
  return ok ? { sid: null, handle, email, token } : null;
}

const actionOf = (link: Link) =>
  `/api/store/weekly?${link.sid ? `s=${link.sid}&` : ""}h=${encodeURIComponent(link.handle)}${link.email === null ? "" : `&e=${encodeURIComponent(link.email)}`}&t=${encodeURIComponent(link.token)}`;

/**
 * The store a pressed link changes, or why none: by its id when the link names it (gone when the store is); by
 * the address for a link signed for one, only while it leads to a store known to have held it when the link was
 * sent (lib/stats-report.ts, addressLinkHolds), never to the next store that took it.
 */
async function storeOf(link: Link): Promise<{ store: Store } | { refused: string }> {
  if (link.sid) {
    const store = await storeForId(link.sid);
    return store ? { store } : { refused: `The store this link was sent for, @${esc(link.handle)}, is not here anymore, so this link cannot change any emails.` };
  }
  const store = await storeForHandle(link.handle);
  if (!store) {
    return { refused: `The address @${esc(link.handle)} does not lead to a store anymore, so this link cannot change its emails. You can stop them with the link at the bottom of the newest one of these emails.` };
  }
  if (!addressLinkHolds(store, link.handle)) {
    return { refused: `The address @${esc(link.handle)} may belong to another store than the one this older link was sent for, so it cannot change its emails. You can stop them with the link at the bottom of the newest one of these emails.` };
  }
  return { store };
}

export async function GET(request: NextRequest) {
  const link = read(request);
  if (link?.email) {
    return page(
      "Weekly email",
      `<h1>Your copy of the weekly email</h1><p>You get the weekly email of @${esc(link.handle)} because its owner added you. This stops your copy only.</p><form method="post" action="${esc(actionOf(link))}"><button>Stop my copy</button></form>`,
    );
  }
  if (!link) return page("Link not recognized", "<p>This link is not one we recognize. You can stop these emails with the link at the bottom of the newest one.</p>", 400);
  return page(
    "Weekly email",
    `<h1>Emails about your numbers</h1><p>Every Monday we email the week of your store, @${esc(link.handle)}, while it has visitors, on a day that is clearly busier than usual we tell you while it is happening, and when your sales stop for clearly longer than usual we tell you that too.</p><form method="post" action="${esc(actionOf(link))}"><input type="hidden" name="do" value="off"><button>Stop these emails</button></form>`,
  );
}

/** Said when the change could not be confirmed (CX-123 rule 24): never "Stopped" or "On again" on an unknown answer. */
function notConfirmed(what: string): Response {
  return page("Not changed yet", `<h1>Not changed yet</h1><p>We could not confirm that ${what} just now. Please go back and press the button again in a minute.</p>`, 503);
}

export async function POST(request: NextRequest) {
  const link = read(request);
  if (!link) return page("Link not recognized", "<p>This link is not one we recognize.</p>", 400);
  const found = await storeOf(link);
  if ("refused" in found) return page("Store not found", `<h1>Nothing was changed</h1><p>${found.refused}</p>`, 404);
  const { store } = found;
  if (link.email !== null) {
    try {
      await leaveWeeklyTeam(store, link.email);
    } catch (error) {
      console.error("stopping a team member's weekly email could not be confirmed", error);
      return notConfirmed("your copy of the weekly email stopped");
    }
    return page("Stopped", `<h1>Stopped</h1><p>You will not get the weekly email of @${esc(store.handle)} anymore. The owner can add you again.</p>`);
  }
  const form = await limited(request, 2_000).then((r) => r.formData()).catch(() => null);
  const off = form?.get("do") !== "on";
  try {
    await setWeeklyOff(store, off);
  } catch (error) {
    console.error("stopping or starting the weekly email could not be confirmed", error);
    return notConfirmed(off ? "these emails stopped" : "these emails started again");
  }
  const action = actionOf(link);
  return off
    ? page(
        "Weekly email stopped",
        `<h1>Stopped</h1><p>You will not get the weekly email, the busy-day emails or the quiet-sales emails for @${esc(store.handle)} anymore. Your numbers are always in your studio.</p><form method="post" action="${esc(action)}"><input type="hidden" name="do" value="on"><button>Start it again</button></form>`,
      )
    : page("Emails on", `<h1>On again</h1><p>The weekly email for @${esc(store.handle)} will come every Monday while your store has visitors, and the busy-day and quiet-sales emails when they happen.</p>`);
}
