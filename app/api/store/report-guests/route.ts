import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { saveShare } from "@/lib/report-guests";
import { sendInvites } from "@/lib/report-guests-mail";
import { FIGURES_OFFERED, shareView } from "@/lib/report-guests-rules";
import { readTeam } from "@/lib/team";

/**
 * The numbers email to addresses outside the team (405 [HX1]): saves the
 * figures, how often and up to three addresses, `{ figures, every,
 * addresses }`, for whoever runs the team. A new address is sent its
 * invitation, taken from the store's emails first; answers the list as kept
 * and the addresses whose invitation did not go. An address on the team, or
 * the owner's own, is refused: the team has its own copy.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "team", 4_000);
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  if (!store.sid) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  if (Array.isArray(body.figures) && body.figures.some((figure) => !FIGURES_OFFERED.includes(figure as never))) {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  try {
    // The team as it is now, read exactly (lib/team.ts): an unknown team refuses the save, never lets a member in as a guest.
    const team = await readTeam(store.sid);
    // Someone invited to the team counts as on it: the team's own copy is theirs once they join.
    const people = { team: [...team.members, ...team.invites].map((m) => m.email), owner: store.email };
    const saved = await saveShare(store.sid, { figures: body.figures, every: body.every, addresses: body.addresses }, people);
    if (!saved.ok) return Response.json({ ok: false, error: saved.why, address: saved.address }, { status: saved.why === "no_key" ? 503 : 400 });
    const notSent = await sendInvites(store, saved.share, saved.invites);
    return Response.json({ ok: true, ...shareView(saved.share, Date.now()), notSent }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("saving the numbers email's outside addresses failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 503 });
  }
}
