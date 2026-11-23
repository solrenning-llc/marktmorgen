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
  is("two accounts never share a mark", mark === (await researchAccountMark("other.account@example.test")), false);

  part("A row marked under the earlier key is still found and erased (Claude 5's LEVE 1)");
  const stripe = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_tests-only-earlier-root";
  try {
    const earlier = await researchAccountMark("account@example.test", true);
    is("an earlier key gives its own mark", /^[0-9a-f]{32}$/.test(earlier) && earlier !== mark, true);
    store.clear();
    await store.pipeline([["LPUSH", RESPONSES_KEY, JSON.stringify({ id: "earlier-row", ...payload, email: "typed@example.test", createdAt: new Date().toISOString(), reservedFor: earlier })]]);
    is("the account's copy finds the row marked under the earlier key", (await researchCopyPerson("account@example.test")).map((row) => row.email), ["typed@example.test"]);
    is("and erasing the account removes it", [await forgetResearchPerson("account@example.test"), (await rows()).length], [1, 0]);
  } finally {
    if (stripe === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = stripe;
  }

  part("No key, no mark: the account answers as anonymous (Claude 5's LEVE 2)");
  const dataKey = process.env.NIMBUS_DATA_KEY;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  delete process.env.NIMBUS_DATA_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    is("no mark is made", [await researchAccountMark("account@example.test"), await researchAccountMark("account@example.test", true)], ["", ""]);
    store.clear();
    const session = await openSession("account@example.test");
    is("a signed-in answer is still saved", await ask("typed@example.test", session), 201);
    is("with no mark written", (await rows()).map((row) => Object.hasOwn(row, "reservedFor")), [false]);
    is("and a second one is not refused as already answered: it is anonymous", await ask("typed@example.test", session), 201);
    is("so no answer carries a mark another account could share", (await rows()).every((row) => !Object.hasOwn(row, "reservedFor")), true);
    is("another account's copy does not reach them", (await researchCopyPerson("other.account@example.test")).length, 0);
  } finally {
    if (dataKey !== undefined) process.env.NIMBUS_DATA_KEY = dataKey;
    if (stripeKey !== undefined) process.env.STRIPE_SECRET_KEY = stripeKey;
  }
  done();
}
main().catch((error: unknown) => {
  process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
  process.exit(1);
});
