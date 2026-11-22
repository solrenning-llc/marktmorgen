import assert from "node:assert/strict";
import { MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import type { Store } from "@/lib/store";
import { giveBenefit } from "@/lib/tier-benefits";
import { MARK_BY_MAX, markableBy } from "@/lib/tier-benefit-rules";
import { store as redis } from "./redis-stub";
import { BENEFIT_MARK_VALUE_BYTES } from "./plan-cost-registry";

/**
 * BENEFIT_MARK_VALUE_BYTES is what one mark costs on the wire when readOwedMarks reads it back with HMGET
 * (lib/tier-benefits.ts): the stored `{"at":<seconds>,"by":"<address>"}`, sent back by the database as a JSON string
 * inside its JSON reply, so every character is escaped twice (audit cd8d). Before this, the address was whatever
 * normaliseEmail kept, up to 320 characters: a control character such as U+0001 (not whitespace, so trim() keeps it)
 * is stored as `\u0001` and comes back as `\\u0001`, 7 bytes, and the worst mark measured 2274 bytes against the 672
 * declared. Now giveBenefit writes only an address that markableBy accepts, checked before anything is read or
 * counted: what sign-in accepts, less what costs more on the wire (controls, lone surrogates, quote, backslash, and
 * <, > and & that an HTML-safe encoder writes as <), so an accented address still marks (coordinator cd33). The
 * dearest character left is 3 bytes for one UTF-16 unit. The seconds are counted at 11 digits.
 */
const at = 99_999_999_999;
let checks = 0;
function check(name: string, run: () => void | Promise<void>) {
  return Promise.resolve().then(run).then(
    () => { checks += 1; console.log(`PASS ${name}`); },
    (error) => { console.error(`FAIL ${name}`, error); process.exitCode = 1; },
  );
}
async function wireBytes(key: string, by: string): Promise<number> {
  await redis.pipeline([["HSET", key, "f", JSON.stringify({ at, by })]]);
  const [reply] = await redis.pipeline([["HMGET", key, "f"]]);
  return Buffer.byteLength(JSON.stringify((reply as unknown[])[0]));
}
/** An HTML-safe JSON encoder (Go's encoding/json by default) also writes <, >, &, U+2028 and U+2029 as \uXXXX. */
const htmlSafe = (s: string) => s.replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const wireOf = (by: string) => Buffer.byteLength(htmlSafe(JSON.stringify(JSON.stringify({ at, by }))));
/** An address of `ch` that fills MARK_BY_MAX UTF-16 units: `ch…@ch.chch…`. */
function fill(ch: string): string {
  const units = Math.floor((MARK_BY_MAX - 2) / ch.length);
  const head = Math.max(1, units - 2);
  return `${ch.repeat(head)}@${ch}.${ch.repeat(Math.max(1, units - head - 1))}`;
}

async function main() {
  await check("a mark's address is capped at the sign-in address's own length", () => {
    assert.equal(MARK_BY_MAX, MAX_EMAIL_LENGTH);
  });

  // Accepted: what sign-in accepts and costs at most 3 bytes a UTF-16 unit on the wire.
  const accepted: [string, string][] = [["plain ASCII", "a"], ["accented letter", "é"], ["ideograph", "\u4e2d"], ["astral (emoji)", "\u{1f600}"]];
  for (const [name, ch] of accepted) {
    const by = fill(ch);
    await check(`an address of ${name} is markable`, () => {
      assert.ok(by.length <= MARK_BY_MAX);
      assert.equal(markableBy(normaliseEmail(by)), true, by);
    });
    await check(`a mark of ${name} stays inside BENEFIT_MARK_VALUE_BYTES, under JSON.stringify and an HTML-safe encoder`, async () => {
      const bytes = await wireBytes(`nl:tben:given:test:${name}`, by);
      console.log(`MEASURE ${name}: ${bytes} bytes (HTML-safe ${wireOf(by)}); declared ${BENEFIT_MARK_VALUE_BYTES}`);
      assert.ok(bytes <= BENEFIT_MARK_VALUE_BYTES, `${bytes} > ${BENEFIT_MARK_VALUE_BYTES}`);
      assert.ok(wireOf(by) <= BENEFIT_MARK_VALUE_BYTES, `${wireOf(by)} > ${BENEFIT_MARK_VALUE_BYTES}`);
    });
  }
  await check("a real accented address marks", () => {
    assert.equal(markableBy(normaliseEmail("José@Exemplo.com.br")), true);
  });
  await check("the declared value is the worst mark that can be written, no higher than needed", async () => {
    const worst = fill("\u4e2d");
    assert.equal(worst.length, MARK_BY_MAX);
    assert.equal(await wireBytes("nl:tben:given:test:worst", worst), BENEFIT_MARK_VALUE_BYTES);
  });
  await check("no markable character costs more than 3 bytes a UTF-16 unit, even under an HTML-safe encoder", () => {
    const empty = Buffer.byteLength(htmlSafe(JSON.stringify(JSON.stringify(""))));
    for (let code = 0x21; code <= 0xffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const ch = String.fromCharCode(code);
      if (!markableBy(`a${ch}a@b.co`)) continue;
      const cost = Buffer.byteLength(htmlSafe(JSON.stringify(JSON.stringify(ch)))) - empty;
      assert.ok(cost <= 3, `U+${code.toString(16)} costs ${cost} bytes`);
    }
  });

  // Refused: each would cost more than declared, under JSON.stringify or an HTML-safe encoder.
  const refused: [string, string][] = [
    ["control U+0001", "\u0001"], ["C1 control U+0085", "\u0085"], ["lone surrogate", "\ud800"], ["quote", '"'], ["backslash", "\\"],
    ["<", "<"], [">", ">"], ["&", "&"], ["line separator U+2028", "\u2028"],
  ];
  for (const [name, ch] of refused) {
    await check(`an address with a ${name} is not markable`, () => {
      assert.equal(markableBy(`a${ch}a@b.co`), false);
      assert.equal(markableBy(`${ch.repeat(240)}@b.co`), false);
    });
    // A C1 control is refused as a control (an ASCII-only encoder writes it as \u0085), not for its size here.
    if (name.startsWith("C1")) continue;
    await check(`a mark of ${name} would cost more than declared (why it is refused)`, () => {
      const bytes = wireOf(`${ch.repeat(MARK_BY_MAX - 5)}@b.co`);
      console.log(`MEASURE ${name}: ${bytes} bytes`);
      assert.ok(bytes > BENEFIT_MARK_VALUE_BYTES);
    });
  }
  await check("an address over MARK_BY_MAX units is not markable", () => {
    assert.equal(markableBy(`${"a".repeat(MARK_BY_MAX - 4)}@b.co`), false);
  });
  await check("an address without the shape of one is not markable", () => {
    for (const by of ["", "plain", "@b.co", "a@b", "a@@b.co", "a b@c.co"]) assert.equal(markableBy(by), false, by);
  });

  await check("giveBenefit refuses such an address before reading or counting anything", async () => {
    const store = { statsId: "f".repeat(32) } as Store;
    const pipeline = redis.pipeline.bind(redis);
    let commands = 0;
    let charged = 0;
    redis.pipeline = async (batch) => { commands += batch.length; return pipeline(batch); };
    try {
      const done = await giveBenefit(store, "\u0001x@b.co", "b0123456789ab", [{ sub: "sub_1", period: "once" }], Date.now(), async () => { charged += 1; return { ok: true as const }; });
      assert.deepEqual(done, { ok: false, reason: "who" });
      assert.equal(commands, 0, "no database command");
      assert.equal(charged, 0, "no studio request counted");
    } finally {
      redis.pipeline = pipeline;
    }
  });

  console.log(process.exitCode ? `${checks} checks passed; some failed.` : `${checks} checks, all passing.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
