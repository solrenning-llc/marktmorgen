/**
 * A session let in without the second step (lib/two-step.ts, enterLocked)
 * keeps "products": it may edit them, hide them and change their order. It
 * may not destroy them (506 [SG1], MM-SA-14): removing a product deletes its
 * files, its course lessons, the work its students handed in, its reviews and
 * its page for good, and putting a link on a product deletes the file the
 * link replaces. Both are refused with the studio's own "locked" answer while
 * the session is locked; a full session still does both, and the roles that
 * may remove a product are the same as before.
 *
 * What fails here:
 *   - a locked session removing a product, or anything of it going;
 *   - a locked session replacing a product's file with a link;
 *   - a locked session refused an ordinary edit, or a link on a product with no file;
 *   - a full session refused the removal.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { base32Decode, codeAt, STEP_SECONDS } from "@/lib/totp";
import { SESSION_COOKIE, emailForSession, openSession } from "@/lib/auth";
import { finishSetup, lockedUntil, startSetup } from "@/lib/two-step";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setProductFile, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { POST as callback } from "@/app/api/auth/callback/route";
import { POST as codeRoute } from "@/app/api/auth/code/route";
import { POST as productRoute } from "@/app/api/store/product/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_locked_product_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const host = new URL(String(input instanceof Request ? input.url : input)).hostname;
  if (host === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  if (host === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const codeTo = (to: string) => /Your code: (\d{6})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
const nowCode = (secret: string) => codeAt(base32Decode(secret)!, Math.floor(Date.now() / 1000 / STEP_SECONDS));
const form = (url: string, fields: Record<string, string>, cookie = "") =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields) });
const cookieOf = (response: Response, name: string) => (response.headers.get("set-cookie") ?? "").match(new RegExp(`${name}=([^;]*)`))?.[1] ?? "";

async function lockedSessionFor(email: string): Promise<string> {
  const token = sha(String(Math.random()));
  await redis.pipeline([["SET", `nl:auth:link:${sha(`nimbus-auth-link:${token}`).slice(0, 40)}`, email, "EX", 900]]);
  const hold = cookieOf(await callback(form("https://marktmorgen.com/api/auth/callback", { token })), "nl_2fa");
  return cookieOf(await codeRoute(form("https://marktmorgen.com/api/auth/code", { action: "reset" }, `nl_2fa=${hold}`)), "nl_session");
}

async function product(session: string, body: Record<string, unknown>): Promise<{ status: number; error?: string }> {
  const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  return { status: response.status, error: ((await response.json()) as { error?: string }).error };
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "owner@locked-product.example";
  const BACKUP = "owner.backup@locked-product.example";
  await claimHandle(OWNER, "locked-product", "Locked Product", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1LockedProductXX", true);
  await setSubscription(OWNER, { customerId: "cus_lockedproduct", subscriptionId: "sub_lockedproduct", active: true, tier: "creator", period: paidPeriod() });
  const started = await startSetup(OWNER, "c".repeat(64), BACKUP);
  if (typeof started === "string") throw new Error(`setup: ${started}`);
  const finished = await finishSetup(OWNER, "c".repeat(64), nowCode(started.secret), codeTo(BACKUP));
  if (typeof finished === "string") throw new Error(`finish: ${finished}`);

  const added = await addProduct(OWNER, "Field Guide", "Plants of the coast.", "20");
  if (!added.ok) throw new Error("no product");
  const id = added.product.id;
  const file = { pathname: `stores/locked-product/${id}/guide.pdf`, name: "guide.pdf", bytes: 1_000, contentType: "application/pdf", addedAt: "2026-10-01T00:00:00.000Z" };
  const put = await setProductFile(OWNER, id, file);
  if (!put.ok) throw new Error("no file");
  const plain = await addProduct(OWNER, "Coast Walk", "A walk.", "10");
  if (!plain.ok) throw new Error("no second product");
  const listing = async (which: string) => readListing((await storeForEmail(OWNER))!, which);

  const locked = await lockedSessionFor(OWNER);
  is("the session is the owner's, and locked", [await emailForSession(locked), (await lockedUntil(locked)) > 0], [OWNER, true]);

  part("A locked session cannot remove a product");
  is("refused with the studio's locked answer", await product(locked, { action: "remove", id }), { status: 403, error: "locked" });
  const kept = await listing(id);
  is("the product is still there, with its file", [kept?.id, kept?.file?.pathname], [id, file.pathname]);
  is("and the studio says why in its own words", typeof STUDIO_MESSAGES.locked === "string" && STUDIO_MESSAGES.locked.includes("second step"), true);

  part("Nor delete a product's file by putting a link in its place");
  is("refused while the product holds a file", await product(locked, { action: "link", id, link: "https://example.com/guide" }), { status: 403, error: "locked" });
  is("the file is still on the product", (await listing(id))?.file?.pathname, file.pathname);

  part("What a locked session keeps");
  is("an ordinary edit is saved", (await product(locked, { action: "edit", id, title: "Field Guide, second edition", summary: "Plants of the coast.", price: "20" })).status, 200);
  is("a link on a product with no file is saved (nothing is deleted)", (await product(locked, { action: "link", id: plain.product.id, link: "https://example.com/walk" })).status, 200);
  is("hiding a product is saved", (await product(locked, { action: "visibility", id: plain.product.id, hidden: true })).status, 200);

  part("A full session still removes it, and the roles are unchanged");
  const full = await openSession(OWNER);
  is("removed", (await product(full, { action: "remove", id })).status, 200);
  is("and gone", await listing(id), null);
  is("the route still asks for the products permission, so the roles that may remove one are unchanged", readFileSync("app/api/store/product/route.ts", "utf8").includes('guardStoreWrite(request, "products", 40_000)'), true);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
