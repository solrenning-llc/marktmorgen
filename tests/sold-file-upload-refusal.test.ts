/**
 * A refusal from the legacy upload route reaches the creator in the studio's
 * own words, through the real @vercel/blob client (Codex X6's LEVE on #3036).
 *
 * The SDK asks /api/store/file for its signed door and, on any non-OK answer,
 * throws a fixed "Failed to retrieve the presigned URL" without the body. The
 * route's body is the one tests/file-upload-admission.test.ts holds; here a
 * synthetic fetch answers with exactly that body, and the real SDK, the real
 * uploadSoldFile and the editors' readers are exercised. No network, no store.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { UploadRefused, uploadReason, uploadSoldFile, uploadWords } from "@/lib/sold-file-upload";
import { DOOR_ECHO_HEADER } from "@/lib/upload-door";
import { UPLOAD_REQUESTS_PER_OPEN } from "@/lib/spend-cost-table";

type Answer = { status: number; body: unknown };

/** A synthetic browser: the vault is off, the legacy route answers `answer`. */
async function withRoute<T>(answer: Answer, run: (asked: string[]) => Promise<T>): Promise<T> {
  const previousFetch = globalThis.fetch;
  const previousLocation = (globalThis as { location?: unknown }).location;
  const asked: string[] = [];
  (globalThis as { location?: unknown }).location = { href: "https://studio.example.test/studio", origin: "https://studio.example.test" };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://studio.example.test/");
    const echoed = new Headers(init?.headers).get(DOOR_ECHO_HEADER);
    asked.push(`${init?.method ?? "GET"} ${url.host === "studio.example.test" ? url.pathname : url.host}${echoed === null ? "" : " (echo)"}`);
    if (url.pathname === "/api/store/vault") return Response.json({ ok: false, error: "off" });
    if (url.pathname === "/api/store/file") {
      // The route's echo, as app/api/store/file/route.ts answers it.
      if (echoed !== null) return Response.json({ type: "blob.generate-presigned-url", presignedUrlPayload: JSON.parse(echoed) });
      return Response.json(answer.body, { status: answer.status });
    }
    // The file store itself, for the one test whose door is granted.
    const pathname = url.searchParams.get("pathname") ?? "unknown";
    return Response.json({ url: `https://store.example.test/${pathname}`, downloadUrl: `https://store.example.test/${pathname}?download=1`, pathname, contentType: "application/pdf", contentDisposition: "attachment" });
  }) as typeof fetch;
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = previousFetch;
    (globalThis as { location?: unknown }).location = previousLocation;
  }
}

const file = () => new File([new Uint8Array(16)], "guide.pdf", { type: "application/pdf" });
const where = { folder: "store-folder", ownerId: "product-1" };

async function refusalOf(answer: Answer): Promise<unknown> {
  return withRoute(answer, async (asked) => {
    const thrown = await uploadSoldFile(file(), where, () => {}).then(() => null, (error: unknown) => error);
    assert.ok(thrown, "the upload is refused");
    assert.deepEqual(asked, ["POST /api/store/vault", "POST /api/store/file"], "asked once each: the refusal is not asked again");
    return thrown;
  });
}

// The client reads the store from the token's first segment (base64url JSON).
const TOKEN = `${Buffer.from(JSON.stringify({ storeId: "store_synthetic" })).toString("base64url")}.synthetic`;
const DOOR = { delegationToken: TOKEN, signature: "synthetic-signature", params: { pathname: "stores/store-folder/product-1/guide.pdf" } };

test("a granted door is asked for once and handed to the client unchanged, through the route's echo", async () => {
  await withRoute({ status: 200, body: { type: "blob.generate-presigned-url", presignedUrlPayload: DOOR } }, async (asked) => {
    const before = globalThis.fetch;
    const pathname = await uploadSoldFile(file(), where, () => {});
    assert.ok(pathname.endsWith("guide.pdf"), pathname);
    assert.deepEqual(asked.slice(0, 3), ["POST /api/store/vault", "POST /api/store/file", "POST /api/store/file (echo)"], "the real ask once, then only the echo");
    assert.equal(asked.filter((line) => line === "POST /api/store/file").length, 1, "admission is asked once per upload");
    assert.ok(asked.length > 3, "the client then sends the file to the store");
    // The upload allowance prices UPLOAD_REQUESTS_PER_OPEN requests per open
    // (lib/spend-cost-table.ts). Here: the ask and the echo, and room for one
    // completion callback, although this route sets none.
    const routeRequests = asked.filter((line) => line.startsWith("POST /api/store/file")).length;
    assert.equal(routeRequests, 2);
    assert.ok(routeRequests + 1 <= UPLOAD_REQUESTS_PER_OPEN, "the echo stays inside the requests an open is priced at");
    assert.equal(globalThis.fetch, before, "the page's fetch is never replaced");
  });
});

test("an uncountable studio action reaches the creator in the studio's words, not as a server error", async () => {
  const words = "This can't be counted right now. Try again in a minute.";
  const thrown = await refusalOf({ status: 429, body: { ok: false, error: "used", message: words } });
  assert.ok(thrown instanceof UploadRefused, "the SDK's fixed error is replaced by the route's refusal");
  assert.equal(uploadReason(thrown), "used");
  assert.equal(uploadWords(thrown), words);
});

test("each admission refusal keeps its reason and words through the SDK", async () => {
  for (const [reason, status] of [["locked", 403], ["signed_out", 401], ["two_step", 403], ["renewal_unpaid", 409], ["files_unavailable", 503]] as const) {
    const thrown = await refusalOf({ status, body: { ok: false, error: reason, message: `Synthetic ${reason}` } });
    assert.equal(uploadReason(thrown), reason, reason);
    assert.equal(uploadWords(thrown), `Synthetic ${reason}`, reason);
  }
});

test("a refusal without words keeps its reason, and the editor falls back to its own sentence", async () => {
  const thrown = await refusalOf({ status: 403, body: { ok: false, error: "forbidden" } });
  assert.equal(uploadReason(thrown), "forbidden");
  assert.equal(uploadWords(thrown), undefined);
});

test("an answer that is not a refusal body stays a server error, never words from elsewhere", async () => {
  for (const body of ["<html>bad gateway</html>", { ok: false, error: "Not A Reason!" }, { ok: false, error: "used", message: 42 }, { ok: false, error: "used", message: "x".repeat(1_001) }]) {
    const thrown = await refusalOf({ status: 502, body });
    const reason = uploadReason(thrown);
    assert.ok(reason === "server_error" || reason === "used", `reason ${reason}`);
    assert.equal(uploadWords(thrown), undefined, "no words unless a short string from the route's refusal");
  }
});

test("a refusal leaves the page's fetch as it was", async () => {
  await withRoute({ status: 429, body: { ok: false, error: "used", message: "m" } }, async () => {
    const before = globalThis.fetch;
    await uploadSoldFile(file(), where, () => {}).catch(() => null);
    assert.equal(globalThis.fetch, before);
  });
});

// components/product-editor.tsx is reserved by Claude 4 (789 [IV1] 5b): it
// already gets the route's reason through uploadReason; its words wait on that
// reservation and join this list with it.
test("the podcast and course editors show the route's words first", () => {
  for (const editor of ["components/podcast-editor.tsx", "components/course-editor.tsx"]) {
    const source = readFileSync(editor, "utf8");
    assert.match(source, /uploadWords\(thrown\) \?\?/, `${editor} reads the route's words before its own sentence`);
  }
});
