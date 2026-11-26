/**
 * A waitlist launch batch whose answer was not known keeps the company's day count it reserved and marks it
 * (lib/batch-count.ts); the same batch tried again sends under that count instead of reserving the day again, and
 * the mark goes once it is sent (#4073, Codex X6's LOW: the lost-ack retry held for every batch-email caller, not
 * only announcements). Drives the real runLaunches with the batch answer stubbed (tests/batch-answer-world.ts).
 * Synthetic data only.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmSpot, joinWaitlist, launch, runLaunches, setSoon } from "@/lib/waitlist";
import { mailDay } from "@/lib/mail";
import { answerBatches, batchAnswers, type BatchAnswer } from "./batch-answer-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const mailed: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    mailed.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const lastToken = () => mailed.at(-1)?.match(/token=([0-9a-f]{48})/)?.[1] ?? "";
const run = () => runLaunches(storeForHandle, readListing, Date.now() + 10_000);
/** The company's day as counted (lib/mail.ts reserveDay). */
const dayCount = async () => Number((await redis.pipeline([["GET", mailDay()()]]))[0] ?? 0);
const marks = () => redis.keys().filter((k) => k.startsWith("nl:mail:kept:")).length;

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  process.env.MARKETING_DAILY_CAP = "1000";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  let ip = 1;

  for (const unknown of ["unconfirmed", "uncertain"] as BatchAnswer[]) {
    part(`A waitlist launch batch answered "${unknown}", then sent`);
    const made = await addProduct("owner@example.com", `The ${unknown} Book`, "", "39", null);
    if (!made.ok) throw new Error("no product");
    let store = (await storeForEmail("owner@example.com"))!;
    await setSoon(store, made.product.id, true);
    const product = (await readListing(store, made.product.id))!;
    store = (await storeForEmail("owner@example.com"))!;
    for (const who of ["ana", "bo"]) {
      is(`(${who} joins)`, await joinWaitlist({ store, product, email: `${who}-${unknown}@example.com`, consent: false, ip: `10.0.0.${ip++}`, origin: "https://marktmorgen.com" }), "sent");
      is(`(and confirms)`, (await confirmSpot(lastToken(), store)).ok, true);
    }
    is("(launched to two)", await launch(store, product, { note: "Out now.", address: "1 Main St, Springfield" }), { ok: true, total: 2 });

    const before = await dayCount();
    answerBatches(unknown, "sent");
    is("the answer was not known: nothing counted as sent", await run(), 0);
    is("the day's two emails stay counted", (await dayCount()) - before, 2);
    is("and the batch is marked as holding its count", marks(), 1);
    is("tried again and sent: both emails go", await run(), 2);
    is("the same batch, under the same key, handed over twice", [batchAnswers.handed.length, batchAnswers.handed[0]?.key === batchAnswers.handed[1]?.key], [2, true]);
    is("counted once, not twice", (await dayCount()) - before, 2);
    is("no mark is left once the batch was sent", marks(), 0);
  }

  // Claude 4's LEVE on #4073 @aae5ef59e9 (comment 7074407785): a batch kept after an unknown answer and then refused
  // for good fell into the "sent" branch, so the run said the two emails went.
  for (const unknown of ["unconfirmed", "uncertain"] as BatchAnswer[]) {
    part(`A waitlist launch batch answered "${unknown}", then refused for good`);
    const made = await addProduct("owner@example.com", `The refused ${unknown} Book`, "", "39", null);
    if (!made.ok) throw new Error("no product");
    let store = (await storeForEmail("owner@example.com"))!;
    await setSoon(store, made.product.id, true);
    const product = (await readListing(store, made.product.id))!;
    store = (await storeForEmail("owner@example.com"))!;
    for (const who of ["cy", "di"]) {
      is(`(${who} joins)`, await joinWaitlist({ store, product, email: `${who}-refused-${unknown}@example.com`, consent: false, ip: `10.0.0.${ip++}`, origin: "https://marktmorgen.com" }), "sent");
      is(`(and confirms)`, (await confirmSpot(lastToken(), store)).ok, true);
    }
    is("(launched to two)", await launch(store, product, { note: "Out now.", address: "1 Main St, Springfield" }), { ok: true, total: 2 });

    const before = await dayCount();
    answerBatches(unknown, "refused");
    is("the answer was not known: nothing counted as sent", await run(), 0);
    is("refused for good is never counted as sent", await run(), 0);
    is("the day's two emails stay counted: they may have gone the first time", (await dayCount()) - before, 2);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
