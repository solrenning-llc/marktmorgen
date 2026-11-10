/**
 * The Idempotency-Key rules (lib/api-idempotency-rules.ts), complement WG (a) of 616 [WP15], unit 1. Synthetic data
 * only. Each part fails on the wrong behavior it names: a repeat that runs the write again, a key used for another
 * request that is taken, a running request answered as new, an unknown record taken for "none", a header that
 * changes a request without a valid key, an answer too large to keep that lets the write run, a refused write that
 * holds its key, and a cost that is not counted.
 */
import { done, is, part } from "./check";
import {
  IDEMPOTENCY_COMMANDS, IDEMPOTENCY_SECONDS, IN_FLIGHT_WORDS, MAX_IDEMPOTENCY_KEY, MAX_IDEMPOTENCY_RECORD_BYTES, MAX_KEPT_ANSWER_BYTES,
  MISMATCH_WORDS, TOO_LARGE_WORDS, UNKNOWN_WORDS, afterWrite, decide, idempotencyWorstMicroUsd, readIdempotencyKey, readRecord,
  requestFingerprint, takesKey,
} from "@/lib/api-idempotency-rules";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { UPSTASH_MICRO_USD_PER_GB_MONTH, UPSTASH_MICRO_USD_PER_GB_TRANSFER, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS } from "@/lib/spend-cost-table";

const UUID = "8e03978e-40d5-43e8-bc93-6894a57f9324";
const T0 = 1_762_740_000_000;
const BODY = JSON.stringify({ buyer: "synthetic-buyer-1", product: "p_1" });
const FP = requestFingerprint("POST", "/api/v1/access", BODY);

part("The header: none changes nothing; a key in the draft's quoted form or bare; anything else is refused before any work");
{
  const kind = (h: string | null | undefined) => { const r = readIdempotencyKey(h); return r.kind === "key" ? `key:${r.key}` : r.kind; };
  is("no header, an empty one, spaces only", [kind(null), kind(undefined), kind(""), kind("   ")], ["none", "none", "none", "none"]);
  is("the draft's quoted String", kind(`"${UUID}"`), `key:${UUID}`);
  is("a bare value, as most APIs take it", kind(UUID), `key:${UUID}`);
  is("quoted with escapes", kind('"a\\"b\\\\c"'), 'key:a"b\\c');
  is("spaces around the header are not part of the key", kind(`  ${UUID}  `), `key:${UUID}`);
  is("the longest key", kind("k".repeat(MAX_IDEMPOTENCY_KEY)), `key:${"k".repeat(MAX_IDEMPOTENCY_KEY)}`);
  is("one character too many", kind("k".repeat(MAX_IDEMPOTENCY_KEY + 1)), "invalid");
  is("refused shapes", [kind('"unclosed'), kind('"'), kind('""'), kind('"a"b"'), kind('"bad\\escape"'), kind("tab\there"), kind("ünïcode"), kind('" padded "')],
    ["invalid", "invalid", "invalid", "invalid", "invalid", "invalid", "invalid", "invalid"]);
  const bad = readIdempotencyKey("k".repeat(300));
  is("the refusal says what a key must be and that nothing was done", bad.kind === "invalid" ? bad.message : "",
    "The Idempotency-Key header must be 1 to 255 printable characters, for example a UUID, with no spaces at either end. Nothing was done.");
}

part("What makes two requests the same: method, path and the exact body");
{
  is("the same request, the same fingerprint", requestFingerprint("post", "/api/v1/access", BODY), FP);
  is("another body", requestFingerprint("POST", "/api/v1/access", BODY.replace("p_1", "p_2")) === FP, false);
  is("another endpoint", requestFingerprint("POST", "/api/v1/codes", BODY) === FP, false);
  is("another method", requestFingerprint("PATCH", "/api/v1/access", BODY) === FP, false);
  is("a path cut short and its end moved into the body is not the same", requestFingerprint("POST", "/api/v1/acces", `s${BODY}`) === FP, false);
  is("a hex digest", /^[0-9a-f]{64}$/.test(FP), true);
}

