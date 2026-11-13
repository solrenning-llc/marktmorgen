/**
 * Property-based fuzzing of the input readers (Claude 7, 13 November 2026).
 *
 * A seeded generator (no dependency), a fixed number of cases per property and
 * a time box on every regular-expression input, so the file is deterministic
 * and fast enough for CI. Each property is one of:
 *
 *   - a reader never throws anything but its own documented refusal;
 *   - an ill-shaped value is never read as a valid one (unknown or garbled
 *     input is a refusal, never a zero, an empty list or a success);
 *   - what a writer writes, its reader reads back unchanged;
 *   - no input of bounded size takes a regular expression past its time box.
 *
 * A failure prints the smallest input found by shrinking it, so the case can
 * be pinned as a plain test of its own.
 */
import { createHmac } from "node:crypto";
import { done, is, part } from "./check";
import { CURRENCIES, moneyField, readMoney, type Currency } from "@/lib/money";
import { csvLine, parseCsv, readConsent, detectSeparator, guessColumn } from "@/lib/csv";
import { countOf, listSlots, replyList, repliesFor, scanPage, stringList } from "@/lib/redis-reply";
import { UnknownReply, exactReplies, plainList, replyCount } from "@/lib/redis-exact";
import { idInSegment, productSegment, slugOf } from "@/lib/product-slug";
import { HANDLE_PATTERN } from "@/lib/store-handle-pattern";
import { adjacentCustomRange, presetCustomRange, CUSTOM_RANGE_PRESETS } from "@/lib/custom-range-dates";
import { readDay } from "@/lib/payment-request-rules";
import { keptDay } from "@/lib/preorder-rules";
import { readBatch } from "@/lib/imports";
import { inboundSigned, parseSender } from "@/lib/inbound-mail";
import { zoomSigned } from "@/lib/meet-providers";
import { believed } from "@/lib/stream";
import { fieldsAsked } from "@/lib/api-fields";
import { signedUser } from "@/lib/meta-ads";
import { seal, unseal } from "@/lib/secret-box";

// ---- the generator ----------------------------------------------------------

/** mulberry32: a small, well-mixed 32-bit generator, the same sequence on every run for a seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T,>(list: readonly T[]): T => list[int(0, list.length - 1)];
  const text = (alphabet: readonly string[], most: number) => {
    let out = "";
    for (let n = int(0, most); n > 0; n -= 1) out += pick(alphabet);
    return out;
  };
  return { next, int, pick, text };
}

const ITERATIONS = 2000;
/** A regular expression over an input of at most a few tens of kilobytes must answer well inside this. */
const REGEX_BOX_MS = 250;

/** Shrinks a failing string by deleting characters while it still fails, so the reported case is small. */
function shrink(input: string, fails: (s: string) => boolean): string {
  let best = input;
  for (let size = Math.max(1, best.length >> 1); size >= 1; size = size >> 1) {
    for (let at = 0; at + size <= best.length; ) {
      const smaller = best.slice(0, at) + best.slice(at + size);
      if (fails(smaller)) best = smaller;
      else at += 1;
    }
  }
  return best;
}

/** Runs a string property over generated inputs; checks it holds, printing the shrunk counterexample if not. */
function forAllStrings(what: string, seed: number, gen: (r: ReturnType<typeof rng>) => string, holds: (s: string) => boolean) {
  const r = rng(seed);
  const safe = (s: string) => {
    try {
      return holds(s);
    } catch {
      return false;
    }
  };
  let counter: string | null = null;
  for (let i = 0; i < ITERATIONS && counter === null; i += 1) {
    const input = gen(r);
    if (!safe(input)) counter = shrink(input, (s) => !safe(s));
  }
  is(`${what} (${ITERATIONS} cases, seed ${seed})`, counter === null ? "holds" : { counterexample: counter }, "holds");
}

/** Whether the call answered inside the time box (a crude but sufficient ReDoS guard on bounded inputs). */
function timed(call: () => unknown): number {
  const start = performance.now();
  call();
  return performance.now() - start;
}

const DIGITS = "0123456789".split("");
const NOISE = [" ", ".", ",", "-", "+", "e", "E", "$", "_", "٠", "１", "\n", "\t", "x", "'", " ", "0x"];

// ---- money ------------------------------------------------------------------

