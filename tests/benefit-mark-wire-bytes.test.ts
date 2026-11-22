import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import type { Store } from "@/lib/store";
import { fromBase64, giveBenefit } from "@/lib/tier-benefits";
import { MARK_BY_MAX, markableBy } from "@/lib/tier-benefit-rules";
import { store as redis, redisPipelineBase64 } from "./redis-stub";
import { BENEFIT_MARK_VALUE_BYTES } from "./plan-cost-registry";

/**
 * BENEFIT_MARK_VALUE_BYTES is what one mark costs on the wire when readOwedMarks reads it back with HMGET
 * (lib/tier-benefits.ts), audit cd8d. Before, the address on a mark was whatever normaliseEmail kept, up to 320
 * characters, and the mark was read as text: a control character such as U+0001 (not whitespace, so trim() keeps it)
 * is kept as `\u0001` and crossed as `\\u0001`, 7 bytes, and the worst mark measured 2274 bytes against the 672
 * declared. Now:
 * - giveBenefit writes only an address markableBy accepts (what sign-in accepts, less controls, lone surrogates, quote,
 *   backslash, <, > and &), checked before anything is read or counted, so an accented address still marks
 *   (coordinator cd33);
 * - the marks are read in base64 (coordinator 6800, after Claude 6 UoHAG's MEDIUM: nothing dated says the database
 *   sends non-ASCII text unescaped), so a mark crosses as 4 bytes for every 3 kept, plus its quotes and comma, whatever
 *   the encoder does with text.
 * The seconds are counted at 11 digits.
 */
