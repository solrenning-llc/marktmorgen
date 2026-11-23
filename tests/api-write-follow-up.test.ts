/**
 * Defects #3979, #4035 and #4077 (Codex C2): an API write whose follow-up was lost after the write itself went
 * through. A contact added, or a label added, through the API starts the sequences that moment starts; a product
 * given with `notify: true` sends the one access email. When the write was kept but its follow-up failed (the
 * workflows could not be read, the grant's reply was lost, the store's record could not be marked), a retry of the
 * same request found the contact, the label or the gift already there and skipped the follow-up for good.
 *
 * Now each such write keeps a short-lived note of what it still owes (lib/api-write.ts, oweKey), written before the
 * write and cleared once the follow-up is done; a retry reads it and finishes the follow-up, once:
 *
 *   - a contact added, then the sequences' start failed: the API says to try again, and the retry starts the
 *     "joined" and "tagged" sequences once each;
 *   - a label added, then the start failed: the same;
 *   - a product given whose reply was lost, or whose store record could not be marked after it: the retry answers
 *     "already" and sends the access email once; a further retry sends nothing more.
 *
 * Synthetic: in-memory Redis, the email provider a stand-in, no real store or person.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { makeKey } from "@/lib/api-keys";
import { upsertContact } from "@/lib/contacts";
import { flowsStartedFor, readFlows, saveFlow, setFlowActive } from "@/lib/flows";
import { importedFor } from "@/lib/imported-purchases";
import { allowanceUsed } from "@/lib/store-allowance";
import { POST as postLead } from "@/app/api/v1/leads/route";
import { POST as postLabels } from "@/app/api/v1/leads/labels/route";
import { POST as postAccess } from "@/app/api/v1/access/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

type Commands = (string | number)[][];
const emails: { to: string | string[]; subject: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as { to: string; subject: string });
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${url}` } }), { status: 404 });
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
/** The next pipeline `match` picks fails: before it runs ("before"), or after it ran, its reply lost ("after"). */
let fault: { match: (commands: Commands) => boolean; when: "before" | "after" } | null = null;
redis.pipeline = (async (commands: Commands) => {
  const hit = fault && fault.match(commands) ? fault : null;
  if (hit) fault = null;
  if (hit?.when === "before") throw new Error("synthetic: the database did not answer");
  const replies = await real(commands);
  if (hit?.when === "after") throw new Error("synthetic: the reply was lost");
  return replies;
}) as typeof redis.pipeline;

const readsFlows = (commands: Commands) => commands.some((c) => String(c[0]).toUpperCase() === "GET" && String(c[1]).startsWith("nl:mail:flows:"));
const grantsGift = (commands: Commands) => commands.some((c) => String(c[0]).toUpperCase() === "EVAL" && String(c[1]).startsWith("-- marktmorgen:grant-unless-erased:"));

