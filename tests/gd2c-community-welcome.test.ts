/**
 * 568 [GD2] (c), welcoming new members: what the store sends and asks a new member never poses as Marktmorgen.
 *
 * The welcome goes privately, from the creator, to every member the first time they come in; the questions are asked
 * of every member before their first post or comment. "Marktmorgen Support: verify your account" there reaches every
 * new member in the store's name, inside a page on marktmorgen.com. With the real route on the in-memory database
 * and a real creator session:
 *
 *   - a welcome or a question that poses is not saved: the route answers 409 "brand_imitation" with the part, the
 *     passage, why and the fix, and the welcome and questions kept stay as they were;
 *   - plain words, saying the community runs on Marktmorgen and the protective opposite are saved as before;
 *   - a welcome kept from before that poses is not sent to a member coming in; a plain one is;
 *   - the studio says which part, the passage, why and the fix, and that nothing was changed.
 *
 * Synthetic store, member and data only; nothing is emailed.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as manageRoute } from "@/app/api/store/community/manage/route";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readConfig, saveConfig, touchMember } from "@/lib/community";
import { welcome } from "@/lib/community-access";
import { inbox, parseDmSetting } from "@/lib/community-dm";
import { IMITATION_FIX, imitationMessage } from "@/lib/brand-imitation-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const OWNER = "welcome@gd2cwelcome.example";
const POSING = "Marktmorgen Support: your account is locked until you verify it.";

type Passage = { field?: string; excerpt?: string; why?: string; fix?: string };
type Answer = { status: number; ok?: boolean; error?: string; passage?: Passage };

async function main(): Promise<void> {
  redis.clear();
  if (!(await claimHandle(OWNER, "gd2cwelcome", "Posing Welcome", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  const store0 = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const call = async (body: Record<string, unknown>): Promise<Answer> => {
    const response = await manageRoute(new NextRequest("https://marktmorgen.com/api/store/community/manage", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store0.sid, cookie }, body: JSON.stringify(body) }));
    return { status: response.status, ...((await response.json()) as Omit<Answer, "status">) };
  };
  if (!(await call({ action: "enable", on: true })).ok) throw new Error("no community");
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  const kept = async () => {
    const config = await readConfig(id);
    return [config?.questions, config?.welcome];
  };

  part("A plain welcome and plain questions are saved");
  const plain = await call({ action: "onboarding", questions: ["What do you bake?"], welcome: "Welcome in. This club runs on Marktmorgen, like the store." });
  is("saved", [plain.status, plain.ok, await kept()], [200, true, [["What do you bake?"], "Welcome in. This club runs on Marktmorgen, like the store."]]);

  part("A welcome or a question that poses is not saved, and what was kept stays");
  const posingWelcome = await call({ action: "onboarding", questions: ["What do you bake?"], welcome: POSING });
  is("the welcome: 409 brand_imitation", [posingWelcome.status, posingWelcome.error, posingWelcome.passage?.field], [409, "brand_imitation", "welcome"]);
  is("the passage, why and the fix come with it", [posingWelcome.passage?.excerpt?.includes("Marktmorgen Support"), /new members cannot be welcomed with it\.$/.test(posingWelcome.passage?.why ?? ""), posingWelcome.passage?.fix], [true, true, IMITATION_FIX]);
  is("nothing changed", await kept(), [["What do you bake?"], "Welcome in. This club runs on Marktmorgen, like the store."]);
  const posingQuestion = await call({ action: "onboarding", questions: ["What do you bake?", "What is your Marktmorgen password?"], welcome: "Welcome in." });
  is("a question: 409 brand_imitation", [posingQuestion.status, posingQuestion.error, posingQuestion.passage?.field], [409, "brand_imitation", "question"]);
  const lookalike = await call({ action: "onboarding", questions: [], welcome: "Welcome! Confirm your place at https://marktmorgen-login.com today." });
  is("a look-alike address in the welcome", [lookalike.status, lookalike.passage?.field], [409, "welcome"]);
  is("nothing changed", await kept(), [["What do you bake?"], "Welcome in. This club runs on Marktmorgen, like the store."]);

  part("The protective opposite is saved");
  const opposite = await call({ action: "onboarding", questions: ["What do you bake?"], welcome: "Welcome in. Marktmorgen will never ask for your password, and neither will I." });
  is("saved", [opposite.ok, (await kept())[1]], [true, "Welcome in. Marktmorgen will never ask for your password, and neither will I."]);

  part("A welcome kept from before that poses is not sent");
  const config = (await readConfig(id))!;
  await saveConfig(id, { ...config, dm: parseDmSetting({ on: true, between: false }), welcome: POSING });
  const first = await touchMember(id, "first@gd2cwelcome.example", null, store);
  if (!first) throw new Error("no member");
  const posingKept = (await readConfig(id))!;
  is("not sent, and the member's inbox is empty", [await welcome(id, posingKept, first.k, store), (await inbox(id, first.k)).length + (await inbox(id, first.k, true)).length], [false, 0]);
  await saveConfig(id, { ...posingKept, welcome: "Welcome in." });
  const second = await touchMember(id, "second@gd2cwelcome.example", null, store);
  if (!second) throw new Error("no member");
  is("a plain welcome is sent", [await welcome(id, (await readConfig(id))!, second.k, store), (await inbox(id, second.k)).length + (await inbox(id, second.k, true)).length], [true, 1]);

  part("What the studio says");
  is(
    "the part, the passage, why, the fix and that nothing was changed",
    imitationMessage(posingWelcome.passage, "the welcome message", "Nothing was saved"),
    `Nothing was saved. In the welcome message: “${posingWelcome.passage?.excerpt}”. ${posingWelcome.passage?.why} ${IMITATION_FIX} Nothing you wrote was changed.`,
  );
  const studio = readFileSync("components/community-studio.tsx", "utf8");
  is("the studio reads the refusal with the server's passage", /answer\.error === "brand_imitation"/.test(studio) && /imitationMessage\(answer\.passage/.test(studio), true);
  is("the studio names the welcome and a question", ["the welcome message", "one of your questions"].every((words) => studio.includes(words)), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
