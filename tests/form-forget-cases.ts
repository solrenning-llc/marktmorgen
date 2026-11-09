/**
 * The cases on which the erasure's Lua (lib/form-store.ts FORGET_FORM_PERSON) and the rule it says line for line
 * (lib/form-respondent.ts) must agree. Two runs read them: tests/form-forget-parity.test.ts holds the stand-in
 * (lib/redis-memory.ts) to the rule, and scripts/test_form_forget_redis.py holds the real Lua in Redis to the same
 * expectations, which tests/form-forget-redis-run.ts prints for it.
 *
 * What each response becomes is worked out here from personInResponse alone: kept as it is ("none"), written back
 * without the answers that are the address ("named"), or deleted ("sent", "unknown", or a record that does not read
 * and holds the address).
 */
import { personAddress, personInResponse } from "@/lib/form-respondent";

export type FormForgetCase = { name: string; email: string; forms: { ids: string[]; items: string[] }[] };
export type FormForgetExpected = { roles: string[]; after: string[]; deleted: number; rewritten: number };

const at = 1700000000;
const R = (answers: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ at, page: "/apply/now", answers, outcome: "", joined: false, ...extra });
const TESS = "tess@example.com";
const OLLY = "olly@example.com";
const one = (name: string, ids: string[], items: string[], email = TESS): FormForgetCase => ({ name, email, forms: [{ ids, items }] });

export const FORM_FORGET_CASES: FormForgetCase[] = [
  one("sent, folded", ["email1"], [R({ email1: "  TESS@Example.COM\t", n: "x" })]),
  one("named", ["email1"], [R({ email1: OLLY, ref: "Tess@Example.com ", note: "see http://a/b é 😀 \u0001 \\/ \\" })]),
  one("named twice and another sender", ["email1"], [R({ email1: OLLY, ref: TESS }), R({ email1: OLLY, ref: TESS }), R({ email1: "ana@example.com" })]),
  one("sent twice", ["email1"], [R({ email1: TESS }), R({ email1: TESS })]),
  one("unknown: no email question", [], [R({ s: TESS, t: "words" })]),
  one("unknown: email question left empty", ["email1"], [R({ email1: "", s: TESS })]),
  one("a broken email question is passed over", ["email1", "email2"], [R({ email1: "not-an-email", email2: OLLY, s: TESS }), R({ email1: "x", email2: TESS })]),
  one("a friend's address before the sender's: unknown to both", ["friend", "yours1"], [R({ friend: TESS, yours1: OLLY, name01: "Olly Grant" })]),
  one("a friend's address before the sender's, the sender deleted: whole, never their name left", ["friend", "yours1"], [R({ friend: TESS, yours1: OLLY, name01: "Olly Grant" })], OLLY),
  one("the sender's address, then a friend's: unknown to both", ["yours1", "friend"], [R({ yours1: OLLY, friend: TESS, name01: "Olly Grant" })], OLLY),
  one("the sender's address, then a friend's, the friend deleted: whole", ["yours1", "friend"], [R({ yours1: OLLY, friend: TESS, name01: "Olly Grant" })]),
  one("the same address in both email questions: sent", ["email1", "email2"], [R({ email1: TESS, email2: " Tess@Example.com", n: "x" })]),
  one("the same address in both, another named: named", ["email1", "email2"], [R({ email1: OLLY, email2: OLLY, ref: TESS })]),
  one("three email questions, the third differs: unknown", ["e1", "e2", "e3"], [R({ e1: TESS, e2: TESS, e3: OLLY, n: "x" })]),
  one("three email questions, the third differs, its address deleted: whole", ["e1", "e2", "e3"], [R({ e1: TESS, e2: TESS, e3: OLLY, n: "x" })], OLLY),
  one("a broken one between two that differ: unknown", ["e1", "e2", "e3"], [R({ e1: OLLY, e2: "nope", e3: TESS, n: "x" })]),
  one("orphan key", ["email1"], [R({ gone01: TESS, other: "o" })]),
  one("non-ASCII capital", ["email1"], [R({ email1: OLLY, s: "ÖLAF@x.com" }), R({ email1: "ölaf@x.com" })], "ölaf@x.com"),
  one("slash in address and arrays", ["email1"], [R({ email1: OLLY, s: "A/B@x.com", c: ["op1", "op2"], n: 7, o: {} }, { score: 3, scores: { abcdef: 1 } })], "a/b@x.com"),
  one("all answers named", ["email1"], [R({ email1: OLLY, s: TESS })]),
  one("unreadable with address", ["email1"], ['{"at":"x","answers":{"s":"TESS@example.com"}}', "not json tess@example.com", '{"at":1,"answers":null,"s":"tess@example.com"}', "not json at all"]),
  one("lengths in ASCII", ["e"], [
    R({ e: "a".repeat(64) + "@x.co", s: TESS }), R({ e: "a".repeat(65) + "@x.co", s: TESS }),
    R({ e: "u@" + "d".repeat(240) + ".co", s: TESS }), R({ e: "u@" + "d".repeat(256) + ".co", s: TESS }),
    R({ e: "u@" + "d".repeat(240) + ".c", s: TESS }), R({ e: "a@.co", s: TESS }), R({ e: "a@b..co", s: TESS }), R({ e: "a@b.c.de", s: TESS }),
    R({ e: "a b@x.co", s: TESS }), R({ e: "a\tb@x.co", s: TESS }), R({ e: "a@b@x.co", s: TESS }), R({ e: "x".repeat(200) + "@" + "y".repeat(50) + ".co", s: TESS }),
    R({ e: "x".repeat(60) + "@" + "y".repeat(190) + ".co", s: TESS }), R({ e: "x".repeat(60) + "@" + "y".repeat(189) + ".co", s: TESS }), R({ e: "x".repeat(60) + "@" + "y".repeat(191) + ".co", s: TESS }),
  ]),
  one("lengths as the form counts them: two-byte characters", ["e"], [
    R({ e: "é".repeat(40) + "@example.com", s: TESS }), R({ e: "é".repeat(64) + "@x.co", s: TESS }), R({ e: "é".repeat(65) + "@x.co", s: TESS }),
    R({ e: "é".repeat(30) + "@" + "y".repeat(189) + ".co", s: TESS }), R({ e: "é".repeat(60) + "@" + "ý".repeat(190) + ".co", s: TESS }), R({ e: "é".repeat(60) + "@" + "ý".repeat(191) + ".co", s: TESS }),
    R({ e: "a@b.é", s: TESS }), R({ e: "a@b.éé", s: TESS }),
  ]),
  one("lengths as the form counts them: three-byte characters", ["e"], [
    R({ e: "中".repeat(64) + "@x.co", s: TESS }), R({ e: "中".repeat(65) + "@x.co", s: TESS }), R({ e: "a@中.文字", s: TESS }), R({ e: "a@中.文", s: TESS }),
  ]),
  one("lengths as the form counts them: four-byte characters count two", ["e"], [
    R({ e: "😀".repeat(32) + "@x.co", s: TESS }), R({ e: "😀".repeat(33) + "@x.co", s: TESS }), R({ e: "a@b.😀", s: TESS }),
    R({ e: "😀".repeat(30) + "@" + "y".repeat(189) + ".co", s: TESS }), R({ e: "😀".repeat(30) + "@" + "y".repeat(190) + ".co", s: TESS }),
  ]),
  { name: "two forms in one call", email: TESS, forms: [
    { ids: ["email1"], items: [R({ email1: TESS }), R({ email1: OLLY, ref: TESS })] },
    { ids: ["friend", "yours1"], items: [R({ friend: TESS, yours1: OLLY }), R({ friend: "", yours1: OLLY, n: "x" })] },
  ] },
];

