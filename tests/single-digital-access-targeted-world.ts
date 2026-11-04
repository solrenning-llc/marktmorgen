/** Synthetic network/blob boundary, never a payment or storage account. */
import { MockAgent, setGlobalDispatcher } from "undici";
import { singleDigitalFixture } from "./single-digital-confirmation-world";
import { setProductFile, setProductShipping, storeFolder, storeForEmail } from "@/lib/store";
import { fileFolder } from "@/lib/product-file";
import { ordersLinkFor } from "@/lib/buyer-orders";
import { seal } from "@/lib/secret-box";
import { createHash } from "node:crypto";
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const metadataHash = (meta: Record<string, unknown>) => hash(Object.entries(meta).sort(([a],[b]) => a.localeCompare(b)));
export const blobReads: string[] = [];
export async function fixture() {
  process.env.STRIPE_SECRET_KEY = "sk_test_SYNTHETIC_ACCESS_ONLY";
  process.env.RESEND_API_KEY = "re_SYNTHETIC_ACCESS_ONLY";
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_SYNTHETIC_ONLY";
  const blobs = new MockAgent(); blobs.disableNetConnect(); setGlobalDispatcher(blobs);
  blobs.get("https://synthetic.private.blob.vercel-storage.com").intercept({ method: "GET", path: /.*/ }).reply(200, options => {
    blobReads.push(decodeURIComponent(String(options.path).split("?")[0].slice(1)));
    return "SYNTHETIC_PAID_FILE";
  }, { headers: { "content-type": "application/pdf" } }).persist();
  const f = await singleDigitalFixture();
  await setProductShipping(f.store.email, f.product.id, null);
  const folder = await storeFolder(f.store.email);
  f.product.file!.pathname = `${fileFolder(folder!, f.product.id)}original.pdf`;
  await setProductFile(f.store.email, f.product.id, f.product.file);
  const store = (await storeForEmail(f.store.email))!;
  const email = "buyer@example.test", sessionId = "cs_test_SyntheticOldDigitalAccess001";
  const meta = { store: store.handle, product: f.product.id, mm_order_origin: "single-digital-v1", mm_order_intent: "a".repeat(64), mm_order_hash: "b".repeat(64), dc: "yes:synthetic:d:1700000000" };
  const session = { object: "checkout.session", id: sessionId, status: "complete", mode: "payment", payment_status: "paid", created: Math.floor(f.created/1000)-96*3600,
    amount_total: 3500, currency: "usd", customer_details: { email }, metadata: meta,
    line_items: { object: "list", has_more: false, data: [{ quantity: 1, price: { unit_amount: 3500, currency: "usd" } }] },
    payment_intent: { object: "payment_intent", id: "pi_SyntheticDigital001", status: "succeeded", amount_received: 3500, currency: "usd",
      latest_charge: { object: "charge", id: "ch_SyntheticDigital001", payment_intent: "pi_SyntheticDigital001", paid: true, disputed: false, amount: 3500, currency: "usd", amount_refunded: 0, refunded: false } } };
  const gets: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method && init.method !== "GET") throw Error("No external writes are allowed");
    const parsed = new URL(String(url)), path = parsed.pathname;
    if (parsed.hostname === "SYNTHETIC.private.blob.vercel-storage.com".toLowerCase()) {
      blobReads.push(decodeURIComponent(path.slice(1)));
      return new Response("SYNTHETIC_PAID_FILE", { headers: { "content-type": "application/pdf" } });
    }
    if (parsed.hostname !== "api.stripe.com") throw Error("Unexpected synthetic host");
    gets.push(String(url));
    if (path.endsWith("/"+sessionId)) return Response.json(session);
    const own = f.sessions.get(path.split("/").at(-1)!); if (own) return Response.json(own);
    if (path.endsWith("/checkout/sessions")) return Response.json({ data: Array.from({ length: 40 }, (_,i) => ({ ...session, id: `cs_test_newerDigitalPurchase${String(i).padStart(10,"0")}`, created: session.created + 1000+i })) });
    if (path.endsWith("/payment_intents")) return Response.json({ data: [] });
    throw Error("Unexpected synthetic lookup: "+String(url));
  };
  const link = await ordersLinkFor(store, email, `https://example.test/@${store.handle}`); if (!link) throw Error("Synthetic token missing");
  const token = new URL(link).searchParams.get("token")!;
  const capsule = { version: 1, sid: store.sid, statsId: store.statsId, accountId: store.stripeAccountId, sessionId, productId: f.product.id,
    email, currency: "usd", unitCents: 3500, paidCents: 3500, created: session.created, metadataHash: metadataHash(meta) };
  const origin = seal(JSON.stringify(capsule), "single-digital-access|v1");
  const url = new URL(`https://example.test/api/store/download?${new URLSearchParams({ handle: store.handle, token, ref: sessionId, origin })}`);
  return { ...f, store, email, session, capsule, token, url, gets };
}
