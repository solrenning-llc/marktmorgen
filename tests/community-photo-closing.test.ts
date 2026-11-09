/**
 * A posted picture's mark (lib/community-files.ts) is kept for as long as its post keeps the picture, so when the
 * store itself closes the closing walk must take it with the post (Claude 6's focal review of #3414 at 65cef46a6a,
 * 9 November 2026: the mark had no expiry and nothing removed it when the store closed). And a post never takes a
 * picture from outside its own community's folder, which would leave a mark that nothing removes (rule 30, same
 * review).
 *
 * Synthetic only: the real closing walk (lib/closed-store-data.ts walkPage), the real community post route, the
 * in-memory Redis.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { walkPage, type Batched } from "@/lib/closed-store-data";
import { CLOSING } from "@/lib/data-families";
import { noteCommunityUpload, takeCommunityUpload } from "@/lib/community-files";
import { communityFolder } from "@/lib/community-image";
import { POST as communityPost } from "@/app/api/store/community/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { CREATOR, freshConfig, saveConfig } from "@/lib/community";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const noteKey = (path: string) => `nl:cimg:${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
const exists = async (key: string) => (await redis.pipeline([["EXISTS", key]]))[0];

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("The closing walk takes a posted picture's mark with its post");
  {
    const closing = "closingcommunity1";
    const staying = "stayingcommunity1";
    const pathOf = (community: string, c: string) => `community/${communityFolder(community)}/${c.repeat(32)}.webp`;
    const gone = pathOf(closing, "a");
    const kept = pathOf(staying, "b");
    for (const [community, path, post] of [[closing, gone, "p1"], [staying, kept, "p2"]] as const) {
      await noteCommunityUpload(path, "member");
      await takeCommunityUpload(path, "member");
      await redis.pipeline([["SET", `nl:cm:${community}:p:${post}`, JSON.stringify({ id: post, img: { path, w: 1, h: 1, alt: "" } })]]);
    }
    is("the closing store's mark has no expiry", (await redis.pipeline([["TTL", noteKey(gone)]]))[0], -1);
    const entry = { ref: "ref-closing", email: "", sid: "", statsId: null, name: "", handle: "closing", handles: [], marks: [closing], endedAt: 0 } as unknown as Batched;
    const owners = { byMark: new Map([[closing, entry.ref]]), byHandle: new Map<string, string>(), byRef: new Map([[entry.ref, entry.ref]]) };
    await walkPage([`nl:cm:${closing}:p:p1`, `nl:cm:${staying}:p:p2`, noteKey(gone), noteKey(kept)], new Map([[entry.ref, entry]]), owners as never);
    is("the closing store's post is gone", await exists(`nl:cm:${closing}:p:p1`), 0);
    is("and so is its picture's mark", await exists(noteKey(gone)), 0);
    is("another store's post stays", await exists(`nl:cm:${staying}:p:p2`), 1);
    is("and so does its picture's mark", await exists(noteKey(kept)), 1);
    const rule = CLOSING["nl:cimg:"] as { how: string; via?: string; rest?: number };
    is("the registry says the marks go through the community's posts, and a door's note within a day", [rule.how, rule.via, rule.rest], ["token", "nl:cm:", 1]);
  }

  part("A post never takes a picture from outside its own community's folder");
  {
    const OWNER = "club@photoclosing.example";
    const made = await claimHandle(OWNER, "photoclosingclub", "Photo Closing Club", "");
    if (!made.ok) throw new Error("no store");
    await ensureStatsId(OWNER);
    await ensureStoreId(OWNER);
    await ensureListId(OWNER);
    await setSubscription(OWNER, { customerId: "cus_PhotoClosing1", subscriptionId: "sub_PhotoClosing1", active: true, tier: "creator", period: paidPeriod() });
    await setCommunity(OWNER, true);
    const club = (await storeForEmail(OWNER))!;
    await saveConfig(club.community!.id, freshConfig(club.name));
    const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
    // A door the creator holds for a picture in some other community's folder.
    const foreign = `community/${communityFolder("another-community")}/${"c".repeat(32)}.webp`;
    is("the foreign door is noted", await noteCommunityUpload(foreign, CREATOR), true);
    const form = new FormData();
    form.set("handle", club.handle);
    form.set("action", "post");
    form.set("text", "Look at this");
    form.set("img", foreign);
    form.set("img_w", "10");
    form.set("img_h", "10");
    const response = await communityPost(new NextRequest("https://marktmorgen.com/api/store/community", { method: "POST", headers: { cookie }, body: form }));
    is("the post is refused for its picture", (response.headers.get("location") ?? "").includes("image"), true);
    const [held] = await redis.pipeline([["GET", noteKey(foreign)]]);
    is("the foreign picture was not taken: its note is still the creator's door, never a mark", held, CREATOR);
  }
  done();
}

void main();
