/** CX-118: a switcher preference must not strand an owner outside their own store. */
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { STORE_COOKIE, resolveAccess, studioView } from "@/lib/studio-route";
import { claimHandle, ensureStoreId, storeForEmail } from "@/lib/store";
import { putMember, removeMember, setRequireTwoStep } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "cookie-owner@example.test";
const OTHER = "cookie-other@example.test";
const NONE = "cookie-none@example.test";

async function main() {
  redis.clear();
  await claimHandle(OWNER, "cookie-own-fixture", "Own fixture", "");
  await claimHandle(OTHER, "cookie-team-fixture", "Team fixture", "");
  const own = await ensureStoreId((await storeForEmail(OWNER))!.email);
  const team = await ensureStoreId((await storeForEmail(OTHER))!.email);
  if (!own?.sid || !team?.sid) throw Error("Synthetic stores were not created");
  const session = await openSession(OWNER);
  const accessId = (result: Awaited<ReturnType<typeof resolveAccess>>) => result.ok ? result.access.store.sid : result.reason;
  const remember = (remembered: string, email = OWNER) => resolveAccess(email, { remembered, session }, null);
  const jar = (remembered: string) => ({ get(name: string) { return name === SESSION_COOKIE ? { value: session } : name === STORE_COOKIE ? { value: remembered } : undefined; } });

  part("Stale cookies already fall back without treating a pin as a preference");
  is("a different account's store falls back to the owned store", accessId(await remember(team.sid)), own.sid);
  is("an absent store falls back to the owned store", accessId(await remember("f".repeat(32))), own.sid);
  is("a malformed preference falls back to the owned store", accessId(await remember("invalid")), own.sid);
  is("an explicit foreign pin still refuses", accessId(await resolveAccess(OWNER, { pinned: team.sid, session }, null)), "gone");
  is("no owned or member store remains no_store", accessId(await remember(team.sid, NONE)), "no_store");
  await putMember(team, OWNER, "editor");
  is("a valid member preference opens the chosen store", accessId(await remember(team.sid)), team.sid);
  await removeMember(team, OWNER);
  is("leaving the team makes the preference fall back", accessId(await remember(team.sid)), own.sid);

  part("A remembered team without a live second step must not strand its owner elsewhere");
  await putMember(team, OWNER, "editor");
  await setRequireTwoStep(team, true, OTHER);
  is("the cookie alone still permits the person's own store", accessId(await remember(team.sid)), own.sid);
  const view = await studioView(jar(team.sid), undefined, null, { count: false });
  is("the actual studio view also reaches the owned store", view.ok ? view.view.store.sid : view.reason, own.sid);
  is("an explicit pin keeps the team's second-step requirement", accessId(await resolveAccess(OWNER, { pinned: team.sid, session }, null)), "two_step");
  is("choosing the owned store explicitly remains valid", accessId(await resolveAccess(OWNER, { pinned: own.sid, session }, null)), own.sid);
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
