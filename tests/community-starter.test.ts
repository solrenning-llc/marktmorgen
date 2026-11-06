/**
 * A ready set of spaces for a new community (487 [IT4], item 5; added 2
 * November 2026): offered only while General is all there is, never a name
 * already used; added through the manage route itself, as the studio does,
 * open to every member; the box's words, its button and where a refusal shows.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/community/manage/route";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { STARTER_SPACES, startersAddedWords, startersToAdd } from "@/lib/community-starter";
import { MAX_SPACE_ABOUT, MAX_SPACE_NAME } from "@/lib/community-text";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("Which are offered");
  is("three, each within the limits, with one line saying what goes there", [STARTER_SPACES.map((s) => s.name), STARTER_SPACES.every((s) => s.name.length <= MAX_SPACE_NAME && s.about.length > 0 && s.about.length <= MAX_SPACE_ABOUT && !/\d/.test(s.about))], [["Introductions", "Questions", "Wins"], true]);
  is("while General is all there is", startersToAdd([{ name: "General" }]).length, 3);
  is("never a name already used, in any case", startersToAdd([{ name: " wins " }]).map((s) => s.name), ["Introductions", "Questions"]);
  is("not once there is a second space, nor with none", [startersToAdd([{ name: "General" }, { name: "Chat" }]), startersToAdd([])], [[], []]);
  is("the words once added", [startersAddedWords(3), startersAddedWords(1)], ["Three spaces added. Rename, move or remove any of them in the Spaces list.", "One space added. Rename, move or remove any of them in the Spaces list."]);

  part("Added through the manage route, as the studio does");
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "spaceshop", "Space Shop", "Recipes.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  const store = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const call = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/community/manage", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify(body) }));
    return (await response.json()) as { ok: boolean; error?: string; config?: { spaces: { name: string; about: string; creatorOnly: boolean; only: string[]; level: number }[]; on?: boolean } };
  };
  const started = await call({ action: "enable", on: false });
  is("set up as the studio does: General only", [started.ok, started.error ?? null], [true, null]);
  let last: Awaited<ReturnType<typeof call>> | null = null;
  for (const s of startersToAdd([{ name: "General" }])) last = await call({ action: "space-add", name: s.name, about: s.about, creatorOnly: false, only: [], level: 0 });
  const spaces = last?.config?.spaces ?? [];
  is("each kept as written, open to every member, after General", [last?.ok, spaces.map((s) => s.name), spaces.slice(1).every((s, i) => s.about === STARTER_SPACES[i].about && !s.creatorOnly && s.only.length === 0 && s.level === 0)], [true, ["General", "Introductions", "Questions", "Wins"], true]);
  is("then no more offered", startersToAdd(spaces), []);

  part("In the studio");
  const source = readFileSync("components/community-studio.tsx", "utf8");
  is("one after another through the studio's own action, stopping at a refusal, the last saying what was done", [source.includes('run("space-starters", { action: "space-add", name: starters[i].name, about: starters[i].about, creatorOnly: false, only: [], level: 0 }, last ? startersAddedWords(starters.length) : "")'), source.includes("if (!answer.ok) {") && source.includes("break;"), source.includes("if (done) toast(done);")], [true, true, true]);
  is("a refusal shown in the Spaces section, which stays when the box goes, with what was added before it said; the focus to its heading either way", [source.includes('{problem("space-add")}\n      <StarterSpaces spaces={config.spaces} busy={busy} run={run} />\n      {/* Here, not in the ready set\'s box'), source.includes("if (added) toast(startersAddedWords(added));"), source.includes('document.getElementById("cm-spaces-title")?.focus()'), source.includes('<h2 id="cm-spaces-title" tabIndex={-1}')], [true, true, true, true]);
  is("after the 'Add a space' form, so its 'Or' follows it", source.indexOf("<StarterSpaces spaces=") > source.indexOf('<p className="field-label">Add a space</p>'), true);
  is("its heading names its list, its help is tied to its button", [source.includes('<h3 id="cm-starters-title"'), source.includes('aria-labelledby="cm-starters-title"'), source.includes('aria-describedby="cm-starters-help"')], [true, true, true]);
  done();
}

void main();
