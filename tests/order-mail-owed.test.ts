/**
 * An order email a sender refused for certain is owed, never dropped
 * (lib/order-mail-owed.ts; the owner's EM1, Claude 5's email audit of
 * 9 November 2026, HIGH 2). Synthetic Redis (tests/redis-stub.ts) and a
 * scripted sender (tests/order-mail-owed-world.ts); no email leaves.
 *
 *   sent       nothing is kept;
 *   uncertain  never sent again;
 *   refused    kept, tried again by the email job after its wait, until
 *              sent, uncertain, or REFUSED_TRIES refusals in all; then the
 *              creator is told once (never when the email was their own);
 *   bounds     OWED_MAIL_PER_STORE a store, OWED_MAIL_MAX_BYTES an email:
 *              past either it is given up at once and the creator told.
 */
import { OWED_MAIL_COMMANDS, OWED_MAIL_KEEP_SECONDS, OWED_MAIL_MAX_BYTES, OWED_MAIL_PER_STORE, OWED_MAIL_RETRY_SECONDS, sendOrderMail, sendOwedOrderMail } from "@/lib/order-mail-owed";
import { REFUSED_TRIES } from "@/lib/refused-tries";
import { answers, sends } from "./order-mail-owed-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const shop = { statsId: "st_owed", handle: "owed-shop", email: "creator@example.test", name: "Owed Shop" };
const storeFor = async (handle: string) => (handle === shop.handle ? shop : null);
const message = (n: number, to = "buyer@example.test") => ({
  from: "Owed Shop <shop@example.test>",
  to,
  subject: `Your license key for Thing ${n}`,
  text: `Synthetic key KEY-${n}`,
  replyTo: shop.email,
  idempotencyKey: `nimbus-key:st_owed:prod_${n}:cs_${n}`,
});
const owedKeys = () => redis.keys().filter((k) => k.startsWith("nl:owedmail:m:"));
const due = () => (redis.run(["ZRANGEBYSCORE", "nl:owedmail:due", "-inf", "+inf"]) as string[]) ?? [];
const reset = () => {
  redis.clear();
  sends.length = 0;
  answers.length = 0;
};
const clock = Date.now;
let at = clock();
Date.now = () => at;
// The synthetic Redis reads the same clock (lib/redis-memory.ts, now), so its expiries move with it.
const wait = (seconds: number) => {
  at += seconds * 1000;
};
const run = () => sendOwedOrderMail(storeFor, Date.now() + 10_000);

