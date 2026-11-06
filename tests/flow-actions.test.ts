/**
 * Steps that act, and sequences that start with a label (lib/flow-rules.ts,
 * lib/flows.ts), added 12 October 2026. What is checked:
 *
 *   - saving refuses a label with no words, a sequence that is not the
 *     store's or is the sequence itself, a condition on the email before
 *     when no email is right before it, and a label trigger with no label;
 *   - a step that gives a label gives it once, only where there is room,
 *     and starts every sequence that starts with that label;
 *   - a label taken off is taken off, whatever its capitals;
 *   - a step that starts another sequence starts it once a person, so two
 *     sequences that start each other cannot loop;
 *   - a condition decides who a step acts for, as it decides who gets an email.
 */
import { readAction } from "@/lib/flow-rules";
import { enroll, flowStats, readFlows, saveFlow, sendDueSteps } from "@/lib/flows";
import { changeLabels, leadsKey, parseContact, upsertContact, importContactRows } from "@/lib/contacts";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const HOUR = 3_600_000;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const to = (subject: string) =>
  mail.ses.filter((message) => message.subject === subject).flatMap((message) => message.to).sort();
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
const later = async (hours: number) => {
  shift += hours * HOUR;
  await run();
};

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_actions_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_actions_only_a_stand_in";

  part("An action, read strictly");
  const isFlow = (id: string) => id === "aaaaaaaaaaaaaaaa";
  is("a label needs words; another sequence must be the store's", [
    readAction({ do: "tag", tag: "  Warm  lead " }, isFlow),
    readAction({ do: "tag", tag: "   " }, isFlow),
    readAction({ do: "start", flowId: "aaaaaaaaaaaaaaaa" }, isFlow),
    readAction({ do: "start", flowId: "bbbbbbbbbbbbbbbb" }, isFlow),
    readAction({ do: "delete" }, isFlow),
    readAction(null, isFlow),
  ], [{ do: "tag", tag: "Warm lead" }, "bad", { do: "start", flowId: "aaaaaaaaaaaaaaaa" }, "bad", "bad", null]);

  const OWNER = "harbor@example.com";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Harbor0001", subscriptionId: "sub_Harbor0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const course = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  if (!course.ok) throw new Error("no product");
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;

  part("Saved, and checked when saved");
  const offer = await saveFlow(store, {
    name: "The offer",
    trigger: "tagged",
    tag: " Interested ",
    active: true,
    steps: [
      { delayHours: 0, subject: "The course is open", body: "Thirty dinners." },
      { delayHours: 1, action: { do: "untag", tag: "interested" } },
    ],
  }, { activate: true });
  is("a sequence that starts with a label, its label trimmed", offer.ok ? [offer.flows[0].trigger, offer.flows[0].tag, offer.flows[0].steps[1].action, offer.flows[0].steps[1].subject] : offer, ["tagged", "Interested", { do: "untag", tag: "interested" }, ""]);
  const offerId = offer.ok ? offer.flows[0].id : "";
  is("a label trigger with no label is refused", (await saveFlow(store, { name: "X", trigger: "tagged", tag: "  ", active: true, steps: [{ delayHours: 0, subject: "a", body: "b" }] }, { activate: true })) , { ok: false, reason: "tag" });
  is("a sequence that is not the store's is refused", (await saveFlow(store, { name: "X", trigger: "joined", active: true, steps: [{ delayHours: 0, action: { do: "start", flowId: "ffffffffffffffff" } }] }, { activate: true })), { ok: false, reason: "step" });
  is("so is a sequence starting itself", (await saveFlow(store, { id: offerId, name: "The offer", trigger: "tagged", tag: "Interested", active: true, steps: [{ delayHours: 0, action: { do: "start", flowId: offerId } }] }, { activate: true })), { ok: false, reason: "step" });
  is("a condition on the email before needs an email right before it", (await saveFlow(store, {
    name: "X",
    trigger: "joined",
    active: true,
    steps: [
      { delayHours: 0, subject: "a", body: "b" },
      { delayHours: 0, action: { do: "tag", tag: "x" } },
      { delayHours: 0, subject: "c", body: "d", when: { if: "clicked" } },
    ],
  }, { activate: true })), { ok: false, reason: "step" });

  const welcome = await saveFlow(store, {
    name: "Welcome",
    trigger: "joined",
    active: true,
    steps: [
      { delayHours: 0, subject: "Welcome", body: "Hello." },
      // Those who have not bought are marked as interested, which starts the offer.
      { delayHours: 24, action: { do: "tag", tag: "interested" }, when: { if: "lacks", productId: course.product.id } },
      { delayHours: 24, action: { do: "start", flowId: offerId } },
      { delayHours: 0, subject: "Thanks for reading", body: "That is all." },
    ],
  }, { activate: true });
  is("a welcome that gives a label and starts another sequence", welcome.ok ? welcome.flows.map((f) => [f.name, f.steps.length]) : welcome, [["The offer", 2], ["Welcome", 4]]);
  const welcomeId = welcome.ok ? welcome.flows[1].id : "";

  part("Carried out for the people it is for");
  await upsertContact(list, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await upsertContact(list, "ben@example.com", { agreed: true, explicit: true, source: "buyer", productId: course.product.id, title: "Weeknight Course" }, ROOM);
  // Cleo already carries ten labels: no room for another.
  await importContactRows(list, [{ email: "cleo@example.com", name: "Cleo", tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] }], ROOM);
  store = (await storeForEmail(OWNER))!;
  for (const email of ["ana@example.com", "ben@example.com", "cleo@example.com"]) await enroll(store, email, { joined: true });
  await run();
  is("the welcome goes to all three", to("Welcome"), ["ana@example.com", "ben@example.com", "cleo@example.com"]);
  await later(24);
  const tags = async (email: string) => parseContact((await redisPipeline([["HGET", leadsKey(list), email]]))[0])?.tags ?? [];
  is("the label, only for who has not bought, and only where there is room", [await tags("ana@example.com"), (await tags("ben@example.com")).length, (await tags("cleo@example.com")).length], [["interested"], 0, 10]);
  is("being given the label starts the offer at once, for Ana alone", to("The course is open"), ["ana@example.com"]);
  await later(1);
  is("and the offer's next step takes the label off again, whatever its capitals", await tags("ana@example.com"), []);
  await later(23);
  is("starting the offer again starts nobody twice: Ana had it, the others now get it", to("The course is open"), ["ana@example.com", "ben@example.com", "cleo@example.com"]);
  is("and the welcome goes on to its last email", to("Thanks for reading"), ["ana@example.com", "ben@example.com", "cleo@example.com"]);

  part("Two sequences that start each other");
  const ping = await saveFlow(store, { name: "Ping", trigger: "tagged", tag: "ping", active: true, steps: [{ delayHours: 0, subject: "Ping", body: "1" }] }, { activate: true });
  const pingId = ping.ok ? ping.flows.find((f) => f.name === "Ping")!.id : "";
  const pong = await saveFlow(store, { name: "Pong", trigger: "tagged", tag: "pong", active: true, steps: [{ delayHours: 0, subject: "Pong", body: "2" }, { delayHours: 0, action: { do: "start", flowId: pingId } }] }, { activate: true });
  const pongId = pong.ok ? pong.flows.find((f) => f.name === "Pong")!.id : "";
  await saveFlow(store, { id: pingId, name: "Ping", trigger: "tagged", tag: "ping", active: true, steps: [{ delayHours: 0, subject: "Ping", body: "1" }, { delayHours: 0, action: { do: "start", flowId: pongId } }] }, { activate: true });
  store = (await storeForEmail(OWNER))!;
  await enroll(store, "ana@example.com", { joined: false, tag: "ping" });
  for (let i = 0; i < 6; i += 1) await later(1);
  is("each once, however many times they start each other", [to("Ping"), to("Pong")], [["ana@example.com"], ["ana@example.com"]]);

  part("Counted");
  const stats = await flowStats(await readFlows(list));
  // One label given (Ana; Cleo had no room) and two new starts (Ana had started the offer already).
  is("the actions that changed something, beside the emails sent", [stats.get(welcomeId)?.acted, stats.get(welcomeId)?.sent, stats.get(offerId)?.started], [3, 6, 3]);

  part("A label never written over a newer change");
  const key = leadsKey(list);
  let first = true;
  const result = await changeLabels(list, ["ana@example.com"], (tags) => {
    // An unsubscribe lands between reading the contact and writing the label.
    if (first) {
      first = false;
      const row = parseContact(redis.run(["HGET", key, "ana@example.com"]))!;
      redis.run(["HSET", key, "ana@example.com", JSON.stringify({ ...row, unsub: true, unsubAt: "2026-10-12T00:00:00.000Z" })]);
    }
    return [...tags, "late"];
  }, ROOM);
  const after = parseContact(redis.run(["HGET", key, "ana@example.com"]));
  is("the unsubscribe stays, and the label is written over the contact as it now is", [result.changed, after?.unsub, after?.tags.includes("late")], [["ana@example.com"], true, true]);

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
