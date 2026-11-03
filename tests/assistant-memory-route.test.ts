/**
 * 639 [GL7](40), unit 3: the studio's route for the creator's notes to their
 * assistant (app/api/store/assistant-memory/route.ts), through the real
 * route, session and store. Every note listed; added, changed, removed, all
 * forgotten at once; anyone's details refused with words that say what to
 * do; only for someone who may change the store's settings.
 */
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/store/assistant-memory/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { MAX_MEMORY_NOTE, NOTE_REFUSALS } from "@/lib/assistant-memory-rules";
import { readMemory } from "@/lib/assistant-memory-store";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Note = { id: string; kind: string; text: string };
type Reply = { ok?: boolean; error?: string; message?: string; notes?: Note[]; most?: number };

async function main(): Promise<void> {
  redis.clear();
  const owner = "memory@example.com";
  await claimHandle(owner, "memoryshop", "Memory Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_memory", subscriptionId: "sub_memory", active: true, tier: "creator", period: paidPeriod() });
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = { cookie }) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/assistant-memory", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const list = async () => (await (await GET(new NextRequest("https://marktmorgen.com/api/store/assistant-memory", { headers: { cookie } }))).json()) as Reply;
  const statsId = (await storeForEmail(owner))!.statsId;

  part("Every note, listed");
  is("none yet, with the most a store keeps", [(await list()).notes, (await list()).most], [[], 30]);
  const added = await post({ action: "add", kind: "preference", text: "Write in a warm, plain voice." });
  is("added", [added.status, added.body.notes?.map((note) => note.text)], [200, ["Write in a warm, plain voice."]]);
  await post({ action: "add", kind: "instruction", text: "Never offer a discount above 20%." });
  is("listed for the studio, in order", (await list()).notes?.map((note) => note.kind), ["preference", "instruction"]);

  part("Never anyone's details, and never cut");
  const personal = await post({ action: "add", kind: "preference", text: "Answer jane@example.com first" });
  is("an address refused, saying what to do", [personal.status, personal.body.error, personal.body.message], [400, "personal", NOTE_REFUSALS.personal]);
  is("too long refused", (await post({ action: "add", kind: "preference", text: "x".repeat(MAX_MEMORY_NOTE + 1) })).body.error, "long");
  is("no kind refused", (await post({ action: "add", kind: "rule", text: "Be brief." })).body.error, "kind");
  is("nothing written by a refusal", (await readMemory(statsId)).length, 2);

  part("Changed, removed, forgotten");
  const first = (await list()).notes![0].id;
  is("changed in place, its kind kept", (await post({ action: "edit", id: first, text: "Write in a short, plain voice." })).body.notes?.[0], { ...(await readMemory(statsId))[0], text: "Write in a short, plain voice." });
  is("a change with a link refused", (await post({ action: "edit", id: first, text: "See www.example.com" })).body.error, "personal");
  is("a note that is gone", [(await post({ action: "edit", id: "zzzzzzzzzz", text: "Anything" })).status, (await post({ action: "edit", id: "zzzzzzzzzz", text: "Anything" })).body.error], [404, "unknown"]);
  is("one removed", (await post({ action: "remove", id: first })).body.notes?.length, 1);
  is("every note forgotten at once", [(await post({ action: "forget" })).body.notes, await readMemory(statsId)], [[], []]);
  is("an action that is not one", (await post({ action: "learn" })).body.error, "unknown");

  part("Only for the store's own team");
  const stranger = await post({ action: "add", kind: "preference", text: "Be brief." }, {});
  is("no session: refused", stranger.status >= 400 && stranger.status < 500, true);
  is("and nothing kept", (await readMemory(statsId)).length, 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
