/**
 * 612 [WP11], unit 1: the owner may require two-step sign-in of the team
 * (lib/team.ts, lib/studio-route.ts). With it on, a member without an
 * authenticator app or a passkey opens nothing of the store; with either,
 * they do; the owner always does; a member joining or leaving never switches
 * it off; the activity log records who switched it. Synthetic records only.
 */
import { createHash } from "node:crypto";
import { putMember, readLog, readTeam, removeMember, setRequireTwoStep } from "@/lib/team";
import { refusedJson, resolveAccess } from "@/lib/studio-route";
import { claimHandle, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const OWNER = "owner-2fa@example.com";
const ANA = "ana-2fa@example.com";
const BEN = "ben-2fa@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "team-two-step", "Team Two Step", "");
  const store = (await ensureStoreId((await storeForEmail(OWNER))!.email)) ?? (await storeForEmail(OWNER))!;
  if (!store.sid) throw new Error("no store id");
  await putMember(store, ANA, "editor");
  await putMember(store, BEN, "support");
  const open = async (email: string) => {
    const r = await resolveAccess(email, { pinned: store.sid }, null);
    return r.ok ? "open" : r.reason;
  };

  part("Off: everybody on the team opens the studio as before");
  is("owner", await open(OWNER), "open");
  is("a member with no second step", await open(ANA), "open");

  part("On: a member without a second step opens nothing");
  is("switched on", await setRequireTwoStep(store, true, OWNER), true);
  is("the team record says so", (await readTeam(store.sid)).requireTwoStep, true);
  is("the owner still opens it", await open(OWNER), "open");
  is("a member without a second step is refused", await open(ANA), "two_step");
  const refused = refusedJson("two_step");
  is("a route answers 403 with its own error", [refused.status, ((await refused.json()) as { error: string }).error], [403, "two_step_required"]);

  part("With an authenticator app or a passkey, they open it");
  await redis.pipeline([["SET", `nl:2fa:${sha(`nimbus-2fa:${ANA}`).slice(0, 40)}`, JSON.stringify({ s: "JBSWY3DPEHPK3PXP", since: 1, codes: [], last: -1 })]]);
  is("an authenticator app", await open(ANA), "open");
  is("Ben still has none", await open(BEN), "two_step");
  await redis.pipeline([["SET", `nl:pk:${sha(`nimbus-passkeys:${BEN}`).slice(0, 40)}`, JSON.stringify([{ id: "cred1", publicKey: "pk1", counter: 0, transports: [], name: "Phone", createdAt: "", lastUsedAt: "", synced: true }])]]);
  is("a passkey", await open(BEN), "open");

  part("Team changes never switch it off");
  await putMember(store, "cara-2fa@example.com", "editor");
  is("after someone joins", (await readTeam(store.sid)).requireTwoStep, true);
  await removeMember(store, "cara-2fa@example.com");
  is("after someone leaves", (await readTeam(store.sid)).requireTwoStep, true);

  part("Off again, and the log says who did each");
  await setRequireTwoStep(store, false, OWNER);
  await redis.pipeline([["DEL", `nl:pk:${sha(`nimbus-passkeys:${BEN}`).slice(0, 40)}`]]);
  is("a member without a second step opens it again", await open(BEN), "open");
  const lines = (await readLog(store.sid)).map((l) => `${l.who}: ${l.what}`);
  is("both switches are in the activity log", [lines.includes(`${OWNER}: Required two-step sign-in for the team`), lines.includes(`${OWNER}: Stopped requiring two-step sign-in for the team`)], [true, true]);

  done();
}

void main();
