/**
 * 36 [F5], unit 1: the signed code on an in-person ticket and its one-time
 * check-in (lib/ticket-code.ts). No checkout and no sale here. The code is an
 * HMAC under a key derived from this deployment's own secret
 * (lib/secret-box.ts, deriveKey), carries no personal data, and is refused
 * when forged, made under another key, malformed or expired. Check-in takes a
 * one-time mark (lib/claim-mark.ts): only a mark that is ours admits; a code
 * used before is refused, and an answer that cannot be read refuses entry
 * (rule 24), never lets someone in.
 */
import { createHmac } from "node:crypto";
import {
  CHECK_IN_KEEP_SECONDS,
  CHECK_IN_REFUSALS,
  MAX_TICKET_DAYS,
  TICKET_CODE,
  checkIn,
  checkInKey,
  makeTicketCode,
  newTicketId,
  readTicketCode,
} from "@/lib/ticket-code";
import { deriveKey } from "@/lib/secret-box";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = 1_793_700_000_000;
const SEC = Math.floor(NOW / 1000);
const EVENT = "workshop01";
const TICKET = "abcdefgh23456789";
const EXP = SEC + 30 * 86_400;

const made = (event = EVENT, ticket = TICKET, expiresAt = EXP, now = NOW) => {
  const out = makeTicketCode({ event, ticket, expiresAt }, now);
  return out.ok ? out.code : `refused:${out.reason}`;
};

/** Puts an environment value back as it was, absent included (assigning undefined would write "undefined"). */
const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

