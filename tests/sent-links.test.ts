/**
 * Following a changeable link of a sent email (124 [F2-EDIT-SENT-LINKS],
 * unit 2: lib/sent-links.ts followSentLink and the /r/... route).
 *
 * What fails here:
 *   - a link that is not signed for that store, email, number and address
 *     followed anywhere, or costing a database read;
 *   - a click not counted as one of the store's public requests before the
 *     change is read (then the store is resting, and the reader is sent to
 *     its resting page, never somewhere unchecked);
 *   - a change that could not be read taken as none (the creator may have
 *     changed a wrong address): it is "unknown", never the old address;
 *   - a kept change ignored, or one that does not read followed.
 */
import { LINKS_KEY, followSentLink, keepLinkChange, signSentLink, verifySentLink } from "@/lib/sent-links";
import { MAX_LINK_CHANGES } from "@/lib/sent-link-rules";
import { sentLinkPath } from "@/lib/sent-link-rules";
import * as route from "@/app/r/[sid]/[id]/[n]/route";
import type { NextRequest } from "next/server";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SID = "aaaabbbbccccddddeeeeffff00001111";
const ID = "0123456789abcdef01234567";
const GUIDE = "https://example.com/guide";
const shop = { handle: "clayhouse", sid: SID } as Store;
let reads = 0;
let taken = 0;
const deps = (over: Record<string, unknown> = {}) => ({
  loadStore: async (sid: string) => { reads += 1; return sid === SID ? shop : null; },
  take: async () => { taken += 1; return true; },
  ...over,
});
const query = (n: number, original = GUIDE) => {
  const path = sentLinkPath(SID, ID, n, original, signSentLink) as string;
  const url = new URL(`https://marktmorgen.com${path}`);
  return { u: url.searchParams.get("u") ?? undefined, s: url.searchParams.get("s") ?? undefined };
};