part("A new request runs once; a repeat gets the first answer back and runs nothing");
{
  const first = decide(null, FP, T0);
  is("no record: run, after claiming it as pending", first, { kind: "run", claim: JSON.stringify({ state: "pending", fp: FP, at: T0 }) });
  const kept = afterWrite(FP, T0, 201, '{"ok":true,"access":"granted"}', "done");
  is("after the write: its answer is kept", kept.action, "keep");
  const record = kept.action === "keep" ? kept.record : "";
  is("a repeat a second later gets the same answer, nothing runs", decide(record, FP, T0 + 1_000), { kind: "replay", status: 201, body: '{"ok":true,"access":"granted"}' });
  is("a repeat at the last moment of 24 hours", decide(record, FP, T0 + IDEMPOTENCY_SECONDS * 1_000 - 1).kind, "replay");
  const stale = decide(record, FP, T0 + IDEMPOTENCY_SECONDS * 1_000);
  is("after 24 hours the key is new again, swapping only that exact record", stale, { kind: "run", claim: JSON.stringify({ state: "pending", fp: FP, at: T0 + IDEMPOTENCY_SECONDS * 1_000 }), replaces: record });
  const error = afterWrite(FP, T0, 409, '{"error":"exists"}', "maybe");
  is("an error after the write may have acted is kept and given back too", error.action === "keep" ? decide(error.record, FP, T0 + 5).kind : "", "replay");
}

part("The same key for another request: 422; while the first still runs: 409; unknown: 503. None runs the write");
{
  const pending = JSON.stringify({ state: "pending", fp: FP, at: T0 });
  const other = requestFingerprint("POST", "/api/v1/access", "{}");
  is("another body under the same key", decide(pending, other, T0 + 10), { kind: "mismatch", status: 422, message: MISMATCH_WORDS });
  const kept = afterWrite(FP, T0, 200, "{}", "done");
  is("another body after the first finished", kept.action === "keep" ? decide(kept.record, other, T0 + 10).kind : "", "mismatch");
  is("the same request while the first runs", decide(pending, FP, T0 + 10), { kind: "in_flight", status: 409, message: IN_FLIGHT_WORDS });
  is("a record that cannot be read is unknown, never 'none'", [
    decide(undefined, FP, T0), decide("", FP, T0), decide("{", FP, T0), decide(42, FP, T0), decide(["x"], FP, T0),
    decide(JSON.stringify({ state: "pending", fp: "short", at: T0 }), FP, T0),
    decide(JSON.stringify({ state: "pending", fp: FP, at: T0, extra: 1 }), FP, T0),
    decide(JSON.stringify({ state: "done", fp: FP, at: T0, status: 99, body: "" }), FP, T0),
    decide(JSON.stringify({ state: "done", fp: FP, at: T0, status: 200 }), FP, T0),
    decide(JSON.stringify({ state: "later", fp: FP, at: T0 }), FP, T0),
  ].map((d) => d.kind), Array(10).fill("unknown"));
  is("the unknown answer asks for the same key again", decide("{", FP, T0), { kind: "unknown", status: 503, message: UNKNOWN_WORDS });
  is("each answer says nothing was done", [MISMATCH_WORDS, IN_FLIGHT_WORDS, UNKNOWN_WORDS, TOO_LARGE_WORDS].every((w) => /Nothing was done|nothing was done/.test(w)), true);
}