const at = 99_999_999_999;
let checks = 0;
function check(name: string, run: () => void | Promise<void>) {
  return Promise.resolve().then(run).then(
    () => { checks += 1; console.log(`PASS ${name}`); },
    (error) => { console.error(`FAIL ${name}`, error); process.exitCode = 1; },
  );
}
const kept = (by: string) => JSON.stringify({ at, by });
/** One mark as readOwedMarks reads it (HMGET, in base64): its value's bytes on the wire, with its quotes and a comma. */
async function wireBytes(key: string, by: string): Promise<number> {
  await redis.pipeline([["HSET", key, "f", kept(by)]]);
  const [reply] = await redisPipelineBase64([["HMGET", key, "f"]]);
  const value = (reply as unknown[])[0];
  assert.equal(fromBase64(value), kept(by), "the base64 reply decodes to what was kept");
  return Buffer.byteLength(JSON.stringify(value)) + 1;
}
/** An encoder that writes <, >, & and every non-ASCII UTF-16 unit of a text as \uXXXX (HTML-safe and ASCII-only). */
const escaping = (s: string) => s.replace(/[<>&\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** The same mark read as text under that encoder. */
const asText = (by: string) => Buffer.byteLength(escaping(JSON.stringify(kept(by)))) + 1;
/** The same mark read in base64 under that encoder: base64 is ASCII, so nothing in it is escaped. */
const asBase64 = (by: string) => Buffer.byteLength(escaping(JSON.stringify(Buffer.from(kept(by), "utf8").toString("base64")))) + 1;
/** An address of `ch` that fills MARK_BY_MAX UTF-16 units: `ch...@ch.chch...`. */
function fill(ch: string): string {
  const units = Math.floor((MARK_BY_MAX - 2) / ch.length);
  const head = Math.max(1, units - 2);
  return `${ch.repeat(head)}@${ch}.${ch.repeat(Math.max(1, units - head - 1))}`;
}

async function main() {
  await check("a mark's address is capped at the sign-in address's own length", () => {
    assert.equal(MARK_BY_MAX, MAX_EMAIL_LENGTH);
  });

  // Accepted: what sign-in accepts and is kept in at most 3 bytes of UTF-8 a UTF-16 unit.
  const accepted: [string, string][] = [["plain ASCII", "a"], ["accented letter", "\u00e9"], ["ideograph", "\u4e2d"], ["astral (emoji)", "\u{1f600}"]];
  for (const [name, ch] of accepted) {
    const by = fill(ch);
    await check(`an address of ${name} is markable`, () => {
      assert.ok(by.length <= MARK_BY_MAX);
      assert.equal(markableBy(normaliseEmail(by)), true, by);
    });
    await check(`a mark of ${name} read in base64 stays inside BENEFIT_MARK_VALUE_BYTES, under any encoder`, async () => {
      const bytes = await wireBytes(`nl:tben:given:test:${name}`, by);
      console.log(`MEASURE ${name}: ${bytes} bytes in base64 (${asBase64(by)} under an escaping encoder; as text there ${asText(by)}); declared ${BENEFIT_MARK_VALUE_BYTES}`);
      assert.ok(bytes <= BENEFIT_MARK_VALUE_BYTES, `${bytes} > ${BENEFIT_MARK_VALUE_BYTES}`);
      assert.equal(asBase64(by), bytes, "an escaping encoder leaves base64 as it is");
    });
  }
  await check("a real accented address marks", () => {
    assert.equal(markableBy(normaliseEmail("Jos\u00e9@Exemplo.com.br")), true);
  });
  await check("no markable character is kept in more than 3 bytes of UTF-8 a UTF-16 unit", () => {
    for (let code = 0x21; code <= 0xffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const ch = String.fromCharCode(code);
      if (!markableBy(`a${ch}a@b.co`)) continue;
      const bytes = Buffer.byteLength(JSON.stringify(ch)) - 2;
      assert.ok(bytes <= 3, `U+${code.toString(16)} is kept in ${bytes} bytes`);
    }
  });
  await check("the worst mark kept is the size the registry builds on, and its base64 the declared value", async () => {
    const worst = fill("\u4e2d");
    assert.equal(worst.length, MARK_BY_MAX);
    assert.equal(Buffer.byteLength(kept(worst)), 26 + 3 * (MARK_BY_MAX - 2) + 2);
    assert.equal(await wireBytes("nl:tben:given:test:worst", worst), BENEFIT_MARK_VALUE_BYTES);
  });
  await check("read as text under an escaping encoder, the worst mark would cost more than declared (why it is read in base64)", () => {
    assert.ok(asText(fill("\u4e2d")) > BENEFIT_MARK_VALUE_BYTES, `${asText(fill("\u4e2d"))}`);
  });
  await check("both readers of a person's marks ask for base64, never text", () => {
    const source = readFileSync("lib/tier-benefits.ts", "utf8");
    const readers = source.match(/redisPipeline\w*\(slice\.map\(\(p\) => \["(HGETALL|HMGET)", marksKey/g) ?? [];
    assert.equal(readers.length, 2, "two readers of a person's marks");
    for (const reader of readers) assert.ok(reader.startsWith("redisPipelineBase64("), reader);
  });
  // The person's copy (lib/person-copy.ts, benefitMarksOf) reads a person's marks too, now in base64: at most
  // MAX_BENEFITS_KEPT fields and values, about 4/3 of what is kept. No route hands the copy to anybody yet, so no
  // request pays for that read today; tests/plan-cost-registry.ts has no line for it (coordinator 87e4). The door
  // that first serves the copy brings that line with it: until then this check fails it.
  await check("no route serves the person's copy without a cost line for it", () => {
    const files = readdirSync("app", { recursive: true, encoding: "utf8" }).filter((f) => /\.(ts|tsx)$/.test(f));
    const doors = files.filter((f) => /@\/lib\/person-copy["']/.test(readFileSync(`app/${f}`, "utf8")));
    const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
    assert.ok(doors.length === 0 || /lib\/person-copy\.ts/.test(registry), `routes serve the copy without a cost line: ${doors.join(", ")}`);
  });
  await check("a reply that is not base64 text fails closed", () => {
    for (const bad of ["not base64!", "abc", 12, null, ["YQ=="]]) assert.equal(fromBase64(bad), null, String(bad));
    assert.equal(fromBase64(Buffer.from("{}").toString("base64")), "{}");
  });

  // Refused. A control or a lone surrogate is kept as \uXXXX, 6 bytes, and would cost more than declared even in
  // base64; a quote, a backslash, <, > and & stay refused as decided before (coordinator cd33, Claude 2 upbeat's LOW).
  const refused: [string, string, boolean][] = [
    ["control U+0001", "\u0001", true], ["C1 control U+0085", "\u0085", false], ["lone surrogate", "\ud800", true],
    ["quote", '"', false], ["backslash", "\\", false], ["<", "<", false], [">", ">", false], ["&", "&", false],
    ["line separator U+2028", "\u2028", false],
  ];
  for (const [name, ch, dear] of refused) {
    await check(`an address with a ${name} is not markable`, () => {
      assert.equal(markableBy(`a${ch}a@b.co`), false);
      assert.equal(markableBy(`${ch.repeat(240)}@b.co`), false);
    });
    if (dear) {
      await check(`a mark of ${name} would cost more than declared, even in base64 (why it is refused)`, () => {
        const bytes = asBase64(`${ch.repeat(MARK_BY_MAX - 5)}@b.co`);
        console.log(`MEASURE ${name}: ${bytes} bytes in base64`);
        assert.ok(bytes > BENEFIT_MARK_VALUE_BYTES);
      });
    }
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