(async () => {
  redis.clear();
  part("Signed with the server's own key");
  is("a signature of 32 hex", /^[0-9a-f]{32}$/.test(signSentLink("x") ?? ""), true);
  is("checked", verifySentLink("x", signSentLink("x") as string), true);
  is("another text: refused", verifySentLink("y", signSentLink("x") as string), false);

  part("Nothing changed: where it was written to go, after the click is counted");
  taken = 0;
  is("goes", await followSentLink({ sid: SID, id: ID, n: "2", query: query(2), now: 1 }, deps()), { kind: "go", to: GUIDE });
  is("the store's public requests taken first, once", taken, 1);

  part("Changed: the newest change");
  redis.run(["HSET", LINKS_KEY(ID), "2", JSON.stringify([{ to: "https://example.com/guide-v2", at: 5 }, { to: "https://example.com/old", at: 3 }])]);
  is("goes to the change", await followSentLink({ sid: SID, id: ID, n: "2", query: query(2), now: 1 }, deps()), { kind: "go", to: "https://example.com/guide-v2" });
  is("another link of the same email is untouched", await followSentLink({ sid: SID, id: ID, n: "3", query: query(3, "https://example.com/three"), now: 1 }, deps()), { kind: "go", to: "https://example.com/three" });
  redis.run(["HSET", LINKS_KEY(ID), "4", JSON.stringify([{ to: "javascript:alert(1)", at: 5 }])]);
  is("a kept change that is not an address: where it was written", await followSentLink({ sid: SID, id: ID, n: "4", query: query(4, "https://example.com/four"), now: 1 }, deps()), { kind: "go", to: "https://example.com/four" });

  part("Refused, with no read at all");
  let calls = 0;
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (commands) => { calls += 1; return pipeline(commands); };
  reads = 0;
  is("another address under the signature (no open redirect)", await followSentLink({ sid: SID, id: ID, n: "2", query: { ...query(2), u: "https://evil.example/" }, now: 1 }, deps()), { kind: "invalid" });
  is("another store", await followSentLink({ sid: "bbbbbbbbccccddddeeeeffff00001111", id: ID, n: "2", query: query(2), now: 1 }, deps()), { kind: "invalid" });
  is("no signature", await followSentLink({ sid: SID, id: ID, n: "2", query: { u: GUIDE }, now: 1 }, deps()), { kind: "invalid" });
  is("no database command and no store read", [calls, reads], [0, 0]);
  redis.pipeline = pipeline;

  part("Resting and unknown");
  is("the store's month is spent: its resting page, never an unchecked address", await followSentLink({ sid: SID, id: ID, n: "2", query: query(2), now: 1 }, deps({ take: async () => false })), { kind: "resting", handle: "clayhouse" });
  is("the store is gone", await followSentLink({ sid: SID, id: ID, n: "2", query: query(2), now: 1 }, deps({ loadStore: async () => null })), { kind: "unknown" });
  is("the month could not be read", await followSentLink({ sid: SID, id: ID, n: "2", query: query(2), now: 1 }, deps({ take: async () => { throw new Error("down"); } })), { kind: "unknown" });
  redis.run(["HSET", LINKS_KEY(ID), "2", "{not json"]);
  is("a change that does not read: unknown, never the old address", await followSentLink({ sid: SID, id: ID, n: "2", query: query(2), now: 1 }, deps()), { kind: "unknown" });
  redis.run(["HSET", LINKS_KEY(ID), "2", JSON.stringify({ to: GUIDE })]);
  is("a history that is not a list: unknown", await followSentLink({ sid: SID, id: ID, n: "2", query: query(2), now: 1 }, deps()), { kind: "unknown" });

  part("Keeping a change: only the store's own email, room taken first");
  redis.clear();
  const email = (listId: string) => JSON.stringify({ id: ID, listId, handle: "clayhouse", subject: "News", body: "Hello", productId: null, notProductId: null, who: "all", narrow: null, status: "sent", createdAt: 1, sendAt: 1, finishedAt: 2, total: 3, sent: 3, note: "", failures: 0, listed: true, tagged: true, test: null });
  redis.run(["SET", `nl:mail:bc:${ID}`, email("list1")]);
  const owner = { handle: "clayhouse", sid: SID, listId: "list1" } as Store;
  let room: { until: number; bytes: number }[] = [];
  const roomDeps = (ok = true) => ({ take: async (_: Store, change: { until: number; bytes: number }) => { room.push(change); return ok; } });
  const kept = await keepLinkChange(owner, ID, 2, GUIDE, "https://example.com/guide-v2", 1_000, roomDeps());
  is("kept", kept, { ok: true, history: [{ to: "https://example.com/guide-v2", at: 1_000 }] });
  is("then followed", await followSentLink({ sid: SID, id: ID, n: "2", query: query(2), now: 1 }, deps()), { kind: "go", to: "https://example.com/guide-v2" });
  is("room taken once, for what it keeps, until it goes", room.length === 1 && room[0].bytes >= JSON.stringify(kept.ok ? kept.history : []).length && room[0].until > 1_000, true);
  is("kept as long as the email", Number(redis.run(["TTL", LINKS_KEY(ID)])) > 300 * 86_400, true);
  is("the same address again: nothing kept", await keepLinkChange(owner, ID, 2, GUIDE, "https://example.com/guide-v2", 2_000, roomDeps()), { ok: false, problem: "same" });
  is("not an address", await keepLinkChange(owner, ID, 2, GUIDE, "javascript:x", 2_000, roomDeps()), { ok: false, problem: "address" });
  room = [];
  is("another store's email: none, nothing kept", await keepLinkChange({ ...owner, listId: "list2" } as Store, ID, 2, GUIDE, "https://example.com/x", 2_000, roomDeps()), { ok: false, problem: "none" });
  is("a link number past the most: none", await keepLinkChange(owner, ID, 99, GUIDE, "https://example.com/x", 2_000, roomDeps()), { ok: false, problem: "none" });
  is("no room taken for them", room, []);
  is("the room is full: refused, nothing kept", await keepLinkChange(owner, ID, 3, "https://example.com/three", "https://example.com/x", 2_000, roomDeps(false)), { ok: false, problem: "full" });
  is("nothing kept for that link", redis.run(["HGET", LINKS_KEY(ID), "3"]), null);
  for (let i = 0; i < MAX_LINK_CHANGES + 3; i += 1) await keepLinkChange(owner, ID, 5, "https://example.com/five", `https://example.com/v${i}`, 3_000 + i, roomDeps());
  is("at most MAX_LINK_CHANGES kept", JSON.parse(String(redis.run(["HGET", LINKS_KEY(ID), "5"]))).length, MAX_LINK_CHANGES);
  redis.run(["HSET", LINKS_KEY(ID), "6", "{not json"]);
  is("a kept history that does not read: unknown, nothing written over it", [await keepLinkChange(owner, ID, 6, GUIDE, "https://example.com/x", 4_000, roomDeps()), redis.run(["HGET", LINKS_KEY(ID), "6"])], [{ ok: false, problem: "unknown" }, "{not json"]);

  part("The route");
  is("GET and HEAD only", Object.keys(route).sort(), ["GET", "HEAD"]);
  const params = (n: string) => ({ params: Promise.resolve({ sid: SID, id: ID, n }) });
  const bad = await route.GET(new Request(`https://marktmorgen.com/r/${SID}/${ID}/2?u=${encodeURIComponent("https://evil.example/")}&s=${query(2).s}`) as NextRequest, params("2"));
  is("a bad link: a plain refusal, never a redirect", [bad.status, bad.headers.get("Location")], [404, null]);
  is("never cached, never indexed", [bad.headers.get("Cache-Control"), bad.headers.get("X-Robots-Tag")], ["no-store", "noindex"]);

  done();
})();