part("What is kept after the write");
{
  is("a write that changed nothing lets the key go, so it can be sent again once fixed", afterWrite(FP, T0, 400, '{"error":"invalid"}', "none"), { action: "release" });
  is("one that may have changed something keeps its answer", afterWrite(FP, T0, 502, "{}", "maybe").action, "keep");
  is("the kept record reads back exactly", (() => { const k = afterWrite(FP, T0, 201, "{}", "done"); return k.action === "keep" ? readRecord(k.record) : null; })(),
    { state: "done", fp: FP, at: T0, status: 201, body: "{}" });
  const big = "x".repeat(MAX_KEPT_ANSWER_BYTES + 1);
  is("an answer larger than is kept holds the claim, so a repeat is told 409, never run twice", afterWrite(FP, T0, 200, big, "done"), { action: "hold" });
  is("bytes, not characters: a multi-byte answer over the ceiling holds too", afterWrite(FP, T0, 200, "é".repeat(MAX_KEPT_ANSWER_BYTES / 2 + 1), "done"), { action: "hold" });
  is("an answer at the ceiling is kept", afterWrite(FP, T0, 200, "x".repeat(MAX_KEPT_ANSWER_BYTES), "done").action, "keep");
  const atCeiling = afterWrite(FP, T0, 200, "é".repeat(MAX_KEPT_ANSWER_BYTES / 2), "done");
  is("a record kept is never over the priced ceiling, as stored", atCeiling.action === "keep" ? new TextEncoder().encode(atCeiling.record).length <= MAX_IDEMPOTENCY_RECORD_BYTES : true, true);
  // The escaped worst case: an answer within 8 KB whose quotes double once stored inside the record.
  const quotes = JSON.stringify({ note: "\"".repeat(4_000) });
  is("an answer within 8 KB that escapes past the record's ceiling is held, never kept over it", [new TextEncoder().encode(quotes).length <= MAX_KEPT_ANSWER_BYTES, afterWrite(FP, T0, 200, quotes, "done").action], [true, "hold"]);
  const controls = "\u0001".repeat(2_000);
  is("control characters, six bytes each once escaped, are held too", afterWrite(FP, T0, 200, controls, "done").action, "hold");
  const near = afterWrite(FP, T0, 200, JSON.stringify({ note: "\"".repeat(1_900) }), "done");
  is("and one that still fits once escaped is kept", near.action, "keep");
  is("readRecord reads nothing over the ceiling, so a kept record is always readable", [near.action === "keep" ? readRecord(near.record) !== null : false, readRecord(JSON.stringify({ state: "done", fp: FP, at: T0, status: 200, body: "y".repeat(MAX_IDEMPOTENCY_RECORD_BYTES) }))], [true, null]);
}

part("A write whose answer can be larger than is kept refuses a key before it runs");
{
  is("takes a key", [takesKey(512), takesKey(MAX_KEPT_ANSWER_BYTES)], [true, true]);
  is("does not", [takesKey(MAX_KEPT_ANSWER_BYTES + 1), takesKey(0), takesKey(-1), takesKey(1.5), takesKey(Number.NaN)], [false, false, false, false, false]);
}

part("The most it can cost, counted before it is turned on, from the plan's own API figure");
{
  const by = (requests: number) => {
    const gb = (requests * MAX_IDEMPOTENCY_RECORD_BYTES) / 1e9;
    return Math.ceil((requests * IDEMPOTENCY_COMMANDS * UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1e6 + 2 * gb * UPSTASH_MICRO_USD_PER_GB_TRANSFER + gb * UPSTASH_MICRO_USD_PER_GB_MONTH);
  };
  const plans = (["creator", "pro", "scale"] as const).map((tier) => [tier, STORE_ALLOWANCES[tier].api, idempotencyWorstMicroUsd(STORE_ALLOWANCES[tier].api)]);
  is("each paid plan, every API request of its month keyed", plans, (["creator", "pro", "scale"] as const).map((tier) => [tier, STORE_ALLOWANCES[tier].api, by(STORE_ALLOWANCES[tier].api)]));
  // Store, 500 requests: 1,500 commands = 3,000; 500 × 8,448 bytes = 0.004224 GB, moved twice = 253.44, kept = 1,056.
  is("today's figures, in micro-dollars (Store, Studio, Scale): at most $0.0044, $0.0173, $0.0862 a month", plans.map((p) => p[2]), [4_310, 17_238, 86_189]);
  is("nothing keyed, nothing spent", idempotencyWorstMicroUsd(0), 0);
  let threw = 0;
  for (const bad of [-1, 1.5, Number.NaN]) { try { idempotencyWorstMicroUsd(bad); } catch { threw++; } }
  is("a figure that is not a whole number is refused, never priced as zero", threw, 3);
}

done();
