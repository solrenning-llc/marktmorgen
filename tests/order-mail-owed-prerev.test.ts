/**
 * The pre-review of claude5/order-mail-kept @a423c617da (Claude 5's
 * coordinator, 9 November 2026): each part failed on that head and holds
 * what is expected since. Synthetic Redis and a scripted sender
 * (tests/order-mail-owed-world.ts); no email leaves.
 *
 *   A1  a sender refusing for longer than the tries took (Amazon SES paused,
 *       its daily quota spent, the Resend fallback blocked): the tries are
 *       spread over the days the email is kept, and the creator's notice is
 *       owed too, so someone hears of it once the sender is back;
 *   M1  a person erased from the store is never sent the owed email;
 *   L1  a notice says the real reason it was given up;
 *   L2  an owed email whose record ran out leaves no id in its store's count.
 */
import { OWED_MAIL_KEEP_SECONDS, OWED_MAIL_PER_STORE, OWED_MAIL_RETRY_SECONDS, sendOrderMail, sendOwedOrderMail } from "@/lib/order-mail-owed";
import { createHash } from "node:crypto";
// lib/suppression.ts suppressCommand, inline: importing it pulls lib/auth, and lib/email is this test's scripted sender.
const suppressCommand = (listId: string, email: string) => ["HSET", `nl:erased:${listId}`, createHash("sha256").update(`nimbus-erased:${listId}:${email.trim().toLowerCase()}`).digest("hex").slice(0, 32), 1];
import { answers, sends } from "./order-mail-owed-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const shop = { statsId: "st_owed", handle: "owed-shop", email: "creator@example.test", name: "Owed Shop", listId: "list_owed" };
const storeFor = async (handle: string) => (handle === shop.handle ? shop : null);
const message = (n: number, to = "buyer@example.test") => ({
  from: "Owed Shop <shop@example.test>", to, subject: `Your license key for Thing ${n}`, text: `Synthetic key KEY-${n}`,
  replyTo: shop.email, idempotencyKey: `nimbus-key:st_owed:prod_${n}:cs_${n}`,
});
const reset = () => { redis.clear(); sends.length = 0; answers.length = 0; };
const clock = Date.now;
let at = clock();
Date.now = () => at;
const wait = (s: number) => { at += s * 1000; };
const run = () => sendOwedOrderMail(storeFor, Date.now() + 10_000);
const outcomes: string[] = [];

async function main(): Promise<void> {
  part("A1 (ALTO): sender refusing for more than ~3h15 (SES paused, daily quota spent; Resend blocked): the email and the creator's notice are both lost");
  reset();
  // three tries of the buyer's email, then the notice: all refused by the same sender
  answers.push("refused", "refused", "refused", "refused");
  await sendOrderMail(shop, message(1), "a key");
  wait(OWED_MAIL_RETRY_SECONDS[0]); await run();
  wait(OWED_MAIL_RETRY_SECONDS.at(-1)!); await run();
  // the sender is healthy again a day later, still inside OWED_MAIL_KEEP_SECONDS
  wait(OWED_MAIL_KEEP_SECONDS / 2); await run();
  const delivered = sends.slice(4);
  is("someone (the buyer, or at least the creator) hears of it once the sender is back, within the days it is kept", delivered.length > 0, true);
  outcomes.push(`A1 sends=${sends.length} after=${delivered.length}`);

  part("M1 (MÉDIO): a person erased from the store still receives the owed email on the retry");
  reset();
  answers.push("refused");
  await sendOrderMail(shop, message(2), "a key");
  redis.run(suppressCommand(shop.listId, "buyer@example.test"));
  wait(OWED_MAIL_RETRY_SECONDS[0]); await run();
  is("not sent to a deleted address (as checkout-ask, broadcasts, product-updates)", sends.filter((s) => s.to === "buyer@example.test").length, 1);

  part("L1 (LEVE): notice for an email given up at once (store cap) says it was tried and stopped 'so it is not sent twice'");
  reset();
  for (let n = 0; n < OWED_MAIL_PER_STORE; n += 1) { answers.push("refused"); await sendOrderMail(shop, message(100 + n), "a key"); }
  answers.push("refused");
  await sendOrderMail(shop, message(999), "a key");
  const told = sends.find((s) => s.to === shop.email);
  is("the notice does not give a reason that is not the real one", /so it is not sent twice/.test(told?.text ?? ""), false);

  part("L2 (LEVE): an owed email whose record ran out leaves its id in the store's set (finish(id, \"\") never SREMs)");
  reset();
  answers.push("refused"); await sendOrderMail(shop, message(3), "a key");
  wait(OWED_MAIL_KEEP_SECONDS / 2);
  answers.push("refused"); await sendOrderMail(shop, message(4), "a key"); // refreshes the set's expiry
  wait(OWED_MAIL_KEEP_SECONDS / 2 + 1); // the job did not run (3's record ran out)
  redis.run(["ZADD", "nl:owedmail:due", "XX", 0, "x"]);
  answers.push("sent");
  await run();
  is("no phantom left in its store's count", redis.run(["SCARD", "nl:owedmail:s:st_owed"]), 0);
}

main().then(() => { console.log(outcomes.join("\n")); done(); }, (error) => { console.error(error); process.exitCode = 1; }).finally(() => { Date.now = clock; });
