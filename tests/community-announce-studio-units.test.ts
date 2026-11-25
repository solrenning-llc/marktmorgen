/**
 * Claude 3 hujg on #5072 (LEVE 1): an owner's emailed announcement holds its place among the community's sends, at
 * most ANNOUNCE_PLACE_COMMANDS_MOST commands (lib/community-mail.ts), so app/api/store/community/route.ts takes
 * 1 + ANNOUNCE_PLACE_STUDIO_UNITS studio requests for it before anything is read; any other post takes one. Nothing
 * held the route's charge: a route taking one again passed every test.
 *
 * The real route, with lib/buyer-actions.ts recording each take (tests/community-announce-units-world.ts) and refusing
 * it, so the route answers "resting" right after its charge. Synthetic store over the in-memory Redis.
 */
import { NextRequest } from "next/server";
import { POST as communityPost } from "@/app/api/store/community/route";
import { POST as managePost } from "@/app/api/store/community/manage/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { ANNOUNCE_PLACE_STUDIO_UNITS } from "@/lib/community-mail";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId } from "@/lib/store";
import { setRefuse, taken } from "./community-announce-units-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const OWNER = "announce.units@example.com";
const HANDLE = "announceunits";
const ORIGIN = "https://marktmorgen.com";
const cookie = (session: string) => `${SESSION_COOKIE}=${session}`;
const json = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: cookie(session) }, body: JSON.stringify(body) });
const form = (session: string, fields: Record<string, string>) =>
  new NextRequest(`${ORIGIN}/api/store/community`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(session) }, body: new URLSearchParams({ handle: HANDLE, ...fields }) });

/** What one press takes, and whether the route answered "resting" for it. */
async function press(session: string, fields: Record<string, string>): Promise<{ took: { by: string; units: number }[]; resting: boolean }> {
  taken.length = 0;
  const response = await communityPost(form(session, fields));
  return { took: [...taken], resting: (response.headers.get("location") ?? "").endsWith(`/@${HANDLE}/resting`) };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Announce Units", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  const session = await openSession(OWNER);
  await managePost(json("/api/store/community/manage", session, { action: "enable", on: true }));
  setRefuse(true);

  part("an owner's emailed announcement takes the post's studio request and the place's, in one take");
  const emailed = await press(session, { action: "post", kind: "announcement", email: "1", title: "Synthetic", text: "Synthetic" });
  is("RED: one take of 1 + ANNOUNCE_PLACE_STUDIO_UNITS, as the owner", emailed.took, [{ by: "owner", units: 1 + ANNOUNCE_PLACE_STUDIO_UNITS }]);
  is("refused there, it answers resting", emailed.resting, true);

  part("any other post takes one");
  const plain = await press(session, { action: "post", kind: "announcement", title: "Synthetic", text: "Synthetic" });
  is("an announcement not emailed: one", plain.took, [{ by: "owner", units: 1 }]);
  const post = await press(session, { action: "post", title: "Synthetic", text: "Synthetic" });
  is("a post: one", post.took, [{ by: "owner", units: 1 }]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
