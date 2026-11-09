import type { NextRequest } from "next/server";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { limited } from "@/lib/request-guard";
import { leaveWeeklyTeam, setWeeklyOff, weeklyMemberTokenOk, weeklyTokenOk } from "@/lib/stats-report";

/**
 * Stops — or starts again — a store's weekly email, from the link at the foot
 * of the email itself (lib/stats-report.ts). The link carries the store and a
 * token signed for it, so nobody can stop somebody else's. A GET only shows
 * the button: mail apps open links to check them, and a stop must be a press.
 * The stop is kept by the store's id (lib/store-stop.ts), so it holds after
 * the store is renamed, and a link from before a rename still reaches it.
 */
function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d1b29}button{font:inherit;padding:.6rem 1.1rem;border-radius:.6rem;border:0;background:#5b3fd6;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function read(request: NextRequest): { handle: string; token: string } | null {
  const params = request.nextUrl.searchParams;
  const handle = normaliseHandle((params.get("h") ?? "").slice(0, 40));
  const token = (params.get("t") ?? "").slice(0, 64);
  return handle && weeklyTokenOk(handle, token) ? { handle, token } : null;
}

/** A team member's own copy (lib/stats-report.ts, weeklyTeam): the store, their address and a token signed for both. */
function readMember(request: NextRequest): { handle: string; email: string; token: string } | null {
  const params = request.nextUrl.searchParams;
  const handle = normaliseHandle((params.get("h") ?? "").slice(0, 40));
  const email = (params.get("e") ?? "").slice(0, 200).toLowerCase();
  const token = (params.get("t") ?? "").slice(0, 64);
  return handle && email && weeklyMemberTokenOk(handle, email, token) ? { handle, email, token } : null;
}

export async function GET(request: NextRequest) {
  const member = readMember(request);
  if (member) {
    const action = `/api/store/weekly?h=${encodeURIComponent(member.handle)}&e=${encodeURIComponent(member.email)}&t=${encodeURIComponent(member.token)}`;
    return page(
      "Weekly email",
      `<h1>Your copy of the weekly email</h1><p>You get the weekly email of @${esc(member.handle)} because its owner added you. This stops your copy only.</p><form method="post" action="${esc(action)}"><button>Stop my copy</button></form>`,
    );
  }
  const asked = read(request);
  if (!asked) return page("Link not recognized", "<p>This link is not one we recognize. Your weekly email can also be stopped by replying to it.</p>", 400);
  const action = `/api/store/weekly?h=${encodeURIComponent(asked.handle)}&t=${encodeURIComponent(asked.token)}`;
  return page(
    "Weekly email",
    `<h1>Emails about your numbers</h1><p>Every Monday we email the week of your store, @${esc(asked.handle)}, while it has visitors, on a day that is clearly busier than usual we tell you while it is happening, and when your sales stop for clearly longer than usual we tell you that too.</p><form method="post" action="${esc(action)}"><input type="hidden" name="do" value="off"><button>Stop these emails</button></form>`,
  );
}

export async function POST(request: NextRequest) {
  const member = readMember(request);
  if (member) {
    await leaveWeeklyTeam(member.handle, member.email);
    return page("Stopped", `<h1>Stopped</h1><p>You will not get the weekly email of @${esc(member.handle)} anymore. The owner can add you again.</p>`);
  }
  const asked = read(request);
  if (!asked) return page("Link not recognized", "<p>This link is not one we recognize.</p>", 400);
  const form = await limited(request, 2_000).then((r) => r.formData()).catch(() => null);
  const off = form?.get("do") !== "on";
  // The store the address leads to now: the same one under any address it still owns. An address it let go of
  // leads nowhere, and is never written as a stop, or the next store to take it would be stopped by this link.
  const store = await storeForHandle(asked.handle);
  if (!store) {
    return page(
      "Store not found",
      `<h1>Nothing was changed</h1><p>The address @${esc(asked.handle)} does not lead to a store anymore, so this link cannot change its emails. You can stop them with the link in a newer email, or by replying to one.</p>`,
      404,
    );
  }
  await setWeeklyOff(store, off);
  const action = `/api/store/weekly?h=${encodeURIComponent(asked.handle)}&t=${encodeURIComponent(asked.token)}`;
  return off
    ? page(
        "Weekly email stopped",
        `<h1>Stopped</h1><p>You will not get the weekly email, the busy-day emails or the quiet-sales emails for @${esc(asked.handle)} anymore. Your numbers are always in your studio.</p><form method="post" action="${esc(action)}"><input type="hidden" name="do" value="on"><button>Start it again</button></form>`,
      )
    : page("Emails on", `<h1>On again</h1><p>The weekly email for @${esc(asked.handle)} will come every Monday while your store has visitors, and the busy-day and quiet-sales emails when they happen.</p>`);
}
