/**
 * The webhook event waitlist.joined (378 [TB4] complement WG (a)): sent once
 * when somebody confirms their spot on the waitlist of a product marked
 * coming soon (lib/waitlist.ts, confirmSpot), to the store's endpoints that
 * listen for it. What is checked, with synthetic stores and a stand-in for
 * the email sender:
 *
 *   - nothing on joining, before the button in the email is pressed;
 *   - on the first press, one message: the address as kept, the product with
 *     its title, whether they also asked to hear from the creator, and when
 *     they asked;
 *   - a second press, or the same link again, sends nothing more;
 *   - an endpoint that does not listen for it gets nothing, and a link of
 *     another store confirms nothing and sends nothing;
 *   - it is one of the events a store can listen for, listed in the studio.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { readListing } from "@/lib/catalog";
import { confirmSpot, joinWaitlist, setSoon } from "@/lib/waitlist";
import { WEBHOOK_EVENTS, addEndpoint, recentMessages, setSendHooksForTests } from "@/lib/webhooks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { to: string[]; subject: string; text: string };
const single: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    single.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

console.error = () => {};

setSendHooksForTests({ fetch: { resolve: (async () => { throw new Error("no network in tests"); }) as never } });

const tokenIn = (text: string) => text.match(/token=([0-9a-f]{48})/)?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  // A paid plan: a store's webhooks are sent only on one (lib/store-allowance-rules.ts).
  await setSubscription("owner@example.com", { customerId: "cus_WaitHook00001", subscriptionId: "sub_WaitHook00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  let store = (await storeForEmail("owner@example.com"))!;
  const listening = await addEndpoint(store, "https://hooks.example.com/waitlist", ["waitlist.joined"]);
  const deaf = await addEndpoint(store, "https://hooks.example.com/sales", ["sale.completed"]);
  if (!listening.ok || !deaf.ok) throw new Error("no endpoints");
  store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  await setSoon(store, product.id, true);

  part("An event a store can listen for, in the studio's list");
  is("waitlist.joined is one of the events", (WEBHOOK_EVENTS as readonly string[]).includes("waitlist.joined"), true);
  is("the studio lists it with what it means", readFileSync("components/webhook-editor.tsx", "utf8").includes('key: "waitlist.joined", label: "Waitlist joined"'), true);

  part("Nothing on joining; one message on the first press");
  is("Dana joins, asking to hear more", await joinWaitlist({ store, product, email: "Dana@Example.com", consent: true, ip: "1.1.1.1", origin: "https://marktmorgen.com" }), "sent");
  is("nothing sent before the button is pressed", (await recentMessages(store, "waitlist.joined", 10)).length, 0);
  const token = tokenIn(single.at(-1)?.text ?? "");
  is("the button counts it", (await confirmSpot(token, store)).ok, true);
  const sent = await recentMessages(store, "waitlist.joined", 10);
  is("one message", sent.length, 1);
  const data = (sent[0]?.data ?? {}) as Record<string, unknown>;
  is("the address as kept, the product with its title, the box, and when they asked", [data.email, data.product, data.asked_to_hear_from_you, typeof data.requested_at === "string" && !Number.isNaN(Date.parse(String(data.requested_at)))], ["dana@example.com", { id: product.id, title: "The Bread Book" }, true, true]);
  is("its type", sent[0]?.type, "waitlist.joined");

  part("Never twice");
  is("pressed again, still counted", (await confirmSpot(token, store)).ok, true);
  is("nothing more sent", (await recentMessages(store, "waitlist.joined", 10)).length, 1);

  part("Only to endpoints that listen, and only for this store");
  const log = await redis.pipeline([["LRANGE", `nl:hooks:log:${store.statsId}`, 0, -1]]);
  const ids = (log[0] as string[]) ?? [];
  const rows = (await redis.pipeline(ids.map((id) => ["GET", `nl:hooks:d:${id}`]))) as string[];
  const endpoints = rows.map((raw) => (JSON.parse(raw) as { endpoint: string; type: string })).filter((d) => d.type === "waitlist.joined").map((d) => d.endpoint);
  const listeningId = listening.view.endpoints.find((e) => e.where.endsWith("/waitlist"))!.id;
  is("one delivery, to the endpoint that listens", endpoints, [listeningId]);
  // Another store's link: a store whose stats id is not the one the link was made for.
  const other = { ...store, statsId: "0".repeat(32) };
  is("another store's own button confirms nothing of this one", (await confirmSpot(token, other)).ok, false);
  is("and sends nothing", (await recentMessages(store, "waitlist.joined", 10)).length, 1);

  done();
}

void main();
