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
 * declared. Now giveBenefit writes only an address that markableBy accepts (printable ASCII, no quote or backslash, at
 * most MARK_BY_MAX characters), checked before anything is read or counted. The seconds are counted at 11 digits.
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

async function main() {
  await check("a mark's address is capped at the sign-in address's own length", () => {
    assert.equal(MARK_BY_MAX, MAX_EMAIL_LENGTH);
  });

  // The worst address a mark can now hold: MARK_BY_MAX printable characters, in the shape of an address.
  const worst = `${"a".repeat(MARK_BY_MAX - 5)}@b.co`;
  await check("the worst address a mark can hold is accepted", () => {
    assert.equal(worst.length, MARK_BY_MAX);
    assert.equal(markableBy(normaliseEmail(worst)), true);
  });
  await check("the worst mark that can be written stays inside BENEFIT_MARK_VALUE_BYTES on the wire", async () => {
    const bytes = await wireBytes("nl:tben:given:test:worst", worst);
    console.log(`MEASURE worst markable mark: ${bytes} bytes; declared ${BENEFIT_MARK_VALUE_BYTES}`);
    assert.ok(bytes <= BENEFIT_MARK_VALUE_BYTES, `${bytes} > ${BENEFIT_MARK_VALUE_BYTES}`);
    assert.equal(bytes, BENEFIT_MARK_VALUE_BYTES, "the declared value is the measured worst, no higher than needed");
  });

  // What the old rule let through, each 320 characters: each is refused now, and each would cost more than declared.
  const refused: [string, string][] = [["control U+0001", "\u0001"], ["lone surrogate", "\ud800"], ["quote", '"'], ["backslash", "\\"], ["ideograph", "中"], ["space inside", "a b"]];
  for (const [name, ch] of refused) {
    const by = `${ch.repeat(310)}@b.co`;
    await check(`an address with a ${name} is not markable`, () => {
      assert.equal(markableBy(normaliseEmail(by)), false);
    });
    if (name !== "space inside") {
      await check(`a mark with a ${name} address would cost more than declared (why it is refused)`, async () => {
        const bytes = await wireBytes(`nl:tben:given:test:${name}`, normaliseEmail(by).slice(0, 320));
        console.log(`MEASURE ${name}: ${bytes} bytes`);
        assert.ok(bytes > BENEFIT_MARK_VALUE_BYTES);
      });
    }
  }
  await check("an address over MARK_BY_MAX characters is not markable", () => {
    assert.equal(markableBy(`${"a".repeat(MARK_BY_MAX - 4)}@b.co`), false);
  });
  await check("an address without the shape of one is not markable", () => {
    for (const by of ["", "plain", "@b.co", "a@b", "a@@b.co"]) assert.equal(markableBy(by), false, by);
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
