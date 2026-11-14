/**
 * SG2(17), #2608: the public email forms that moved to a fail-closed counter
 * still tell a real excess ("limited") apart from a counter that could not be
 * read ("error"), as essentialLimitState allows (lib/request-guard.ts). Each is
 * run on the in-memory Redis with its counter full, then with Redis throwing on
 * that counter only; nothing is sent in either case.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setContact, setSubscription, storeForEmail } from "@/lib/store";
import { requestHubLink } from "@/lib/affiliate-hub";
import { requestLibraryLink } from "@/lib/buyer-library";
import { sendContact } from "@/lib/store-contact";
import { sendFeedLink } from "@/lib/podcast-access";
import { readListing } from "@/lib/catalog";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ORIGIN = "https://marktmorgen.com";
let sent = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com" && (init?.method ?? "GET") === "POST") { sent += 1; return new Response(JSON.stringify({ id: `email_${sent}` })); }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Mode = "full" | "unknown";
const modes = new Map<string, Mode>();
const filled = new Set<string>();
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const [scope, mode] of modes) {
    const hit = commands.find((c) => String(c[1] ?? "").startsWith(`nl:rl:${scope}:`));
    if (!hit) continue;
    if (mode === "unknown") throw new Error("Redis timed out (synthetic)");
    filled.add(String(hit[1]));
    await real([["SET", String(hit[1]), "1000000000", "EX", 86_400]]);
  }
  return real(commands);
}) as typeof redis.pipeline;

async function under<T>(scope: string, mode: Mode, run: () => Promise<T>): Promise<{ value: T; sent: number }> {
  modes.clear();
  modes.set(scope, mode);
  const before = sent;
  try {
    return { value: await run(), sent: sent - before };
  } finally {
    modes.clear();
    if (filled.size) await real([["DEL", ...filled]]);
    filled.clear();
  }
}

async function both(label: string, scope: string, run: () => Promise<unknown>): Promise<void> {
  const full = await under(scope, "full", run);
  is(`${label}: past the limit is "limited"`, [full.value, full.sent], ["limited", 0]);
  const unknown = await under(scope, "unknown", run);
  is(`${label}: an unreadable count is "error", never "limited"`, [unknown.value, unknown.sent], ["error", 0]);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_essential_limit_only";
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  await setContact(OWNER, { on: true });
  const made = await addProduct(OWNER, "The Show", "", "12", null);
  if (!made.ok) throw new Error("setup: product");
  const store = async () => (await storeForEmail(OWNER))!;
  const product = (await readListing(await store(), made.product.id))!;

  part("The affiliate page link (lib/affiliate-hub.ts)");
  const hub = () => requestHubLink({ email: "lee@example.org", ip: "2.2.2.2", origin: ORIGIN });
  await both("per connection", "affhub-ip", hub);
  await both("per address", "affhub-address", hub);

  part("The buyer library link (lib/buyer-library.ts)");
  const library = () => requestLibraryLink({ email: "lee@example.org", ip: "3.3.3.3", origin: ORIGIN });
  await both("per connection", "library-ip", library);
  await both("per address", "library-address", library);

  part("A message to the creator (lib/store-contact.ts)");
  const contact = async () => sendContact({ store: await store(), name: "Lee", email: "lee@example.org", message: "Is the pie still on this Sunday?", ip: "4.4.4.4" });
  await both("per connection", "contact-ip", contact);
  await both("per store", "contact-store", contact);

  part("A podcast feed link (lib/podcast-access.ts)");
  const feed = async () => sendFeedLink({ store: await store(), product, email: "lee@example.org", ip: "5.5.5.5", base: ORIGIN, from: ORIGIN });
  await both("per address", "podcast-link-address", feed);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
