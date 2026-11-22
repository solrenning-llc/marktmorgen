/**
 * Claude 2's MEDIUM on #3584 (7078145142): an answer kept in a reserved place carries its account's mark
 * (reservedFor), so the person's copy and their erasure must find it by the account as well as by the typed address,
 * also when account A typed address X. The mark is keyed with this deployment's secret (lib/secret-box.ts), so it
 * cannot be found from an address alone. app/api/creators/route.ts, lib/creator-research-store.ts; synthetic answers.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/creators/route";
import { RESPONSES_KEY, forgetResearchPerson, researchCopyPerson } from "@/lib/creator-research-store";
import { researchAccountMark } from "@/lib/creator-research-room";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store } from "./redis-stub";
import { done, is, part } from "./check";

const payload = {
  name: "Synthetic Creator", email: "typed@example.test", platform: "Other",
  country: "Test country", problem: "A synthetic research answer for a regression test.",
  link: "", tools: "", cost: "", consentResearch: true,
  consentFollowUp: false, consentUpdates: false, website: "",
};
let ip = 0;
async function ask(email: string, session?: string): Promise<number> {
  ip += 1;
  const response = await POST(
    new NextRequest("https://marktmorgen.com/api/creators", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://marktmorgen.com", Host: "marktmorgen.com", "x-forwarded-for": `203.0.113.${ip}`, ...(session ? { Cookie: `${SESSION_COOKIE}=${session}` } : {}) },
      body: JSON.stringify({ ...payload, email }),
    }),
  );
  return response.status;
}
const rows = async () => ((await store.pipeline([["LRANGE", RESPONSES_KEY, 0, -1]]))[0] as string[]).map((row) => JSON.parse(row) as Record<string, unknown>);

async function main() {
  part("Account A signed in, typed address X: found by both, erased by either");
  store.clear();
  is("kept in a reserved place", await ask("typed@example.test", await openSession("account@example.test")), 201);
  is("an anonymous answer of someone else", await ask("someone@example.test"), 201);
  is("the account's copy finds the answer it sent", (await researchCopyPerson("account@example.test")).map((row) => row.email), ["typed@example.test"]);
  is("the typed address's copy finds it too", (await researchCopyPerson("typed@example.test")).map((row) => row.email), ["typed@example.test"]);
  is("erasing the account removes it", await forgetResearchPerson("account@example.test"), 1);
  is("nothing of theirs is left, the other answer stays", (await rows()).map((row) => row.email), ["someone@example.test"]);

  store.clear();
  await ask("typed@example.test", await openSession("account@example.test"));
  is("erasing the typed address removes it as well", [await forgetResearchPerson("typed@example.test"), (await rows()).length], [1, 0]);

  part("The mark cannot be found from the address alone");
  const unkeyed = createHash("sha256").update("creator-research-reserve:account@example.test").digest("hex").slice(0, 32);
  const mark = await researchAccountMark("account@example.test");
  is("a mark is made", /^[0-9a-f]{32}$/.test(mark), true);
  is("and it is not an unkeyed hash of the address", mark === unkeyed, false);
  is("and it does not hold the address", mark.includes("account"), false);
  done();
}
main().catch((error: unknown) => {
  process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
  process.exit(1);
});