/** What the rule makes of one form's list for this person, response by response. */
export function expectedOf(email: string, form: { ids: string[]; items: string[] }): FormForgetExpected {
  const address = personAddress(email);
  const roles: string[] = [];
  const after: string[] = [];
  const dropped = new Set<string>();
  let rewritten = 0;
  for (const raw of form.items) {
    let value: { at?: unknown; answers?: Record<string, string> } | undefined;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    if (!(value && typeof value === "object" && typeof value.at === "number" && value.answers && typeof value.answers === "object")) {
      const drop = raw.replace(/[A-Z]+/g, (letters) => letters.toLowerCase()).includes(address);
      roles.push(drop ? "unreadable, deleted" : "unreadable, kept");
      if (drop) dropped.add(raw);
      else after.push(raw);
      continue;
    }
    const { role, named } = personInResponse(form.ids, value.answers, address);
    roles.push(role);
    if (role === "none") after.push(raw);
    else if (role === "named") {
      for (const id of named) delete value.answers[id];
      after.push(JSON.stringify(value));
      rewritten += 1;
    } else dropped.add(raw);
  }
  return { roles, after, deleted: dropped.size, rewritten };
}

/** Records compared by value, key order aside, as Redis's cjson writes a record back in an order of its own. */
export function sameRecord(a: string, b: string): boolean {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
  try {
    return JSON.stringify(sorted(JSON.parse(a))) === JSON.stringify(sorted(JSON.parse(b)));
  } catch {
    return a === b;
  }
}
