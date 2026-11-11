/**
 * Independent review of #2287 at c46f8f6a (LOW 1 and LOW 2): a person's
 * generation is read exactly (rule 24). Only `null` (never deleted, 0) or a
 * decimal string of a safe whole number is a generation; a missing slot, an
 * empty envelope, a number, a fraction or any other text is unknown (-1),
 * never 0, "never deleted". A page whose generation is unknown gets no mark,
 * and a save from it is told to reload, not to "check your access"; a
 * workflow step whose generation is unknown says the person could not be
 * read, never that they were deleted, and writes nothing.
 * Synthetic store, people and mail only.
 */
import { enroll, saveFlow, sendDueSteps } from "@/lib/flows";
import { personOf, readRun } from "@/lib/flow-runs";
import { upsertContact } from "@/lib/contacts";
import { pageMark, readGeneration, readGenerations, readValues, writeFields } from "@/lib/crm";
import * as crmResponse from "@/lib/crm-response";
import { writeForm } from "@/lib/form-store";
import { parseForm } from "@/lib/forms";
import { personKey } from "@/lib/person-key";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});

type Reply = (commands: (string | number)[][], real: unknown[]) => unknown[];
/** Answers the GETs of generation keys with what `reply` gives; every other command is the store's own. */
async function withGenerationReplies<T>(reply: Reply, task: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = async (commands) => {
    const real = await original.call(redis, commands);
    const generations = commands.length > 0 && commands.every((c) => c[0] === "GET" && String(c[1]).startsWith("nl:crm:gen:"));
    return generations ? reply(commands, real) : real;
  };
  try { return await task(); } finally { redis.pipeline = original; }
}

/** The words the contact fields show for a refusal (lib/crm-response.ts); "(none)" where there is no such function. */
const crmRefusalMessage = (error: string): string => (crmResponse as unknown as { crmRefusalMessage?: (e: string) => string }).crmRefusalMessage?.(error) ?? "(none)";

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_generation_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_generation_only_a_stand_in";

  const OWNER = "gen-exact@example.com";
  await claimHandle(OWNER, "gen-exact", "Synthetic Generations", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestGenExact01", true);
  await setSubscription(OWNER, { customerId: "cus_GenExact0001", subscriptionId: "sub_GenExact0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Synthetic Generations", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const person = personKey(statsId, "ana@example.com");
  const other = personKey(statsId, "ben@example.com");

  part("One person's generation, read exactly");
  const one = (raw: unknown, envelope?: unknown[]) => withGenerationReplies(() => envelope ?? [raw], () => readGeneration(statsId, person));
  is("null is never deleted; a decimal string is that generation", [await one(null), await one("1731000000123")], [0, 1731000000123]);
  is("an empty envelope, a missing slot, a number, a fraction, a sign, a leading zero, words: unknown", [
    await one(undefined, []),
    await one(undefined),
    await one(1731000000123),
    await one("12.5"),
    await one("-3"),
    await one("007"),
    await one("abc"),
    await one("9007199254740993"),
  ], [-1, -1, -1, -1, -1, -1, -1, -1]);
  is("an unknown generation signs no page mark", pageMark(statsId, person, await one("abc")), "");

  part("Several people's generations, read exactly");
  const many = (reply: unknown[]) => withGenerationReplies(() => reply, () => readGenerations(statsId, [person, other]));
  is("each slot as it is", [await many([null, "5"]), await many(["x", null])], [[0, 5], [-1, 0]]);
  // Only an envelope of exactly one reply per person is read (Codex G, Claude 1 on #2287): a short or overlong one is
  // not a valid prefix, so every slot of it is unknown, never 0.
  is("a short envelope: every one unknown, never 0", [await many([]), await many([null])], [[-1, -1], [-1, -1]]);
  is("an overlong envelope: every one unknown, never a prefix read as theirs", await many([null, "5", "9"]), [-1, -1]);

  part("The page is told to reload when its mark cannot save");
  is("a stale page: reload, not check your access", crmRefusalMessage("stale"), "This page was opened too long ago to save from. Copy your entry, then reload the page and try again.");
  is("a value the field cannot keep is as before", crmRefusalMessage("value"), "This field cannot keep that value. Your entry is still here; correct it and try again.");
  is("any other refusal is as before", crmRefusalMessage("forbidden"), "This change was refused. Your entry is still here; check your access and try again.");

  part("A workflow step whose generation is unknown");
  const fields = await writeFields(statsId, [{ id: "lvl001", name: "Level", type: "choice", options: ["Beginner", "Pro"] }]);
  await writeForm(statsId, parseForm({ id: "applyform1", name: "Coaching application", fields: [{ id: "q1mail", type: "email", label: "Email", required: true }] })!);
  const saved = await saveFlow(store, { name: "Applicants", trigger: "form", formId: "applyform1", active: true, steps: [{ delayHours: 0, action: { do: "field", field: "lvl001", value: "Pro" } }] }, { activate: true });
  if (!saved.ok) throw new Error("the workflow was not saved");
  const flowId = saved.flows[0].id;
  await upsertContact(store.listId!, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  store = (await storeForEmail(OWNER))!;
  await enroll(store, "ana@example.com", { joined: false, form: "applyform1" });
  await withGenerationReplies((commands) => commands.map(() => "not-a-generation"), async () => {
    for (let i = 0; i < 3; i += 1) await sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
  });
  const value = (await readValues(statsId, person, fields)).lvl001 ?? "";
  const notes = ((await readRun(flowId, personOf("ana@example.com")))?.events ?? []).filter((e) => e.kind === "field" && e.state !== "attempted").map((e) => e.note);
  is("nothing is written", value, "");
  is("the step says the person could not be read, never that they were deleted", [notes.length > 0, notes.some((n) => /deleted/.test(n)), notes.every((n) => /could not be read/.test(n))], [true, false, true]);
}

main().then(done, (error) => { console.error(error); process.exit(1); });