part("readMoney: only a plain amount reads, and every amount written reads back");
{
  const codes = CURRENCIES.map((c) => c.code as Currency);
  for (const [index, currency] of codes.entries()) {
    const decimals = CURRENCIES[index].decimals;
    const canonical = decimals === 0 ? /^\d{1,9}$/ : /^\d{1,7}(\.\d{1,2})?$/;
    forAllStrings(`readMoney(${currency}) accepts only a canonical amount, a safe whole number from zero`, 1000 + index, (r) => r.text(r.next() < 0.5 ? DIGITS : [...DIGITS, ...NOISE], 12), (s) => {
      const got = readMoney(s, currency);
      if (got === null) return true;
      return Number.isSafeInteger(got) && got >= 0 && canonical.test(s.trim());
    });
    forAllStrings(`readMoney(${currency}) reads back what moneyField writes`, 2000 + index, (r) => String(r.int(0, decimals === 0 ? 999_999_999 : 999_999_999)), (s) => {
      const amount = Number(s);
      return readMoney(moneyField(amount, currency), currency) === amount;
    });
  }
}

// ---- spreadsheets -----------------------------------------------------------

part("parseCsv: what csvLine writes reads back cell for cell, and nothing hangs");
{
  const CELL = ["a", "b", "Z", "é", "日", " ", ",", ";", "\t", '"', "\n", "\r\n", "\r", "=", "+", "-", "@", "'", "1"];
  const r = rng(3000);
  let counter: unknown = null;
  for (let i = 0; i < ITERATIONS && counter === null; i += 1) {
    const rows: string[][] = [];
    const width = r.int(1, 4);
    for (let n = r.int(1, 5); n > 0; n -= 1) {
      // The first cell starts with a letter, so no row is blank (blank rows are skipped by design).
      rows.push(Array.from({ length: width }, (_, c) => (c === 0 ? "k" : "") + r.text(CELL, 6)));
    }
    const header = Array.from({ length: width }, (_, c) => `h${c}`);
    const text = [csvLine(header), ...rows.map(csvLine)].join(r.pick(["\n", "\r\n"]));
    const want = rows.map((row) => row.map((cell) => (/^[\s]*[=+\-@]/.test(cell) || /^[\t\r]/.test(cell) ? `'${cell}` : cell)));
    const got = parseCsv(r.next() < 0.3 ? `﻿${text}` : text);
    if (JSON.stringify(got.rows) !== JSON.stringify(want) || JSON.stringify(got.header) !== JSON.stringify(header)) counter = { text, got: got.rows, want };
  }
  is(`csvLine → parseCsv round-trips every cell (${ITERATIONS} cases, seed 3000)`, counter ?? "holds", "holds");

  forAllStrings("parseCsv never throws, keeps every row inside maxRows and says when it cut", 3001, (r) => r.text(CELL, 60), (s) => {
    const all = parseCsv(s);
    const most = all.rows.length > 0 ? all.rows.length - 1 : 0;
    const cut = parseCsv(s, most);
    return cut.rows.length <= most && cut.truncated === all.rows.length > most && cut.lines.length === cut.rows.length;
  });
  forAllStrings("readConsent answers yes, no or unknown, and never throws", 3002, (r) => r.text(["y", "e", "s", "n", "o", " ", "_", "-", "1", "0", "✓", "x"], 6), (s) => ["yes", "no", "unknown"].includes(readConsent(s)));

  const long = [`${'"'.repeat(20_000)}`, `${",".repeat(20_000)};`, `${'a"'.repeat(10_000)}`, `${"\r".repeat(20_000)}`];
  for (const input of long) {
    const ms = timed(() => {
      parseCsv(input);
      detectSeparator(input);
      guessColumn(input.slice(0, 2000).split(","), ["email", "e-mail address"]);
    });
    is(`parseCsv on ${JSON.stringify(input.slice(0, 4))}×${input.length} stays inside the time box`, ms < REGEX_BOX_MS, true);
  }
}

// ---- Redis replies ----------------------------------------------------------

