/** The sole transactional Resend POST transport. A provider usage reply has
 * no account identity, so a separately reviewed credential/account binding
 * is required; a successful GET alone never proves ownership or a hard cap.
 */
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { RESEND_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import { redisPipeline } from "@/lib/redis";
import {
  CURRENT_RESEND_FALLBACK_REVIEW, reserveResendFallback,
  markResendFallbackDispatched, settleResendFallback, readAcceptedResendFallbackReceipt,
  type ResendFallbackReview, type ResendFallbackSdk, type ResendFallbackUsage,
} from "@/lib/resend-fallback-budget";

export type ResendCredentialBinding = {
  accountId: string; evidence: string; checkedAtMs: number; validUntilMs: number;
  usageCredentialSha256: string; sendingCredentialSha256s: string[];
};
export const CURRENT_RESEND_CREDENTIAL_BINDING: ResendCredentialBinding | null = null;
export type ResendTransportRuntime = {
  review?: ResendFallbackReview | null; binding?: ResendCredentialBinding | null;
  pipeline?: ResendFallbackSdk["pipeline"]; fetch?: typeof fetch;
};
/** Only a missing current proof is known here. Synchronous and without IO;
 * false does not validate the proof, credentials, remaining quota or sending
 * permission. The real guarded POST still performs all those checks.
 */
export function currentResendFallbackProofIsMissing(runtime: Pick<ResendTransportRuntime, "review" | "binding"> = {}): boolean {
  const proof = data(runtime);
  if (!proof) return true;
  const review = proof.review === undefined ? CURRENT_RESEND_FALLBACK_REVIEW : proof.review;
  const binding = proof.binding === undefined ? CURRENT_RESEND_CREDENTIAL_BINDING : proof.binding;
  return review === null || binding === null;
}

export type ResendPost = {
  base: string; path: "/emails" | "/emails/batch"; credential: string;
  usageCredential: string; body: string; idempotencyKey?: string; recipients: number;
  beforePost?: () => Promise<boolean>;
};
export type ResendPostResult =
  | { kind: "response"; response: Response }
  | { kind: "accepted_receipt" }
  | { kind: "blocked" | "unknown" };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
// The existing inbound producer permits 15 MB BEFORE base64, plus two
// bounded bodies. A 15 MB serialized cap would silently remove that right.
const MAX_SERIALIZED_EMAIL_BYTES = 40_000_000;
function data(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !d || !Object.hasOwn(d, "value")) return null;
      copy[key] = d.value;
    }
    return copy;
  } catch { return null; }
}
function ownArray(value: unknown, limit: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const size = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(size) || size < 0 || size > limit || Reflect.ownKeys(value).length !== size + 1) return null;
    const out: unknown[] = [];
    for (let i = 0; i < size; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d || !Object.hasOwn(d, "value")) return null;
      out.push(d.value);
    }
    return out;
  } catch { return null; }
}
async function json(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65_536) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
function accepted(value: unknown, path: ResendPost["path"], n: number): boolean {
  const record = data(value);
  const valid = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= 256;
  if (!record || Object.hasOwn(record, "error")) return false;
  if (path === "/emails") return n === 1 && valid(record.id);
  const rows = ownArray(record.data, 100);
  return rows?.length === n && rows.every(row => valid(data(row)?.id)) && new Set(rows.map(row => data(row)?.id)).size === n;
}
function recipientsMatch(body: string, path: ResendPost["path"], n: number): boolean {
  try {
    const decoded: unknown = JSON.parse(body);
    const rows = path === "/emails" ? [decoded] : ownArray(decoded, 100);
    return rows?.length === n && rows.every(row => {
      const record = data(row);
      const to = record ? ownArray(record.to, 1) : null;
      return record && !Object.hasOwn(record, "cc") && !Object.hasOwn(record, "bcc") && to?.length === 1 &&
        typeof to[0] === "string" && to[0].length <= 320 && /^[^\s<>(),;:]+@[^\s<>(),;:]+\.[^\s<>(),;:]+$/.test(to[0]);
    });
  } catch { return false; }
}
/** A documented non-acceptance response, never a generic false/timeout/5xx
 * or an idempotency conflict which could describe an earlier acceptance.
 */