async function main(): Promise<void> {
  redis.clear();
  const code = made();

  part("A code is made and read back");
  is("the shape", TICKET_CODE.test(code), true);
  is("read back", readTicketCode(code, NOW), { ok: true, event: EVENT, ticket: TICKET, expiresAt: EXP });
  is("the same ticket gives the same code (it can be shown again)", made(), code);
  is("another ticket gives another code", made(EVENT, "bbbbbbbb23456789") === code, false);
  is("a new ticket id has the ticket shape", /^[a-z2-7]{16}$/.test(newTicketId()), true);
  is("two new ticket ids differ", newTicketId() === newTicketId(), false);

  part("The code carries no personal data");
  is("an address is not an event", made("ana@example.com"), "refused:event");
  is("an address is not a ticket", made(EVENT, "ana@example.com"), "refused:ticket");
  is("a name with spaces is not an event", made("Ana Silva"), "refused:event");
  is("nothing but the event, the ticket, the date and the signature", code.split("."), ["t1", EVENT, TICKET, EXP.toString(36), code.split(".")[4]]);
  is("no @ anywhere", code.includes("@"), false);

  part("A forged code is refused");
  const [v, e, t, x, sig] = code.split(".");
  const flip = (s: string) => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");
  is("one changed sign of the signature", readTicketCode([v, e, t, x, flip(sig)].join("."), NOW), { ok: false, reason: "forged" });
  is("another ticket under this signature", readTicketCode([v, e, "bbbbbbbb23456789", x, sig].join("."), NOW), { ok: false, reason: "forged" });
  is("another event under this signature", readTicketCode([v, "workshop02", t, x, sig].join("."), NOW), { ok: false, reason: "forged" });
  is("a later date under this signature", readTicketCode([v, e, t, (EXP + 86_400).toString(36), sig].join("."), NOW), { ok: false, reason: "forged" });
  {
    const plain = createHmac("sha256", "guess").update(`t1|${EVENT}|${TICKET}|${EXP}`).digest("hex").slice(0, 40);
    is("a signature made with a guessed key", readTicketCode([v, e, t, x, plain].join("."), NOW), { ok: false, reason: "forged" });
  }
  {
    const before = process.env.NIMBUS_DATA_KEY;
    process.env.NIMBUS_DATA_KEY = "another-deployment-secret-of-enough-length-0001";
    is("a code made under another deployment's key", readTicketCode(code, NOW), { ok: false, reason: "forged" });
    const other = made();
    restore("NIMBUS_DATA_KEY", before);
    is("and that deployment's code here", readTicketCode(other, NOW), { ok: false, reason: "forged" });
  }
  is("a forged code with an old date reads as forged, not expired", readTicketCode([v, e, t, (SEC - 10).toString(36), sig].join("."), NOW), { ok: false, reason: "forged" });

  part("A malformed code is refused");
  for (const bad of ["", "t1", code.toUpperCase(), `${code}.x`, code.replace("t1.", "t2."), ` ${code}`, code.slice(0, -1), 42 as unknown as string, null as unknown as string]) {
    is(`malformed: ${JSON.stringify(bad).slice(0, 30)}`, readTicketCode(bad, NOW), { ok: false, reason: "malformed" });
  }

  part("An expired code is refused");
  is("good up to the second before", readTicketCode(code, (EXP - 1) * 1000).ok, true);
  is("refused at its end", readTicketCode(code, EXP * 1000), { ok: false, reason: "expired" });
  is("refused after", readTicketCode(code, (EXP + 1) * 1000), { ok: false, reason: "expired" });
  is("a code is not made already expired", made(EVENT, TICKET, SEC), "refused:expiry");
  is(`nor good for more than ${MAX_TICKET_DAYS} days`, made(EVENT, TICKET, SEC + MAX_TICKET_DAYS * 86_400 + 1), "refused:expiry");
  is("nor with a date that is not a whole number", made(EVENT, TICKET, EXP + 0.5), "refused:expiry");

  part("No key in the environment: no code is made, none is read (rule 24)");
  {
    const before = { d: process.env.NIMBUS_DATA_KEY, s: process.env.STRIPE_SECRET_KEY };
    delete process.env.NIMBUS_DATA_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    is("not made", made(), "refused:no_key");
    is("not read, never taken as good", readTicketCode(code, NOW), { ok: false, reason: "no_key" });
    is("check-in refuses", await checkIn(code, { event: EVENT, now: NOW }), { ok: false, reason: "no_key" });
    restore("NIMBUS_DATA_KEY", before.d);
    restore("STRIPE_SECRET_KEY", before.s);
  }

  part("A routine key change never turns a sold ticket into a forged one (Claude 3, MEDIUM 1 on #3457)");
  {
    // A code can be good for 400 days. Codes are made only under NIMBUS_DATA_KEY, a secret with no
    // other job: under the Stripe key alone none is made or read, so neither setting NIMBUS_DATA_KEY
    // for the first time nor rotating the Stripe key can ever make a printed ticket read as forged.
    const before = { d: process.env.NIMBUS_DATA_KEY, s: process.env.STRIPE_SECRET_KEY };
    const DATA = "tests-only-ticket-data-key-of-enough-length-01";
    const STRIPE_A = "sk_test_tickets_only_a_0000000000000000";
    const STRIPE_B = "sk_test_tickets_only_b_0000000000000000";
    const end = EXP.toString(36);
    const underRoot = () => {
      const key = deriveKey("event-ticket/v1");
      return key ? `t1.${EVENT}.${TICKET}.${end}.${createHmac("sha256", key).update(`t1|${EVENT}|${TICKET}|${EXP}`).digest("hex").slice(0, 40)}` : "";
    };

    process.env.NIMBUS_DATA_KEY = DATA;
    process.env.STRIPE_SECRET_KEY = STRIPE_A;
    const sold = made();
    is("control: a code is made under NIMBUS_DATA_KEY", TICKET_CODE.test(sold), true);
    process.env.STRIPE_SECRET_KEY = STRIPE_B;
    is("the Stripe key rotated: the sold code still reads", readTicketCode(sold, NOW), { ok: true, event: EVENT, ticket: TICKET, expiresAt: EXP });
    delete process.env.STRIPE_SECRET_KEY;
    is("no Stripe key at all: the sold code still reads", readTicketCode(sold, NOW).ok, true);

    delete process.env.NIMBUS_DATA_KEY;
    process.env.STRIPE_SECRET_KEY = STRIPE_A;
    is("only the Stripe key: no code is made", made(), "refused:no_key");
    const stripeSigned = underRoot();
    is("only the Stripe key: a code signed under it is not read as good", readTicketCode(stripeSigned, NOW), { ok: false, reason: "no_key" });
    is("only the Stripe key: check-in refuses it", await checkIn(stripeSigned, { event: EVENT, now: NOW }), { ok: false, reason: "no_key" });
    process.env.STRIPE_SECRET_KEY = STRIPE_B;
    is("the Stripe key rotated with no NIMBUS_DATA_KEY: still no code is made", made(), "refused:no_key");
    process.env.NIMBUS_DATA_KEY = DATA;
    is("NIMBUS_DATA_KEY set again: the code sold under it reads", readTicketCode(sold, NOW).ok, true);

    restore("NIMBUS_DATA_KEY", before.d);
    restore("STRIPE_SECRET_KEY", before.s);
  }

  part("Check-in admits once");
  redis.clear();
  is("first scan admits", await checkIn(code, { event: EVENT, now: NOW }), { ok: true, ticket: TICKET });
  is("the second scan is refused as used", await checkIn(code, { event: EVENT, now: NOW + 60_000 }), { ok: false, reason: "used" });
  is("a third scan, at another door, still used", await checkIn(code, { event: EVENT, now: NOW + 120_000 }), { ok: false, reason: "used" });
  {
    const ttl = redis.run(["TTL", checkInKey(EVENT, TICKET)]) as number;
    is("the mark lasts until the code ends and a day more, not for good", ttl > 0 && ttl <= EXP - SEC + CHECK_IN_KEEP_SECONDS && ttl >= EXP - SEC, true);
    is("the mark's key has no personal data", /@/.test(checkInKey(EVENT, TICKET)), false);
  }
  is("another ticket to the same event admits", await checkIn(made(EVENT, "cccccccc23456789"), { event: EVENT, now: NOW }), { ok: true, ticket: "cccccccc23456789" });
  is("a code for another event is refused at this door, and takes no mark", await checkIn(made("workshop02"), { event: EVENT, now: NOW }), { ok: false, reason: "wrong_event" });
  is("that code still admits at its own door", await checkIn(made("workshop02"), { event: "workshop02", now: NOW }), { ok: true, ticket: TICKET });
  is("a forged code is refused and takes no mark", await checkIn([v, e, "dddddddd23456789", x, sig].join("."), { event: EVENT, now: NOW }), { ok: false, reason: "forged" });
  is("no mark for the forged ticket", redis.run(["EXISTS", checkInKey(EVENT, "dddddddd23456789")]), 0);
  is("an expired code is refused at the door", await checkIn(code, { event: EVENT, now: EXP * 1000 }), { ok: false, reason: "expired" });
  is("a door with no real event refuses", await checkIn(code, { event: "", now: NOW }), { ok: false, reason: "wrong_event" });

  part("An answer that cannot be read refuses entry (rule 24)");
  const real = redis.pipeline.bind(redis);
  const odd = async (reply: unknown, readBack: unknown) => {
    redis.clear();
    let calls = 0;
    redis.pipeline = (async () => {
      calls += 1;
      if (calls === 1) return [reply];
      return [readBack];
    }) as typeof redis.pipeline;
    try {
      return await checkIn(made(EVENT, "eeeeeeee23456789"), { event: EVENT, now: NOW });
    } finally {
      redis.pipeline = real;
    }
  };
  is('"ok" (not exactly "OK"), nothing read back', await odd("ok", null), { ok: false, reason: "unknown" });
  is("1 for OK, unreadable read back", await odd(1, 7), { ok: false, reason: "unknown" });
  is("an object, nothing read back", await odd({ ok: true }, null), { ok: false, reason: "unknown" });
  is("an odd answer, another value read back: someone else's, used", await odd("weird", "1793700000000.000000001"), { ok: false, reason: "used" });
  {
    redis.clear();
    redis.pipeline = (async () => {
      throw new Error("connection reset");
    }) as typeof redis.pipeline;
    try {
      is("Redis not answering at all", await checkIn(made(EVENT, "ffffffff23456789"), { event: EVENT, now: NOW }), { ok: false, reason: "unknown" });
    } finally {
      redis.pipeline = real;
    }
  }
  {
    redis.clear();
    redis.pipeline = (async () => [null]) as typeof redis.pipeline;
    try {
      is("nil to SET NX: somebody holds it, used", await checkIn(made(EVENT, "gggggggg23456789"), { event: EVENT, now: NOW }), { ok: false, reason: "used" });
    } finally {
      redis.pipeline = real;
    }
  }

  part("What the door is told, in plain US English");
  is("one line for each refusal", Object.keys(CHECK_IN_REFUSALS).sort(), ["expired", "forged", "malformed", "no_key", "unknown", "used", "wrong_event"]);
  is("the unknown line never says come in", /come in|admit|welcome/i.test(CHECK_IN_REFUSALS.unknown), false);

  done();
}

void main();