part("Redis reply readers: an ill-shaped reply is refused, and nothing of it is run");
{
  let ran = 0;
  const trap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, key, receiver) {
        ran += 1;
        return Reflect.get(t, key, receiver);
      },
      getOwnPropertyDescriptor(t, key) {
        ran += 1;
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
      has(t, key) {
        ran += 1;
        return Reflect.has(t, key);
      },
      ownKeys(t) {
        ran += 1;
        return Reflect.ownKeys(t);
      },
    });
  const withGetter = () => {
    const list: unknown[] = ["a", "b"];
    Object.defineProperty(list, 1, { get: () => ((ran += 1), "b"), enumerable: true });
    return list;
  };
  const inherited = () => {
    const list: unknown[] = ["a"];
    list.length = 2;
    Object.setPrototypeOf(list, Object.assign(Object.create(Array.prototype), { 1: "b" }));
    return list;
  };
  const r = rng(4000);
  const scalars: unknown[] = [0, 1, 7, -1, -0, 1.5, NaN, Infinity, -Infinity, 1e300, 2 ** 53, Number.MAX_SAFE_INTEGER, "0", "1", "", "abc", null, undefined, true, false, {}, BigInt(10)];
  const value = (depth: number): unknown => {
    const kind = r.int(0, depth > 2 ? 0 : 9);
    if (kind <= 2) return r.pick(scalars);
    const size = r.int(0, 3);
    const items = Array.from({ length: size }, () => value(depth + 1));
    if (kind === 3) return items;
    if (kind === 4) return [r.pick(["0", "17", "", " 0", "abc", 0]), items];
    if (kind === 5) return trap(items);
    if (kind === 6) return withGetter();
    if (kind === 7) return inherited();
    if (kind === 8) return Object.assign({ length: size }, items);
    // A hole.
    const holey = [...items];
    holey.length = size + 1;
    return holey;
  };
  const isRefusal = (error: unknown) => error instanceof UnknownReply;
  const isPlain = (list: unknown) => Array.isArray(list) && Object.getPrototypeOf(list) === Array.prototype;
  let counter: unknown = null;
  for (let i = 0; i < ITERATIONS * 2 && counter === null; i += 1) {
    const reply = value(0);
    ran = 0;
    try {
      const strings = stringList(reply);
      const any = replyList(reply);
      const slots = listSlots(reply);
      const pair = repliesFor(reply, 2);
      const page = scanPage([reply]);
      const count = countOf(reply);
      const plain = plainList(reply);
      if (strings && (!isPlain(strings) || strings === reply || strings.some((m) => typeof m !== "string"))) counter = { reader: "stringList", reply };
      for (const [name, got] of [["replyList", any], ["listSlots", slots], ["repliesFor", pair], ["plainList", plain]] as const) {
        if (got && (!isPlain(got) || got === reply)) counter = { reader: name, reply };
      }
      if (pair && pair.length !== 2) counter = { reader: "repliesFor", reply };
      if (page && (!/^[0-9]+$/.test(page.next) || page.items.some((m) => typeof m !== "string"))) counter = { reader: "scanPage", reply };
      if (count !== null && !(Number.isSafeInteger(count) && count >= 0)) counter = { reader: "countOf", reply };
      try {
        const n = replyCount(reply, "fuzz");
        if (!(Number.isSafeInteger(n) && n >= 0)) counter = { reader: "replyCount", reply };
      } catch (error) {
        if (!isRefusal(error)) throw error;
      }
      try {
        const list = exactReplies(reply, 1, "fuzz");
        if (!isPlain(list) || list.length !== 1) counter = { reader: "exactReplies", reply };
      } catch (error) {
        if (!isRefusal(error)) throw error;
      }
      if (ran > 0) counter = { reader: "a reader ran the reply's own code", reply };
    } catch (error) {
      counter = { threw: String(error), reply };
    }
  }
  is(`every reader refuses an ill-shaped reply and runs none of it (${ITERATIONS * 2} cases, seed 4000)`, counter === null ? "holds" : counter, "holds");
}

// ---- addresses --------------------------------------------------------------

part("Product addresses and handles");
{
  const WORDS = ["a", "Z", "9", " ", "-", "&", "é", "ß", "Æ", "œ", "ø", "日", "🙂", "/", "%", "_", ".", "́", "ﬁ", "Ⅻ"];
  const SLUG = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
  forAllStrings("slugOf writes only address words, at most 60, and is idempotent", 5000, (r) => r.text(WORDS, 120), (s) => {
    const slug = slugOf(s);
    return SLUG.test(slug) && slug.length <= 60 && slugOf(slug) === slug;
  });
  forAllStrings("idInSegment finds the id productSegment wrote, encoded or not, and never throws on garbage", 5001, (r) => r.text(WORDS, 40), (title) => {
    const id = "5e3f350b52";
    const segment = productSegment({ id, title });
    const isProduct = (x: string) => x === id;
    idInSegment(`%${title}%E0%A4%A`, isProduct);
    return idInSegment(segment, isProduct) === id && idInSegment(encodeURIComponent(segment), isProduct) === id;
  });
  forAllStrings("HANDLE_PATTERN answers inside the time box", 5002, (r) => r.text(["a", ".", "_", "-", "0", "A", " "], 4000), (s) => timed(() => HANDLE_PATTERN.test(s)) < REGEX_BOX_MS);
}

