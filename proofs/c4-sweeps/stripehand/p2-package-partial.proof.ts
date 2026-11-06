/**
 * P2. lib/call-packages.ts recordPackage (~:192-243). The package record is written first (SET NX), then its place in
 * the store's list, then the token the booking link carries, then the email. If the first write lands but its
 * answer is lost (a timeout after Redis applied it), recordPackage throws; every later call finds the record
 * (readBought) and returns it as it is: the token key is never written, no email is sent. The thanks page and the
 * sweep's confirmPurchase both go through recordPackage, so the buyer's booking link never works.
 * Real MemoryRedis; one pipeline throws after it ran.
 */
import { boughtByToken, readBought, recordPackage } from "@/lib/call-packages";
import { store as redis } from "@/tests/redis-stub";
import type { Store } from "@/lib/store";
import type { Listing } from "@/lib/catalog";

import { installSesMailFixture } from "@/tests/ses-mail-fixture";
const mail = installSesMailFixture({ fallback: () => new Response("{}", { status: 404 }) });
const emails = { get length() { return mail.ses.length; }, set length(_v: number) { mail.ses.length = 0; } };

const store = { statsId: "pkg0stats0001", sid: "pkgsid0001", handle: "harbor", name: "Harbor", language: "en", email: "owner@example.com", currency: "usd" } as unknown as Store;
const product = { id: "prod00000002", title: "Three coaching calls", call: null } as unknown as Listing;
const session = (id: string) => ({
  id, status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000), amount_total: 30000, currency: "usd",
  customer_details: { email: "buyer@example.com" }, metadata: { kind: "package", sessions: "3", days: "90", store: "harbor", product: product.id },
});
const input = (id: string) => ({ store, session: session(id) as Parameters<typeof recordPackage>[0]["session"], product, base: "https://example.com/@harbor", from: "Harbor <x@example.com>" });

async function main() {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  console.log("control: healthy");
  const ok = await recordPackage(input("cs_test_pkgproof0000000001"));
  console.log(`  bought=${Boolean(ok)} linkWorks=${Boolean(ok && (await boughtByToken(ok.token)))} emails=${emails.length}`);

  console.log("the record's write lands, its answer is lost (timeout)");
  emails.length = 0;
  const id = "cs_test_pkgproof0000000002";
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (c: (string | number)[][]) => {
    const a = await real(c);
    if (c.some((cmd) => cmd.some((x) => String(x).includes(`nl:pkg:${id}`))) && c.some((cmd) => cmd.some((x) => String(x) === "NX"))) throw new Error("Redis request timed out");
    return a;
  }) as typeof redis.pipeline;
  const first = await recordPackage(input(id)).then((b) => `returned ${Boolean(b)}`, (e: Error) => `threw ${e.message}`);
  redis.pipeline = real;
  console.log(`  first call (thanks page): ${first}; record kept=${Boolean(await readBought(id))}`);
  const again = await recordPackage(input(id));
  const sweep = await recordPackage(input(id));
  console.log(`  thanks page reload and sweep: bought=${Boolean(again)}/${Boolean(sweep)} linkWorks=${Boolean(again && (await boughtByToken(again.token)))} emails=${emails.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