const notAccepted = (status: number) => [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(status);

export async function guardedResendPost(request: ResendPost, runtime: ResendTransportRuntime = {}): Promise<ResendPostResult> {
  const review = data(runtime.review === undefined ? CURRENT_RESEND_FALLBACK_REVIEW : runtime.review);
  const binding = data(runtime.binding === undefined ? CURRENT_RESEND_CREDENTIAL_BINDING : runtime.binding);
  const input = data(request);
  const now = Date.now();
  const keys = binding ? ownArray(binding.sendingCredentialSha256s, 32) : null;
  if (!review || !binding || !input || typeof review.accountId !== "string" || binding.accountId !== review.accountId ||
      typeof binding.evidence !== "string" || !binding.evidence.trim() ||
      typeof binding.checkedAtMs !== "number" || !Number.isSafeInteger(binding.checkedAtMs) || binding.checkedAtMs > now || binding.checkedAtMs < 0 ||
      typeof binding.validUntilMs !== "number" || !Number.isSafeInteger(binding.validUntilMs) || binding.validUntilMs <= now ||
      typeof binding.usageCredentialSha256 !== "string" || !HASH.test(binding.usageCredentialSha256) ||
      !keys?.length || !keys.every(key => typeof key === "string" && HASH.test(key)) ||
      typeof input.credential !== "string" || typeof input.usageCredential !== "string" ||
      !keys.includes(hash(input.credential)) || hash(input.usageCredential) !== binding.usageCredentialSha256 ||
      typeof input.base !== "string" || !/^https:\/\/api\.resend\.com$|^http:\/\/127\.0\.0\.1:\d+$/.test(input.base) ||
      input.path !== "/emails" && input.path !== "/emails/batch" || typeof input.body !== "string" || Buffer.byteLength(input.body) > MAX_SERIALIZED_EMAIL_BYTES ||
      !Number.isSafeInteger(input.recipients) || Number(input.recipients) < 1 || Number(input.recipients) > 100 ||
      input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length > 256) ||
      input.beforePost !== undefined && typeof input.beforePost !== "function") return { kind: "blocked" };
  // Retain the validated snapshot; no original request getter is read again.
  const r = input as unknown as ResendPost;
  if (!recipientsMatch(r.body, r.path, r.recipients)) return { kind: "blocked" };
  if (typeof review.validUntilMs === "number") review.validUntilMs = Math.min(review.validUntilMs, binding.validUntilMs);
  const fetcher = runtime.fetch ?? fetch;
  const sdk = { pipeline: runtime.pipeline ?? redisPipeline };
  let usage: ResendFallbackUsage;
  try {
    const body = await timed(RESEND_TIMEOUT_MS, async signal => {
      const response = await fetcher(`${r.base}/usage`, { headers: { Authorization: `Bearer ${r.usageCredential}` }, cache: "no-store", signal });
      if (!response.ok) return null;
      return data(await json(response));
    });
    const monthly = data(data(body?.emails)?.monthly);
    if (body?.object !== "usage" || !monthly) return { kind: "unknown" };
    usage = { source: "resend_usage_api", accountId: review.accountId, observedAtMs: Date.now(), monthly: {
      used: monthly.used as number, sent: monthly.sent as number, received: monthly.received as number,
      limit: monthly.limit as number, resetsAt: monthly.resets_at as string,
    } };
  } catch { return { kind: "unknown" }; }
  const under = r.idempotencyKey?.trim() ? r.idempotencyKey : `nimbus-call:${randomBytes(16).toString("hex")}`;
  const attemptId = hash(JSON.stringify([r.path, r.body, under ?? null]));
  const payloadFingerprint = hash(r.body);
  const reserve = await reserveResendFallback({ review, usage, attemptId, payloadFingerprint, recipients: r.recipients }, sdk);
  if (reserve.status !== "reserved" && reserve.status !== "already_reserved") {
    const receipt = await readAcceptedResendFallbackReceipt({ accountId: review.accountId, attemptId, payloadFingerprint, recipients: r.recipients }, sdk);
    if (receipt.status === "accepted") return { kind: "accepted_receipt" };
    return { kind: reserve.status === "denied" ? "blocked" : "unknown" };
  }
  // Only this invocation's acknowledged exclusive dispatch may debit a
  // caller's allowance. A shared reserved claim is not that capability.
  const dispatch = await markResendFallbackDispatched(reserve.claim, sdk);
  if (dispatch.status !== "dispatch") return { kind: "unknown" };
  if (r.beforePost) {
    let ready = false;
    try { ready = await r.beforePost(); } catch { /* No HTTP POST is made. */ }
    // The callback cannot have started this guard's provider request. Settle
    // only our own dispatch, never cancel a shared reservation or refund an
    // unknown caller debit. An unconfirmed settlement still reports unknown.
    if (ready !== true) { await settleResendFallback(dispatch.claim, "confirmed_not_accepted", sdk); return { kind: "unknown" }; }
  }
  try {
    const result = await timed(RESEND_TIMEOUT_MS, async signal => {
      // No await, user callback, serialization or mutable payload between this
      // clock check and invoking the exact single HTTP request.
      if (!Number.isFinite(dispatch.sendBeforeMonotonicMs) || Date.now() >= dispatch.sendBeforeMs || performance.now() >= dispatch.sendBeforeMonotonicMs) return null;
      const response = await fetcher(`${r.base}${r.path}`, {
        method: "POST", headers: { Authorization: `Bearer ${r.credential}`, "Content-Type": "application/json", ...(under ? { "Idempotency-Key": under } : {}) },
        body: r.body, cache: "no-store", signal,
      });
      const proof = response.ok ? await json(response) : null;
      if (!response.ok) await response.body?.cancel();
      return { response, ok: response.ok && accepted(proof, r.path, r.recipients) };
    });
    if (!result) { await settleResendFallback(dispatch.claim, "unknown", sdk); return { kind: "unknown" }; }
    const outcome = result.ok ? "accepted" : notAccepted(result.response.status) ? "confirmed_not_accepted" : "unknown";
    let settled = await settleResendFallback(dispatch.claim, outcome, sdk);
    // A repeat of the same owned settlement reconciles a lost Redis ACK;
    // it never repeats the provider POST or releases another dispatch.
    if (settled.status !== "settled" && settled.status !== "already_settled") settled = await settleResendFallback(dispatch.claim, outcome, sdk);
    if (outcome === "unknown" || settled.status !== "settled" && settled.status !== "already_settled" || settled.outcome !== outcome) return { kind: "unknown" };
    return { kind: "response", response: result.response };
  } catch {
    await settleResendFallback(dispatch.claim, "unknown", sdk);
    return { kind: "unknown" };
  }
}
