/**
 * Issue #4069 (Codex C2, MEDIUM; rule 24): GET /api/v1/members (lib/api-read.ts members) built each page from
 * lib/community.ts memberPage, which left out, without a word, a member whose record did not read
 * (`if (member) members.push(member)`). A developer's sync was then told nothing of the member it never got. The
 * list of contacts (GET /api/v1/leads) already says how many it left out in `unreadable`; now the members page does
 * the same: a page that left a member out says how many, and a page without the field left nobody out.
 *
 * Synthetic data only: the in-memory Redis and a synthetic store.
 */
import { freshConfig, memberPage, saveConfig } from "@/lib/community";
import { members as apiMembers } from "@/lib/api-read";
import { claimHandle, ensureListId, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const memberRecord = (k: string, e: string, n: string) =>
  JSON.stringify({ k, e, n, h: "", dir: false, mail: true, at: 1_700_000_000, seen: 1_700_000_100, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] });

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const owner = "members-unreadable@example.com";
  await claimHandle(owner, "membersunreadable", "Members Unreadable", "A community.");
  await ensureStatsId(owner);
  await setSubscription(owner, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  await ensureListId(owner);
  await setCommunity(owner, true);
  const store = (await storeForEmail(owner))!;
  const id = store.community!.id;
  await saveConfig(id, freshConfig(store.name));
  const key = `nl:cm:${id}:m`;
  const read = async () => (await apiMembers(store, null, async () => async () => null)) as { data: { email: string }[]; next: string | null; unreadable?: number };

  part("Control: every member read, no field");
  redis.run(["HSET", key, "a".repeat(32), memberRecord("a".repeat(32), "one@example.com", "One"), "b".repeat(32), memberRecord("b".repeat(32), "two@example.com", "Two")]);
  if ((await memberPage(id, "0", 10)).members.length !== 2) throw new Error(`the members key is not ${key}`);
  let page = await read();
  is("both members", page.data.map((m) => m.email).sort(), ["one@example.com", "two@example.com"]);
  is("no unreadable field", "unreadable" in page, false);

  part("A member whose record does not read: left out, and said");
  redis.run(["HSET", key, "c".repeat(32), "{\"k\":\"cccc"]);
  page = await read();
  is("the two that read", page.data.map((m) => m.email).sort(), ["one@example.com", "two@example.com"]);
  is("one unreadable, said", page.unreadable, 1);
  is("memberPage says it too", (await memberPage(id, "0", 10)).unreadable, 1);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
