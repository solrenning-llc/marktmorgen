/**
 * 568 [GD2] (c), the community's own settings: the words every member reads above it never pose as Marktmorgen.
 *
 * The community's name and description head its every page, and each space's name and description sit over its
 * posts. "Marktmorgen Support" as the community's name, or "Official Marktmorgen notices" as a space, reads to every
 * member as if we ran it, in the store's name, on marktmorgen.com. With the real route on the in-memory database and
 * a real creator session:
 *
 *   - a name or a description of the community or of a space that poses is not saved: the route answers 409
 *     "brand_imitation" with the part, the passage, why and the fix, no space is added, and what was kept stays;
 *   - plain words, saying the community runs on Marktmorgen and the protective opposite are saved as before;
 *   - the studio says which part, the passage, why and the fix, and that nothing was changed.
 *
 * Synthetic store and data only; nothing is emailed.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as manageRoute } from "@/app/api/store/community/manage/route";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readConfig } from "@/lib/community";
import { IMITATION_FIX, imitationMessage } from "@/lib/brand-imitation-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const OWNER = "settings@gd2csettings.example";
const POSING = "Marktmorgen Support: your account is locked until you verify it.";

type Passage = { field?: string; excerpt?: string; why?: string; fix?: string };
type Answer = { status: number; ok?: boolean; error?: string; passage?: Passage };

async function main(): Promise<void> {
  redis.clear();
  if (!(await claimHandle(OWNER, "gd2csettings", "Posing Settings", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  const store0 = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const call = async (body: Record<string, unknown>): Promise<Answer> => {
    const response = await manageRoute(new NextRequest("https://marktmorgen.com/api/store/community/manage", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store0.sid, cookie }, body: JSON.stringify(body) }));
    return { status: response.status, ...((await response.json()) as Omit<Answer, "status">) };
  };
  if (!(await call({ action: "enable", on: true })).ok) throw new Error("no community");
  const id = (await storeForEmail(OWNER))!.community!.id;
  const kept = async () => {
    const config = await readConfig(id);
    return { name: config?.name, about: config?.about, spaces: config?.spaces.map((s) => [s.name, s.about]) };
  };
  const space = (fields: Record<string, unknown>) => ({ action: "space-add", name: "Wins", about: "", creatorOnly: false, only: [], level: 0, ...fields });

  part("Plain settings are saved");
  const plain = await call({ action: "settings", name: "Bakers Club", about: "A place to share bakes. It runs on Marktmorgen, like the store." });
  is("saved", [plain.status, plain.ok, (await kept()).name], [200, true, "Bakers Club"]);
  const added = await call(space({ name: "Wins", about: "Share what worked." }));
  is("a plain space is added", [added.ok, (await kept()).spaces?.length], [true, 2]);
  const before = await kept();

  part("The community's name or description that poses is not saved");
  const named = await call({ action: "settings", name: "Marktmorgen Support", about: "Help for members." });
  is("its name: 409 brand_imitation", [named.status, named.error, named.passage?.field], [409, "brand_imitation", "name"]);
  is("the passage, why and the fix come with it", [named.passage?.excerpt, /members cannot be shown it\.$/.test(named.passage?.why ?? ""), named.passage?.fix], ["Marktmorgen Support", true, IMITATION_FIX]);
  const about = await call({ action: "settings", name: "Bakers Club", about: POSING });
  is("its description", [about.status, about.passage?.field], [409, "about"]);
  const lookalike = await call({ action: "settings", name: "Bakers Club", about: "Members sign in at https://marktmorgen-login.com first." });
  is("a look-alike address in its description", [lookalike.status, lookalike.passage?.field], [409, "about"]);
  is("nothing changed", await kept(), before);

  part("A space's name or description that poses is not saved");
  const spaceNamed = await call(space({ name: "Official Marktmorgen notices" }));
  is("a new space's name: refused, no space added", [spaceNamed.status, spaceNamed.error, spaceNamed.passage?.field, (await kept()).spaces?.length], [409, "brand_imitation", "space_name", 2]);
  const spaceAbout = await call(space({ name: "Help", about: "This is Marktmorgen: confirm your account here." }));
  is("a new space's description: refused, no space added", [spaceAbout.status, spaceAbout.passage?.field, (await kept()).spaces?.length], [409, "space_about", 2]);
  const wins = (await readConfig(id))!.spaces.find((s) => s.name === "Wins")!;
  const edited = await call(space({ action: "space-edit", id: wins.id, name: "Wins", about: "Reply with your Marktmorgen password to post here." }));
  is("an edit of a space: refused", [edited.status, edited.passage?.field], [409, "space_about"]);
  is("nothing changed", await kept(), before);

  part("The protective opposite is saved");
  const opposite = await call({ action: "settings", name: "Bakers Club", about: "Marktmorgen will never ask for your password, and neither will I." });
  is("saved", [opposite.ok, (await kept()).about], [true, "Marktmorgen will never ask for your password, and neither will I."]);
  is("a plain space edit is saved", [(await call(space({ action: "space-edit", id: wins.id, name: "Wins", about: "Share what worked this week." }))).ok, (await readConfig(id))!.spaces.find((s) => s.id === wins.id)?.about], [true, "Share what worked this week."]);

  part("What the studio says");
  is(
    "the part, the passage, why, the fix and that nothing was changed",
    imitationMessage(named.passage, "the community's name", "Nothing was saved"),
    `Nothing was saved. In the community's name: “Marktmorgen Support”. ${named.passage?.why} ${IMITATION_FIX} Nothing you wrote was changed.`,
  );
  const studio = readFileSync("components/community-studio.tsx", "utf8");
  is("the studio reads the refusal with the server's passage", /answer\.error === "brand_imitation"/.test(studio) && /imitationMessage\(answer\.passage/.test(studio), true);
  is("the studio names each part", ["the community's name", "the community's description", "the space's name", "the space's description"].every((words) => studio.includes(words)), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
