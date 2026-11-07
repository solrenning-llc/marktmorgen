import type { NextRequest } from "next/server";
import { clientAddress, limited, withinLimit, unknownLimit } from "@/lib/request-guard";
import { LINK_KEY, STEP_CAMPAIGN, noteClick } from "@/lib/mail-clicks";

/**
 * A page of a store opened through a link in a sequence's email, by somebody
 * who allowed their link use to be seen (components/mail-click.tsx,
 * lib/mail-clicks.ts). The answer is the same whatever happened, so it says
 * nothing about anybody.
 */
export async function POST(request: NextRequest) {
  const done = () => Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  let key = "";
  let campaign = "";
  try {
    const body = (await (await limited(request, 500)).json()) as { k?: unknown; c?: unknown };
    key = typeof body.k === "string" ? body.k : "";
    campaign = typeof body.c === "string" ? body.c : "";
  } catch {
    return done();
  }
  if (!LINK_KEY.test(key) || !STEP_CAMPAIGN.test(campaign)) return done();
  // Past the limit, or a count that could not be read (unknown, rule 24): the click is not noted, and the answer is the same.
  if ((await withinLimit("mail-clicked", clientAddress(request), 60, 3_600).catch(unknownLimit)) !== true) return done();
  await noteClick(key, campaign).catch((error) => console.error("noting a used link failed", error));
  return done();
}