const call = async (handler: (r: Request) => Promise<Response>, key: string, body: unknown) => {
  const response = await handler(new Request("https://marktmorgen.com/api/v1/x", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { status: response.status, json: (await response.json()) as { error?: string; data?: Record<string, unknown> } };
};

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_api_write_only_a_stand_in";
  redis.clear();
  const OWNER = "follow-up@example.com";
  await claimHandle(OWNER, "followup", "Follow Up Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_FollowUp01", subscriptionId: "sub_FollowUp01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Follow Up Studio", address: "1 Main St, Portland, OR 97201" });
  const guide = await addProduct(OWNER, "The Guide", "", "12", null);
  if (!guide.ok) throw new Error("no product");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide");
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId!;
  for (const flow of [
    { name: "Welcome", trigger: "joined" },
    { name: "VIP", trigger: "tagged", tag: "vip" },
    { name: "Warm", trigger: "tagged", tag: "warm" },
  ]) {
    const saved = await saveFlow(store, { ...flow, steps: [{ delayHours: 1, subject: `${flow.name} one`, body: "Hello." }] });
    if (!saved.ok) throw new Error(`no workflow: ${JSON.stringify(saved)}`);
    await setFlowActive(store, saved.flows.find((f) => f.name === flow.name)!.id, true);
  }
  const flows = await readFlows(list);
  const id = (name: string) => flows.find((f) => f.name === name)!.id;
  store = (await storeForEmail(OWNER))!;
  const writer = await makeKey(store.sid!, "Sync", Date.now(), true);
  if (!writer.ok) throw new Error("no key");

  part("#3979, #4077: a contact added, its sequences' start lost");
  fault = { match: readsFlows, when: "before" };
  const first = await call(postLead, writer.key, { email: "ana@example.com", tags: ["vip"], agreed: true });
  is("the contact is kept, and the API says to try again instead of a success with nothing started", [first.status, first.json.error], [503, "unavailable"]);
  is("the welcome has not started", (await flowsStartedFor(flows, "ana@example.com")).includes(id("Welcome")), false);
  const used = await allowanceUsed(store, "api");
  const retried = await call(postLead, writer.key, { email: "ana@example.com", tags: ["vip"], agreed: true });
  is("the retry says the contact is there", [retried.status, retried.json.data?.status], [200, "already"]);
  is("and starts the welcome and the label's sequence, once each", (await flowsStartedFor(flows, "ana@example.com")).sort(), [id("Welcome"), id("VIP")].sort());
  is("the retry takes one request, as any request on a contact already there", await allowanceUsed(store, "api"), used + 1);
  await call(postLead, writer.key, { email: "ana@example.com", tags: ["vip"], agreed: true });
  is("a later request starts nothing more", (await flowsStartedFor(flows, "ana@example.com")).sort(), [id("Welcome"), id("VIP")].sort());

  part("#3979, #4077: a label added, its sequence's start lost");
  await upsertContact(list, "ben@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  fault = { match: readsFlows, when: "before" };
  const labeled = await call(postLabels, writer.key, { email: "ben@example.com", add: ["warm"] });
  is("the label is kept, and the API says to try again", [labeled.status, labeled.json.error], [503, "unavailable"]);
  is("nothing started yet", await flowsStartedFor(flows, "ben@example.com"), []);
  const relabeled = await call(postLabels, writer.key, { email: "ben@example.com", add: ["warm"] });
  is("the retry answers the labels", [relabeled.status, relabeled.json.data?.labels], [200, ["warm"]]);
  is("and starts the label's sequence, once", await flowsStartedFor(flows, "ben@example.com"), [id("Warm")]);
  is("never the welcome of somebody who was already on the list", (await flowsStartedFor(flows, "ben@example.com")).includes(id("Welcome")), false);

  part("#4035: a product given, its reply lost, with the email asked for");
  fault = { match: grantsGift, when: "after" };
  const lost = await call(postAccess, writer.key, { email: "cy@example.com", product: guide.product.id, notify: true });
  is("the API could not confirm it", lost.status >= 500, true);
  is("the gift went through, and no email yet", [(await importedFor({ ...store, pastBuyers: true }, "cy@example.com")).length, emails.length], [1, 0]);
  const again = await call(postAccess, writer.key, { email: "cy@example.com", product: guide.product.id, notify: true });
  is("the retry says it was given already, and sends the email asked for", [again.status, again.json.data?.status, again.json.data?.emailed], [200, "already", true]);
  is("one email, to the buyer", [emails.length, [emails[0]?.to].flat()[0]], [1, "cy@example.com"]);
  const third = await call(postAccess, writer.key, { email: "cy@example.com", product: guide.product.id, notify: true });
  is("a further retry sends nothing more", [third.json.data?.status, third.json.data?.emailed, emails.length], ["already", false, 1]);
  is("given once", (await importedFor({ ...store, pastBuyers: true }, "cy@example.com")).length, 1);

  part("#4035: a product given, the store's record not marked after it");
  const OTHER = "follow-up-two@example.com";
  await claimHandle(OTHER, "followtwo", "Follow Two", "");
  await ensureStatsId(OTHER);
  await ensureListId(OTHER);
  await setSubscription(OTHER, { customerId: "cus_FollowUp02", subscriptionId: "sub_FollowUp02", active: true, tier: "pro", period: paidPeriod() });
  const book = await addProduct(OTHER, "The Book", "", "12", null);
  if (!book.ok) throw new Error("no product");
  await setProductLink(OTHER, book.product.id, "https://example.com/book");
  const two = (await storeForEmail(OTHER))!;
  const twoKey = await makeKey(two.sid!, "Sync", Date.now(), true);
  if (!twoKey.ok) throw new Error("no key");
  is("a store that never gave a product before", two.pastBuyers ?? false, false);
  let granted = false;
  fault = {
    match: (commands) => {
      if (grantsGift(commands)) granted = true;
      // The first write after the gift: marking the store as one with past buyers.
      return granted && !grantsGift(commands) && commands.some((c) => ["EVAL", "SET", "HSET"].includes(String(c[0]).toUpperCase()) && !String(c[1]).startsWith("nl:api:owe:"));
    },
    when: "before",
  };
  const before = emails.length;
  const unmarked = await call(postAccess, twoKey.key, { email: "dee@example.com", product: book.product.id, notify: true });
  is("the API could not finish it", unmarked.status >= 500, true);
  is("the gift went through, and no email yet", [(await importedFor({ ...two, pastBuyers: true }, "dee@example.com")).length, emails.length], [1, before]);
  const finished = await call(postAccess, twoKey.key, { email: "dee@example.com", product: book.product.id, notify: true });
  is("the retry sends the email asked for", [finished.json.data?.status, finished.json.data?.emailed, emails.length], ["already", true, before + 1]);

  part("Nothing changes for a request that went through");
  const plain = await call(postAccess, twoKey.key, { email: "eve@example.com", product: book.product.id, notify: true });
  is("given, emailed once", [plain.json.data?.status, plain.json.data?.emailed, emails.length], ["given", true, before + 2]);
  const plainAgain = await call(postAccess, twoKey.key, { email: "eve@example.com", product: book.product.id, notify: true });
  is("asked again: already, and no second email", [plainAgain.json.data?.status, plainAgain.json.data?.emailed, emails.length], ["already", false, before + 2]);
  const owed = ((await real([["SCAN", "0", "MATCH", "nl:api:owe:*", "COUNT", 1000]]))[0] as [string, string[]])[1];
  is("no note of a follow-up owed is left behind", owed, []);

  done();
}

void main();
