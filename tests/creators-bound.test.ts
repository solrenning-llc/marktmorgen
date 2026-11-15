/**
 * MM-SA-50 (docs/security-audit-2026-10-28.md; 506 [SG1]): the creator
 * research form (POST /api/creators) kept every answer (up to about 4 KB of
 * text, for 24 months) with only five an hour per exact address. One machine
 * holds a whole IPv6 /64, and a free tunnel hands out a /48: that is no limit,
 * and the list of answers had no bound of its own, so storage did not either.
 *
 * What fails here:
 *   - six answers from one IPv6 /48, each from its own address, all kept;
 *   - an answer kept once RESEARCH_MAX_ANSWERS are kept (it is refused as
 *     "full", said, never by dropping an older answer and its consent);
 *   - an answer from another network, while there is room, refused (control).
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/creators/route";
import { RESEARCH_MAX_ANSWERS, RESPONSES_KEY } from "@/lib/creator-research-store";
import { store } from "./redis-stub";
import { done, is, part } from "./check";

const payload = {
  name: "Synthetic Creator", email: "creator@example.test", platform: "Other",
  country: "Test country", problem: "A synthetic research answer for a regression test.",
  link: "", tools: "", cost: "", consentResearch: true, consentFollowUp: false, consentUpdates: false, website: "",
};
const ask = (ip: string) => POST(new NextRequest("https://marktmorgen.com/api/creators", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://marktmorgen.com", Host: "marktmorgen.com", "x-forwarded-for": ip },
  body: JSON.stringify(payload),
}));
const kept = async () => Number((await store.pipeline([["LLEN", RESPONSES_KEY]]))[0]);

async function main(): Promise<void> {
  globalThis.fetch = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;

  part("One network is one connection, however many addresses it has");
  store.clear();
  const answers: number[] = [];
  for (let i = 1; i <= 6; i += 1) answers.push((await ask(`2001:db8:4:${i}::${i}`)).status);
  is("five kept, the sixth too many", answers, [201, 201, 201, 201, 201, 429]);
  is("and five are kept", await kept(), 5);
  is("another network is still heard", (await ask("2001:db8:5::1")).status, 201);

  part("The list of answers has a bound of its own");
  is("the bound is a whole number", Number.isSafeInteger(RESEARCH_MAX_ANSWERS) && RESEARCH_MAX_ANSWERS > 0, true);
  store.clear();
  await store.pipeline([["RPUSH", RESPONSES_KEY, ...Array.from({ length: RESEARCH_MAX_ANSWERS }, (_, i) => JSON.stringify({ id: `old-${i}`, createdAt: new Date().toISOString() }))]]);
  const full = await ask("192.0.2.77");
  is("at the bound, an answer is refused and said as full", [full.status, (await full.json()).error], [503, "full"]);
  is("nothing kept was dropped for it", [await kept(), (await store.pipeline([["LINDEX", RESPONSES_KEY, -1]]))[0]], [RESEARCH_MAX_ANSWERS, JSON.stringify({ id: `old-${RESEARCH_MAX_ANSWERS - 1}`, createdAt: JSON.parse(String((await store.pipeline([["LINDEX", RESPONSES_KEY, -1]]))[0])).createdAt })]);
  await store.pipeline([["LTRIM", RESPONSES_KEY, 0, RESEARCH_MAX_ANSWERS - 2]]);
  is("with room again, an answer is kept", (await ask("192.0.2.78")).status, 201);

  part("The form says it in words");
  const form = (await import("node:fs")).readFileSync("components/creator-research-form.tsx", "utf8");
  is("a full list is said, with another way to send it", /error === "full"[\s\S]{0,200}was not saved\. You can email it/.test(form), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