async function main(): Promise<void> {
  part("Sent: nothing is kept");
  reset();
  is("the outcome is the sender's", await sendOrderMail(shop, message(1), "a key"), "sent");
  is("one send, counted against its order", [sends.length, JSON.stringify(sends[0]?.meter)], [1, '{"by":"order"}']);
  is("nothing owed", [owedKeys().length, due().length], [0, 0]);

  part("Uncertain (or a throw): never sent again");
  reset();
  answers.push("uncertain");
  is("uncertain is said", await sendOrderMail(shop, message(2), "a key"), "uncertain");
  answers.push("throw");
  is("a throw is uncertain, never refused", await sendOrderMail(shop, message(3), "a key"), "uncertain");
  is("nothing owed for either", [owedKeys().length, due().length], [0, 0]);
  wait(OWED_MAIL_KEEP_SECONDS);
  await run();
  is("and the job sends nothing", sends.length, 2);

  part("Refused for certain: kept, and sent by the job after its wait");
  reset();
  answers.push("refused");
  is("refused is said", await sendOrderMail(shop, message(4), "a key"), "refused");
  is("kept once", [owedKeys().length, due().length], [1, 1]);
  is("its key names no address", owedKeys().every((k) => !k.includes("@")), true);
  const ttl = redis.run(["TTL", owedKeys()[0]]) as number;
  is("kept OWED_MAIL_KEEP_SECONDS at most", ttl > 0 && ttl <= OWED_MAIL_KEEP_SECONDS, true);
  await run();
  is("not tried before its wait", sends.length, 1);
  wait(OWED_MAIL_RETRY_SECONDS[0]);
  const sent = await run();
  is("tried after it, and sent", [sends.length, sent.sent], [2, 1]);
  is("the same email, under the same idempotency key", [sends[1].to, sends[1].subject, sends[1].text, sends[1].idempotencyKey], [sends[0].to, sends[0].subject, sends[0].text, sends[0].idempotencyKey]);
  is("nothing owed any more", [owedKeys().length, due().length, redis.keys().filter((k) => k.startsWith("nl:owedmail:s:") && (redis.run(["SCARD", k]) as number) > 0).length], [0, 0, 0]);
  wait(OWED_MAIL_RETRY_SECONDS.at(-1)!);
  await run();
  is("never sent twice", sends.length, 2);

  part("Refused, then uncertain: never sent again");
  reset();
  answers.push("refused", "uncertain");
  await sendOrderMail(shop, message(5), "a key");
  wait(OWED_MAIL_RETRY_SECONDS[0]);
  await run();
  is("taken off the list on the uncertain answer", [owedKeys().length, due().length], [0, 0]);
  wait(OWED_MAIL_RETRY_SECONDS.at(-1)!);
  await run();
  is("and not tried again", sends.length, 2);
  is("nobody told: it may have gone", sends.filter((s) => s.to === shop.email).length, 0);

  part(`Refused ${REFUSED_TRIES} times: given up, the creator told once`);
  reset();
  answers.push("refused", "refused", "refused");
  await sendOrderMail(shop, message(6), "a key");
  wait(OWED_MAIL_RETRY_SECONDS[0]);
  const second = await run();
  is("the second try is refused and still owed", [second.owed, owedKeys().length], [1, 1]);
  wait(OWED_MAIL_RETRY_SECONDS[0]);
  await run();
  is("not tried again before its second wait", sends.length, 2);
  wait(OWED_MAIL_RETRY_SECONDS.at(-1)!);
  const third = await run();
  is("the third try is the last", [third.given, owedKeys().length, due().length], [1, 0, 0]);
  const buyer = sends.filter((s) => s.to === "buyer@example.test");
  const told = sends.filter((s) => s.to === shop.email);
  is(`the buyer's email tried REFUSED_TRIES times in all`, buyer.length, REFUSED_TRIES);
  is("the creator told once", told.length, 1);
  is("told who it was for and what it was, never what it held (a key, a link)", [told[0]?.text.includes("buyer@example.test"), told[0]?.text.includes(message(6).subject), told[0]?.text.includes("KEY-6")], [true, true, false]);
  is("their notice is an order email too, with its own key", [JSON.stringify(told[0]?.meter), /^nimbus-owed-told:[0-9a-f]{32}$/.test(told[0]?.idempotencyKey ?? "")], ['{"by":"order"}', true]);
  wait(OWED_MAIL_KEEP_SECONDS);
  await run();
  is("nothing more, ever", sends.length, REFUSED_TRIES + 1);

  part("Its commands, its whole life, inside OWED_MAIL_COMMANDS (tests/plan-cost-registry.ts, line orders and NOT_A_COST)");
  reset();
  const counted = redis.pipeline;
  let commands = 0;
  redis.pipeline = async (list) => {
    commands += list.length;
    return counted.call(redis, list);
  };
  try {
    answers.push("refused", "refused", "refused");
    await sendOrderMail(shop, message(10), "a key");
    is("inside the order: its first refusal counted and the email kept, 7", commands, 7);
    wait(OWED_MAIL_RETRY_SECONDS[0]);
    await run();
    wait(OWED_MAIL_RETRY_SECONDS.at(-1)!);
    await run();
  } finally {
    redis.pipeline = counted;
  }
  is("its whole life, given up and its creator told, at most OWED_MAIL_COMMANDS", [commands <= OWED_MAIL_COMMANDS, OWED_MAIL_COMMANDS], [true, 23]);
  is("and three tries of its own, then one note", sends.length, REFUSED_TRIES + 1);

  part("An email to the creator's own address: given up without telling the address that refused it");
  reset();
  answers.push("refused", "refused", "refused");
  await sendOrderMail(shop, message(7, shop.email), "a host's confirmation");
  wait(OWED_MAIL_RETRY_SECONDS[0]);
  await run();
  wait(OWED_MAIL_RETRY_SECONDS.at(-1)!);
  await run();
  is("three tries, no fourth email to them", [sends.length, owedKeys().length], [REFUSED_TRIES, 0]);

  part("Bounds: a store owes OWED_MAIL_PER_STORE at most, an email weighs OWED_MAIL_MAX_BYTES at most");
  reset();
  for (let n = 0; n < OWED_MAIL_PER_STORE; n += 1) {
    answers.push("refused");
    await sendOrderMail(shop, message(100 + n), "a key");
  }
  is("each kept, up to the cap", owedKeys().length, OWED_MAIL_PER_STORE);
  answers.push("refused");
  await sendOrderMail(shop, message(999), "a key");
  is("one more is not kept", owedKeys().length, OWED_MAIL_PER_STORE);
  is("its creator told at once", sends.filter((s) => s.to === shop.email && s.text.includes(message(999).subject)).length, 1);
  is("its store's count stays at the cap", redis.run(["SCARD", "nl:owedmail:s:st_owed"]), OWED_MAIL_PER_STORE);
  reset();
  answers.push("refused");
  await sendOrderMail(shop, { ...message(8), text: "x".repeat(OWED_MAIL_MAX_BYTES) }, "a key");
  is("an email too heavy to keep is not kept", owedKeys().length, 0);
  is("and its creator told", sends.filter((s) => s.to === shop.email).length, 1);

  part("A database that does not answer as it should (rule 24): the creator is told, nothing is lost silently");
  reset();
  const pipeline = redis.pipeline;
  let calls = 0;
  // The refusal's count reads; the store's place does not.
  redis.pipeline = async (commands) => (++calls === 2 ? [1] : pipeline.call(redis, commands));
  try {
    answers.push("refused");
    await sendOrderMail(shop, message(9), "a key");
  } finally {
    redis.pipeline = pipeline;
  }
  is("not kept", owedKeys().length, 0);
  is("the creator told", sends.filter((s) => s.to === shop.email).length, 1);
  reset();
  redis.run(["ZADD", "nl:owedmail:due", 0, "not-an-id"]);
  redis.run(["ZADD", "nl:owedmail:due", 0, "0".repeat(32)]);
  await run();
  is("an id that is not one, or one whose email ran out, leaves the list without a send", [due().length, sends.length], [0, 0]);
}

main()
  .then(done, (error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Date.now = clock;
  });