// ---- days -------------------------------------------------------------------

part("Days: a day read or written is always a real YYYY-MM-DD");
{
  const isDay = (value: unknown) => typeof value === "string" && readDay(value) === value;
  const dayText = (r: ReturnType<typeof rng>) => {
    const year = r.pick(["0000", "0001", "0002", "1969", "1970", "2000", "2024", "2026", "9999", String(r.int(0, 9999)).padStart(4, "0")]);
    const month = r.pick(["00", "01", "02", "12", "13", String(r.int(1, 12)).padStart(2, "0")]);
    const date = r.pick(["00", "01", "28", "29", "30", "31", "32", String(r.int(1, 31)).padStart(2, "0")]);
    const raw = `${year}-${month}-${date}`;
    return r.next() < 0.1 ? raw + r.pick([" ", "T00:00:00Z", "\n", "x"]) : raw;
  };
  forAllStrings("readDay and keptDay accept only a real day, and agree", 6000, dayText, (s) => {
    const a = readDay(s);
    const b = keptDay(s);
    return a === b && (a === null || (a === s && isDay(a)));
  });
  forAllStrings("presetCustomRange answers null or a real, ordered period", 6001, dayText, (today) => {
    for (const { value } of CUSTOM_RANGE_PRESETS) {
      const period = presetCustomRange(value, today);
      if (period && !(isDay(period.from) && isDay(period.to) && period.from <= period.to)) return false;
    }
    return true;
  });
  // Mostly valid periods (an anchor near the year 0000, an ordinary one or the year 9999), some garbled.
  const nearby = (r: ReturnType<typeof rng>) => {
    if (r.next() < 0.2) return [dayText(r), dayText(r), dayText(r)].join("|");
    const anchor = Date.parse(`${r.pick(["0000-01-01", "0000-06-30", "0001-01-01", "2026-11-13", "9999-06-01"])}T00:00:00Z`) + r.int(0, 60) * 86_400_000;
    const at = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const to = anchor + r.int(0, 30) * 86_400_000;
    return [at(anchor), at(to), at(to + r.int(0, 400) * 86_400_000)].join("|");
  };
  forAllStrings("adjacentCustomRange answers null or a real, ordered period of the same length", 6002, nearby, (joined) => {
    const [from, to, today] = joined.split("|");
    for (const direction of [-1, 1] as const) {
      const period = adjacentCustomRange({ from: from ?? "", to: to ?? "" }, direction, today ?? "");
      if (!period) continue;
      const length = (a: string, b: string) => Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
      if (!(isDay(period.from) && isDay(period.to) && period.from <= period.to && length(period.from, period.to) === length(from, to))) return false;
    }
    return true;
  });
}

// ---- import batches ---------------------------------------------------------

part("Import batches: a row number is a whole number the page wrote, nothing else");
{
  const r = rng(7000);
  const lines: unknown[] = [1, 2, 10_000_000, 10_000_001, 0, -1, 1.5, NaN, "1", "2", "10000000", "0", "01", " 3", "3 ", "0x10", "1e1", "+4", "", true, false, null, [5], {}, "٣"];
  let counter: unknown = null;
  for (let i = 0; i < ITERATIONS && counter === null; i += 1) {
    const line = r.pick(lines);
    const got = readBatch("members", [[line, "person@example.test", "membership", "2026-12-05", ""]]);
    if (!got) continue;
    const canonical = (typeof line === "number" && Number.isSafeInteger(line)) || (typeof line === "string" && /^[1-9][0-9]*$/.test(line));
    if (!canonical || got[0][0] !== String(line)) counter = { line };
  }
  is(`readBatch accepts a row number only as a whole number or its plain decimal text (${ITERATIONS} cases, seed 7000)`, counter ?? "holds", "holds");
}

// ---- signed notices ---------------------------------------------------------

