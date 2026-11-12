/**
 * A store switched off after notices about its content (store.suspended,
 * lib/takedown.ts) takes no sign-up on its list (lib/store-join.ts listOpen)
 * and hands out no free copy (app/api/store/free/route.ts). Its waitlist's
 * public route now gives the same answer as the free copy (303 to the store's
 * page) before anything is read, written or sent: no address is kept and no
 * email goes out.
 *
 * Controls: a store that is not suspended still takes the sign-up exactly as
 * before (303 to its waitlist page with status=sent, one email, one place),
 * and a store record that cannot be read (rule 24) is still refused with
 * nothing kept and nothing sent. Synthetic data; no provider is called.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, noteTakedown, setSubscription, storeForEmail } from "@/lib/store";
import { setSoon } from "@/lib/waitlist";
import { askToJoin } from "@/lib/store-join";
import { POST as joinRoute } from "@/app/api/store/waitlist/join/route";
import { POST as freeRoute } from "@/app/api/store/free/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

let mails = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    mails += 1;
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const post = (route: typeof joinRoute, path: string, fields: Record<string, string>) =>
  route(
    new NextRequest(`https://marktmorgen.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", host: "marktmorgen.com", origin: "https://marktmorgen.com", "x-forwarded-for": "7.7.7.7" },
      body: new URLSearchParams(fields).toString(),
    }),
  );

const waitlistKeys = () => redis.keys().filter((key) => key.startsWith("nl:wl:"));

async function makeStore(owner: string, handle: string, name: string) {
  await claimHandle(owner, handle, name, "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  const id = handle.replace(/[^a-z0-9]/gi, "");
  await setSubscription(owner, { customerId: `cus_${id}`, subscriptionId: `sub_${id}`, active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  await setSoon((await storeForEmail(owner))!, made.product.id, true);
  return made.product.id;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";

  part("Control: a store that is not suspended takes the sign-up as before");
  const healthyProduct = await makeStore("owner-open@example.com", "harboropen", "Harbor Open");
  const healthy = (await storeForEmail("owner-open@example.com"))!;
  mails = 0;
  const open = await post(joinRoute, "/api/store/waitlist/join", { handle: "harboropen", product: healthyProduct, email: "reader@example.com" });
  is("303", open.status, 303);
  is("to its waitlist page, sent", open.headers.get("location"), `https://marktmorgen.com/@harboropen/waitlist?product=${encodeURIComponent(healthyProduct)}&status=sent`);
  is("one confirmation email", mails, 1);
  is("the place is kept", typeof redis.run(["HGET", `nl:wl:${healthy.statsId}:${healthyProduct}`, "reader@example.com"]), "string");

  part("A suspended store");
  const owner = "owner-closed@example.com";
  const product = await makeStore(owner, "harborclosed", "Harbor Closed");
  await noteTakedown(owner, null, true);
  const store = (await storeForEmail(owner))!;
  is("the store is suspended", Boolean(store.suspended), true);
  is("its sign-up box is closed", await askToJoin({ store, email: "a@example.com", ip: "1.1.1.1", origin: "https://marktmorgen.com" }), "closed");

  const free = await post(freeRoute, "/api/store/free", { handle: "harborclosed", product, email: "reader@example.com" });
  const before = waitlistKeys().length;
  mails = 0;
  const joined = await post(joinRoute, "/api/store/waitlist/join", { handle: "harborclosed", product, email: "reader@example.com" });
  is("the waitlist answers with the free copy's status", joined.status, free.status);
  is("and its place: the store's page", [joined.headers.get("location"), free.headers.get("location")], ["https://marktmorgen.com/@harborclosed", "https://marktmorgen.com/@harborclosed"]);
  is("no email goes out", mails, 0);
  is("no waitlist key is written", waitlistKeys().length, before);
  // Read last: the memory model's HGET leaves an empty hash behind.
  is("no address is kept", redis.run(["HGET", `nl:wl:${store.statsId}:${product}`, "reader@example.com"]), null);

  const trap = await post(joinRoute, "/api/store/waitlist/join", { handle: "harborclosed", product, email: "reader@example.com", website: "x" });
  is("the hidden field gets the same answer, not 'sent'", [trap.status, trap.headers.get("location")], [303, "https://marktmorgen.com/@harborclosed"]);
  is("and still no email", mails, 0);

  part("A store record that cannot be read (rule 24)");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    const [name, key] = commands[0] ?? [];
    return name === "GET" && String(key).startsWith("nl:store:owner:") ? [7] : replies;
  }) as typeof redis.pipeline;
  const keysBefore = waitlistKeys().length;
  mails = 0;
  const unread = await post(joinRoute, "/api/store/waitlist/join", { handle: "harboropen", product: healthyProduct, email: "other@example.com" });
  redis.pipeline = real;
  is("refused", unread.status, 404);
  is("no email goes out", mails, 0);
  is("nothing is written", waitlistKeys().length, keysBefore);

  done();
}

void main();
