/**
 * A session let in without its second step (lib/two-step.ts) may not replace
 * a file already delivered: the attach (app/api/store/file/attach) answers
 * "locked". The upload door (app/api/store/vault) used to learn that only
 * after the whole file had gone up to the file store, so each try left a
 * file nothing points at, counted against the store's storage and billed
 * (issue #3936). The door now refuses the same case at "open", before any
 * provider call and before any reservation.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductFile } from "@/lib/store";
import { openLockedSession } from "@/lib/two-step";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { POST as vault } from "@/app/api/store/vault/route";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
process.env.R2_ACCESS_KEY_ID = "1234567890123456";
process.env.R2_SECRET_ACCESS_KEY = "x".repeat(32);
process.env.R2_BUCKET = "test-files";

const providerCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("r2.cloudflarestorage.com")) providerCalls.push(url);
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const OWNER = "vault.locked@example.com";
const ORIGIN = "https://marktmorgen.com";
const json = (session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}/api/store/vault`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const answer = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? ""];
const open = (ownerId: string) => ({ action: "open", ownerId, name: "new.pdf", bytes: 2 * 1024 ** 3, type: "application/pdf", multipart: true });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "vaultlocked", "Vault Locked", "");
  await ensureStatsId(OWNER);
  const withFile = await addProduct(OWNER, "Book", "", "20", null);
  const empty = await addProduct(OWNER, "Guide", "", "20", null);
  if (!withFile.ok || !empty.ok) throw new Error("no product");
  await setProductFile(OWNER, withFile.product.id, { pathname: `stores/x/${withFile.product.id}/book.pdf`, name: "book.pdf", bytes: 10, contentType: "application/pdf", addedAt: "" });
  const locked = await openLockedSession(OWNER, Date.now() + 7 * 86_400_000);
  const full = await openSession(OWNER);

  part("A locked session cannot upload a file the attach would refuse");
  providerCalls.length = 0;
  const before = new Set(redis.keys());
  is("opening an upload over a delivered file is refused as locked", await answer(await vault(json(locked, open(withFile.product.id)))), [403, "locked"]);
  is("and nothing was asked of the file store", providerCalls, []);
  // The sign-in guard counts the request itself; nothing of the upload (its hourly count, a storage or budget reservation) is written.
  is("and nothing of the upload was written (no count, no reservation)", redis.keys().filter((key) => !before.has(key) && /vault|storage|upload/.test(key)), []);

  part("Everything else goes on as before");
  is("a locked session may still upload onto a product with no file yet", (await answer(await vault(json(locked, open(empty.product.id)))))[1] !== "locked", true);
  is("the full session is not held by the lock", (await answer(await vault(json(full, open(withFile.product.id)))))[1] !== "locked", true);

  done();
}

void main();
