/**
 * Codex L on #3925 (MEDIUM, privacy): the studio's broadcast route read the
 * group (`who`) through `text(...)`, which turns anything that is not a
 * string into "", and createBroadcast reads "" as "nothing asked", so
 * everyone. A malformed group therefore scheduled a campaign to the whole
 * list instead of being refused. The product, the product left out and the
 * label narrow who it reaches the same way, and went through the same lossy
 * reading: each, malformed, widened the email to everyone.
 *
 * Through the real route, with an otherwise valid scheduled email: a wrong
 * type in any of the four is refused with a 400 and no campaign is written.
 * Controls: left out, or empty, each keeps its default and the campaign is
 * made. Synthetic records and the in-memory Redis only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { listBroadcasts } from "@/lib/broadcasts";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as mailRoute } from "@/app/api/store/mail/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const OWNER = "route-malformed-group@example.com";

async function setUp() {
  redis.clear();
  const made = await claimHandle(OWNER, "routemalformed", "Route Malformed", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_RouteMalformed1", subscriptionId: "sub_RouteMalformed1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Route Malformed", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  for (const name of ["ana", "ben"]) await upsertContact(store.listId as string, `${name}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);
  const session = await openSession(OWNER);
  const post = async (body: Record<string, unknown>) => {
    const response = await mailRoute(new NextRequest("https://marktmorgen.com/api/store/mail", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  return { store, post };
}

/** An otherwise valid email, scheduled for tomorrow, so nothing starts sending in the test. */
const email = () => ({ action: "broadcast", subject: "News", body: "Hello.", sendAt: Date.now() + 86_400_000 });

const malformed: [string, Record<string, unknown>][] = [
  ["a group that is an object", { who: { all: true } }],
  ["a group that is a list", { who: ["buyers"] }],
  ["a group that is a number", { who: 1 }],
  ["a product that is a list", { productId: ["course"] }],
  ["a product that is an object", { productId: { id: "course" } }],
  ["a product left out that is a number", { notProductId: 7 }],
  ["a label that is a list", { label: ["vip"] }],
  ["a label that is an object", { label: { name: "vip" } }],
];

for (const [name, field] of malformed) {
  test(`${name} is refused through the route, never read as everyone`, async () => {
    const { store, post } = await setUp();
    const answer = await post({ ...email(), ...field });
    assert.equal(answer.status, 400, JSON.stringify(answer.body));
    assert.equal(answer.body.ok, false);
    assert.deepEqual(await listBroadcasts(store.listId as string), [], "no campaign is written");
  });
}

test("control: left out or empty, each keeps its default and the campaign is made for everyone", async () => {
  const { store, post } = await setUp();
  const plain = await post(email());
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  const blank = await post({ ...email(), who: "", productId: "", notProductId: "", label: "" });
  assert.equal(blank.status, 200, JSON.stringify(blank.body));
  const nulls = await post({ ...email(), who: null, productId: null, notProductId: null, label: null });
  assert.equal(nulls.status, 200, JSON.stringify(nulls.body));
  const kept = await listBroadcasts(store.listId as string);
  assert.equal(kept.length, 3);
  for (const b of kept) {
    assert.equal(b.who, "all");
    assert.equal(b.total, 2);
  }
});

test("control: a group that is one of the three is kept", async () => {
  const { store, post } = await setUp();
  const answer = await post({ ...email(), who: "all" });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal((await listBroadcasts(store.listId as string)).length, 1);
});