part("Signed notices: only the exact signature is believed");
{
  const secretBytes = Buffer.alloc(24, 7);
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${secretBytes.toString("base64")}`;
  process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "fuzz-zoom-secret";
  const now = 1_800_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const body = '{"type":"email.received"}';
  const id = "msg_fuzz";
  const good = createHmac("sha256", secretBytes).update(`${id}.${ts}.${body}`).digest("base64");
  is("the exact Resend signature is believed", inboundSigned(body, id, ts, `v1,${good}`, now), true);
  const MUTATE = ["!", "$", "*", ".", "-", "_", "=", " ", "é", "~", "#"];
  forAllStrings("a Resend signature that is not exactly the canonical base64 is refused", 8000, (r) => {
    const at = r.int(0, good.length);
    return good.slice(0, at) + r.pick(MUTATE.filter((c) => c !== " ")) + good.slice(at);
  }, (mutated) => mutated === good || !inboundSigned(body, id, ts, `v1,${mutated}`, now));
  forAllStrings("inboundSigned never throws on garbage headers", 8001, (r) => r.text(["v1", ",", " ", "a", "=", "/", "+", "0", "\n"], 40), (s) => typeof inboundSigned(body, s.slice(0, 10) || null, s || null, s, now) === "boolean");

  const zoomGood = `v0=${createHmac("sha256", "fuzz-zoom-secret").update(`v0:${ts}:${body}`).digest("hex")}`;
  is("the exact Zoom signature is believed", zoomSigned(body, ts, zoomGood, now), true);
  forAllStrings("a Zoom signature that is not exactly the expected one is refused", 8002, (r) => {
    const at = r.int(0, zoomGood.length);
    return zoomGood.slice(0, at) + r.pick(["A", "0", " ", "=", "f"]) + zoomGood.slice(at + r.int(0, 1));
  }, (s) => s === zoomGood || !zoomSigned(body, ts, s, now));

  const streamGood = createHmac("sha256", "read-key").update(body, "utf8").digest("hex");
  forAllStrings("a stream signature that is not exactly the expected one is refused", 8003, (r) => {
    const at = r.int(0, streamGood.length);
    return streamGood.slice(0, at) + r.pick(["A", "0", " ", "g", "F"]) + streamGood.slice(at + 1);
  }, (s) => s === streamGood || !believed(body, { version: "v1", algorithm: "hmac-sha256", signature: s }, "read-key"));

  const senders = ['"', " ", "<", ">", "a", "@", "\t", "x.y"];
  forAllStrings("parseSender answers inside the time box on a long header", 8004, (r) => r.text(senders, 4000), (s) => timed(() => parseSender(s)) < REGEX_BOX_MS);
}

part("Base64url tokens: only the exact text is believed");
{
  process.env.META_APP_SECRET = "fuzz-meta-secret";
  const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "42" })).toString("base64url");
  const metaGood = createHmac("sha256", "fuzz-meta-secret").update(payload).digest("base64url");
  const NOISE64 = ["!", "=", "+", "/", " ", ".", "*", "\u00e9"];
  forAllStrings("a Meta signed_request signature that is not exactly the expected one is refused", 8100, (r) => {
    const at = r.int(0, metaGood.length);
    return metaGood.slice(0, at) + r.pick(NOISE64.filter((c) => c !== ".")) + metaGood.slice(at);
  }, (s) => s === metaGood || signedUser(`${s}.${payload}`) === null);
  const sealed = seal("fuzz-value", "fuzz-context");
  forAllStrings("a sealed value whose text was altered does not open", 8101, (r) => {
    const at = r.int(sealed.indexOf(".", sealed.indexOf(".") + 1) + 1, sealed.length);
    return sealed.slice(0, at) + r.pick(NOISE64) + sealed.slice(at);
  }, (s) => s === sealed || !unseal(s, "fuzz-context").ok);
}

// ---- public API ---------------------------------------------------------------

part("Public API: a fields list is refused unless every name is a field name");
{
  const NAME = /^[a-z][a-z0-9_]{0,39}$/;
  forAllStrings("fieldsAsked accepts only field names and never throws", 9000, (r) => r.text(["a", "z", "_", "0", ",", " ", "A", "%2C", "%00", "é", "-"], 50), (s) => {
    const got = fieldsAsked(`https://marktmorgen.test/api/v1/products?fields=${s}`);
    return !got.ok || got.fields === null || got.fields.every((n) => NAME.test(n));
  });
}

done();
