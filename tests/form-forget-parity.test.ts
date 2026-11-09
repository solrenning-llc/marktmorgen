/**
 * The stand-in for Redis (lib/redis-memory.ts) runs the erasure's script (lib/form-store.ts FORGET_FORM_PERSON) by the
 * rule of lib/form-respondent.ts, on every case of tests/form-forget-cases.ts; scripts/test_form_forget_redis.py holds
 * the real Lua in Redis to the same expectations. Together they say the three agree.
 */
import { FORGET_FORM_PERSON } from "@/lib/form-store";
import { personAddress } from "@/lib/form-respondent";
import { MemoryRedis } from "@/lib/redis-memory";
import { FORM_FORGET_CASES, expectedOf, sameRecord } from "./form-forget-cases";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("The stand-in deletes, writes back and keeps what the rule says, case by case");
  for (const c of FORM_FORGET_CASES) {
    const redis = new MemoryRedis();
    const keys = c.forms.map((_, k) => `form-forget-case:${k}`);
    await redis.pipeline(c.forms.map((form, k) => ["RPUSH", keys[k], ...form.items]));
    const [reply] = await redis.pipeline([["EVAL", FORGET_FORM_PERSON, keys.length, ...keys, personAddress(c.email), ...c.forms.map((form) => JSON.stringify(form.ids))]]);
    const lists = (await redis.pipeline(keys.map((key) => ["LRANGE", key, 0, -1]))) as string[][];
    const entries = Array.isArray(reply) ? reply : [];
    c.forms.forEach((form, k) => {
      const want = expectedOf(c.email, form);
      const after = lists[k] ?? [];
      const mine = [];
      for (let i = 0; i < entries.length; i += 4) if (entries[i] === k + 1) mine.push(entries.slice(i, i + 4));
      const got = {
        after: after.length === want.after.length && after.every((raw, i) => sameRecord(raw, want.after[i])),
        deleted: mine.filter((entry) => entry[3] === "").length,
        rewritten: mine.filter((entry) => entry[3] !== "").length,
      };
      is(`${c.name}${c.forms.length > 1 ? `, form ${k + 1}` : ""} (${want.roles.join(", ")})`, got, { after: true, deleted: want.deleted, rewritten: want.rewritten });
    });
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
