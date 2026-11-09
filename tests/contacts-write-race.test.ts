/**
 * A contact's row is written only over what was read (consent audit of 9 November 2026, ALTO 1; the race
 * proofs are the auditor's, aud-consent-proof-unsub-race, extended here to every writer it named).
 *
 * upsertContact, noteProduct (lib/contacts.ts) and stopCounting (lib/mail-clicks.ts) read a contact, decide,
 * then wrote the row with a plain HSET. An unsubscribe through the link, a spam complaint or a deletion that
 * landed between the read and the write was undone: the person came back as agreeing and was selected by the
 * next send, and a deleted person came back with the token whose record was deleted (a dead unsubscribe link).
 * Now each writes only while the row (and, for upsertContact, the address's deleted mark) is still as read; a
 * change in between is read again and decided again, and a deletion that lands in between wins.
 *
 * And the deleted mark itself (lib/suppression.ts, nl:erased) is read where the links are handed out
 * (tokensFor, so sendTo): a row that exists for an address the store deleted is never written to, and a mark
 * that cannot be read stops the send for a retry, never "nobody deleted".
 */
import { forgetContactPerson, leadsKey, noteProduct, orderRoom, readUnsubToken, stopWriting, tokensFor, unsubscribe, upsertContact } from "@/lib/contacts";
import { stopCounting } from "@/lib/mail-clicks";
import { sendTo } from "@/lib/mail";
import { suppressCommand, suppressedKey, suppressionPrint } from "@/lib/suppression";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureListId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const handle = "race-shop";
const real = redis.pipeline.bind(redis);
const OWNER = { sid: ROOM.sid, statsId: "race_stats", handle };

async function setup(list: string, email: string, clicks = false): Promise<string> {
  await upsertContact(list, email, { agreed: true, explicit: true, source: "free", clicks }, ROOM);
  const token = (await tokensFor(list, [email], handle)).get(email);
  if (!token) throw Error("setup: token");
  return token;
}

/** Runs `between` once, right after the first read that `first` matches, with the real Redis; everything else as it is. */
function raceAt(first: (commands: Commands) => boolean, between: () => Promise<unknown>): { ran: () => boolean } {
  let fired = false;
  redis.pipeline = async (commands: Commands) => {
    if (!fired && first(commands)) {
      fired = true;
      const before = await real(commands);
      const hook = redis.pipeline;
      redis.pipeline = real;
      await between();
      redis.pipeline = hook;
      return before;
    }
    return real(commands);
  };
  return { ran: () => fired };
}
const rowRead = (list: string, length: number) => (c: Commands) => c.length === length && c[0][0] === "HGET" && c[0][1] === leadsKey(list);
const erase = async (list: string, email: string) => {
  await real([suppressCommand(list, email)]);
  await forgetContactPerson(list, email);
};
const row = (list: string, email: string) => redis.run(["HGET", leadsKey(list), email]);

async function main() {
  redis.clear();

  part("noteProduct (a purchase without the box)");
  {
    const list = "race_note_unsub", email = "buyer@example.com";
    const token = await setup(list, email);
    const race = raceAt(rowRead(list, 1), () => unsubscribe(token));
    const mailable = await noteProduct(list, email, "prod_1", "Guide", OWNER);
    redis.pipeline = real;
    is("control: the race ran", race.ran(), true);
    const after = (await readUnsubToken(token))?.contact;
    is("an unsubscribe made between its read and its write stays, and the purchase is still noted", [after?.unsub, after?.ids], [true, ["prod_1"]]);
    is("it answers from the row it wrote over: not mailable, so no sequence starts", mailable, false);
    is("the next send does not select the person who left", (await tokensFor(list, [email], handle)).has(email), false);
  }
  {
    const list = "race_note_complaint", email = "spam@example.com";
    const token = await setup(list, email);
    const race = raceAt(rowRead(list, 1), () => stopWriting(list, email, "complained"));
    await noteProduct(list, email, "prod_3", "Course", OWNER);
    redis.pipeline = real;
    is("control: the race ran", race.ran(), true);
    const after = (await readUnsubToken(token))?.contact;
    is("a spam complaint recorded between its read and its write stays", [after?.unsub, after?.gone], [true, "complained"]);
  }
  {
    const list = "race_note_erase", email = "erased@example.com";
    await setup(list, email);
    const race = raceAt(rowRead(list, 1), () => erase(list, email));
    const mailable = await noteProduct(list, email, "prod_5", "Course", OWNER);
    redis.pipeline = real;
    is("control: the race ran", race.ran(), true);
    is("a person deleted between its read and its write is not put back on the list", [row(list, email), mailable], [null, false]);
    is("and the next send does not select them", (await tokensFor(list, [email], handle)).has(email), false);
  }

  part("upsertContact without a new yes (a free download, the box empty)");
  for (const [what, room] of [["the store's room", ROOM], ["an order's room", orderRoom(OWNER)]] as const) {
    const list = `race_upsert_unsub_${what.length}`, email = "reader@example.com";
    const token = await setup(list, email);
    const race = raceAt(rowRead(list, 3), () => unsubscribe(token));
    const result = await upsertContact(list, email, { agreed: false, explicit: false, source: "free", productId: "prod_2", title: "Free" }, room);
    redis.pipeline = real;
    is(`${what}: control: the race ran`, race.ran(), true);
    const after = (await readUnsubToken(token))?.contact;
    is(`${what}: an unsubscribe made between its read and its write stays, and the download is still noted`, [after?.unsub, after?.ids, result.gotProduct], [true, ["prod_2"], true]);
  }
  for (const [what, room] of [["the store's room", ROOM], ["an order's room", orderRoom(OWNER)]] as const) {
    const list = `race_upsert_complaint_${what.length}`, email = "spam@example.com";
    const token = await setup(list, email);
    const race = raceAt(rowRead(list, 3), () => stopWriting(list, email, "complained"));
    await upsertContact(list, email, { agreed: false, explicit: false, source: "buyer", productId: "prod_6", title: "Pack" }, room);
    redis.pipeline = real;
    is(`${what}: control: the race ran`, race.ran(), true);
    const after = (await readUnsubToken(token))?.contact;
    is(`${what}: a spam complaint recorded in between stays`, [after?.unsub, after?.gone], [true, "complained"]);
  }

  part("upsertContact with an old yes (a thank-you page reloaded) against an unsubscribe in between");
  for (const [what, room] of [["the store's room", ROOM], ["an order's room", orderRoom(OWNER)]] as const) {
    const list = `race_upsert_reload_${what.length}`, email = "reload@example.com";
    const token = await setup(list, email);
    const at = new Date(Date.now() - 60_000).toISOString();
    const race = raceAt(rowRead(list, 3), () => unsubscribe(token));
    await upsertContact(list, email, { agreed: true, explicit: true, source: "buyer", at, productId: "prod_7", title: "Book" }, room);
    redis.pipeline = real;
    is(`${what}: control: the race ran`, race.ran(), true);
    is(`${what}: a yes given before the unsubscribe does not undo it`, (await readUnsubToken(token))?.contact.unsub, true);
  }

  part("upsertContact against a deletion in between");
  for (const [what, room] of [["the store's room", ROOM], ["an order's room", orderRoom(OWNER)]] as const) {
    const list = `race_upsert_erase_${what.length}`, email = "gone@example.com";
    await setup(list, email);
    const race = raceAt(rowRead(list, 3), () => erase(list, email));
    const result = await upsertContact(list, email, { agreed: false, explicit: false, source: "free", productId: "prod_8", title: "Free" }, room);
    redis.pipeline = real;
    is(`${what}: control: the race ran`, race.ran(), true);
    is(`${what}: the deleted person is not written back, and nothing says they joined`, [row(list, email), result.joined], [null, false]);
  }
  for (const [what, room] of [["the store's room", ROOM], ["an order's room", orderRoom(OWNER)]] as const) {
    const list = `race_upsert_erase_new_${what.length}`, email = "new.gone@example.com";
    // Not on the list yet: a deletion that lands between the read and the write leaves its mark, and the row is not made.
    const race = raceAt(rowRead(list, 3), () => real([suppressCommand(list, email)]));
    const result = await upsertContact(list, email, { agreed: true, explicit: true, source: "free", at: new Date(Date.now() - 60_000).toISOString() }, room);
    redis.pipeline = real;
    is(`${what}: control: the race ran`, race.ran(), true);
    is(`${what}: a sign-up read before a deletion is not written after it, nor the deletion lifted`, [row(list, email), result.joined, redis.run(["HLEN", suppressedKey(list)])], [null, false, 1]);
  }

  part("stopCounting (the `l` link) against an unsubscribe or a deletion in between");
  {
    const list = "race_clicks_unsub", email = "counted@example.com";
    const token = await setup(list, email, true);
    is("control: they allowed their link use to be seen", Boolean((await readUnsubToken(token))?.contact.clicks), true);
    const race = raceAt(rowRead(list, 1), () => unsubscribe(token));
    await stopCounting(token);
    redis.pipeline = real;
    is("control: the race ran", race.ran(), true);
    const after = (await readUnsubToken(token))?.contact;
    is("the unsubscribe stays, and the permission is gone", [after?.unsub, after?.clicks], [true, undefined]);
    is("the next send does not select them", (await tokensFor(list, [email], handle)).has(email), false);
  }
  {
    const list = "race_clicks_erase", email = "counted.gone@example.com";
    const token = await setup(list, email, true);
    const race = raceAt(rowRead(list, 1), () => erase(list, email));
    await stopCounting(token);
    redis.pipeline = real;
    is("control: the race ran", race.ran(), true);
    is("a person deleted in between is not written back", row(list, email), null);
  }
  {
    const list = "race_clicks_healthy", email = "healthy@example.com";
    const token = await setup(list, email, true);
    is("healthy control: without a race the permission is taken back", [await stopCounting(token), (await readUnsubToken(token))?.contact.clicks, (await readUnsubToken(token))?.contact.unsub], [true, undefined, false]);
  }

  part("Healthy controls without a race");
  {
    const list = "race_healthy", email = "ok@example.com";
    const token = await setup(list, email);
    await unsubscribe(token);
    await noteProduct(list, email, "prod_4", "Pack", OWNER);
    const c = (await readUnsubToken(token))?.contact;
    is("a purchase after an unsubscribe is noted and the unsubscribe stays", [c?.unsub, c?.ids], [true, ["prod_4"]]);
    const fresh = await upsertContact(list, "fresh@example.com", { agreed: true, explicit: true, source: "free", productId: "prod_9", title: "Guide" }, orderRoom(OWNER));
    is("a new sign-up through an order still joins", [fresh.joined, fresh.gotProduct], [true, true]);
    const again = await upsertContact(list, "fresh@example.com", { agreed: true, explicit: true, source: "free", productId: "prod_10", title: "Course" }, ROOM);
    is("and a second one notes the product without joining twice", [again.joined, again.gotProduct, JSON.parse(String(row(list, "fresh@example.com"))).ids], [false, true, ["prod_9", "prod_10"]]);
  }

  part("unsubscribe against a deletion or a purchase in between");
  {
    const list = "race_unsub_erase", email = "leaving.gone@example.com";
    const token = await setup(list, email);
    const race = raceAt(rowRead(list, 1), () => erase(list, email));
    const answer = await unsubscribe(token);
    redis.pipeline = real;
    is("control: the race ran", race.ran(), true);
    is("a person deleted between the press's read and its write is not written back; the press is done by the deletion", [row(list, email), answer?.email], [null, email]);
    is("and the mark that keeps them off stays", redis.run(["HLEN", suppressedKey(list)]), 1);
  }
  {
    const list = "race_unsub_note", email = "leaving.buyer@example.com";
    const token = await setup(list, email);
    const race = raceAt(rowRead(list, 1), () => noteProduct(list, email, "prod_11", "Guide", OWNER));
    await unsubscribe(token);
    redis.pipeline = real;
    is("control: the race ran", race.ran(), true);
    const after = (await readUnsubToken(token))?.contact;
    is("a purchase noted in between is kept, and the press still takes them off", [after?.unsub, after?.ids], [true, ["prod_11"]]);
  }

  part("A yes from before a deletion never undoes it (a thank-you page of an older order reloaded)");
  for (const [what, room] of [["the store's room", ROOM], ["an order's room", orderRoom(OWNER)]] as const) {
    const list = `old_yes_${what.length}`, email = "old.yes@example.com";
    await setup(list, email);
    const ordered = new Date(Date.now() - 60_000).toISOString();
    await erase(list, email);
    const result = await upsertContact(list, email, { agreed: true, explicit: true, source: "buyer", at: ordered, productId: "prod_12", title: "Book" }, room);
    is(`${what}: an older order's yes writes nothing back and lifts nothing`, [row(list, email), result.joined, redis.run(["HLEN", suppressedKey(list)])], [null, false, 1]);
    const bought = await upsertContact(list, email, { agreed: false, explicit: false, source: "buyer", at: ordered, productId: "prod_12", title: "Book" }, room);
    is(`${what}: nor does an older purchase without the box`, [row(list, email), bought.gotProduct], [null, false]);
  }
  for (const [what, room] of [["the store's room", ROOM], ["an order's room", orderRoom(OWNER)]] as const) {
    const list = `new_yes_${what.length}`, email = "new.yes@example.com";
    await setup(list, email);
    await forgetContactPerson(list, email);
    // Deleted ten seconds ago; their own yes, given now.
    await real([suppressCommand(list, email, Math.floor(Date.now() / 1000) - 10)]);
    const result = await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, room);
    is(`${what}: their own yes given after the deletion puts them back and lifts it`, [result.joined, JSON.parse(String(row(list, email))).agreed, redis.run(["HLEN", suppressedKey(list)])], [true, true, 0]);
  }
  {
    const list = "later_purchase", email = "later.buyer@example.com";
    await real([suppressCommand(list, email, Math.floor(Date.now() / 1000) - 10)]);
    const result = await upsertContact(list, email, { agreed: false, explicit: false, source: "buyer", productId: "prod_13", title: "Pack" }, orderRoom(OWNER));
    is("a purchase made after the deletion, without the box, is still noted, as one who may not be written to", [result.gotProduct, JSON.parse(String(row(list, email))).agreed, redis.run(["HLEN", suppressedKey(list)])], [true, false, 1]);
  }
  for (const [what, mark] of [["a mark that is not a count of seconds", "soon"], ["a deletion in this same second", String(Math.floor(Date.now() / 1000))]] as const) {
    const list = `unknown_mark_${what.length}`, email = "unknown.mark@example.com";
    await redis.pipeline([["HSET", suppressedKey(list), suppressionPrint(list, email), mark]]);
    const result = await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    is(`${what}: not known to be older, so nothing is written and nothing lifted`, [row(list, email), result.joined, redis.run(["HLEN", suppressedKey(list)])], [null, false, 1]);
  }

  part("The deleted mark where links are handed out (tokensFor, sendTo)");
  {
    const list = "race_tokens_erased", email = "marked@example.com", other = "kept@example.com";
    await setup(list, email);
    await setup(list, other);
    // A row that exists for an address the store deleted: whatever left it there, it is never written to.
    await real([suppressCommand(list, email)]);
    const tokens = await tokensFor(list, [email, other], handle);
    is("an address marked as deleted gets no link; the other one does", [tokens.has(email), tokens.has(other)], [false, true]);
    let trapped = false;
    redis.pipeline = async (commands: Commands) => {
      if (commands.length === 1 && commands[0][0] === "HMGET" && commands[0][1] === suppressedKey(list)) {
        trapped = true;
        return [[null]];
      }
      return real(commands);
    };
    const unknown = await tokensFor(list, [email, other], handle).then(() => "answered", (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : String(error)));
    redis.pipeline = real;
    is("a deleted-mark read in another shape is unknown, never \"nobody deleted\"", [trapped, unknown], [true, "unknown"]);
  }
  {
    redis.clear();
    const ownerEmail = "race.owner@example.com";
    await claimHandle(ownerEmail, "race-letters", "Race Letters", "");
    await ensureListId(ownerEmail);
    await setSubscription(ownerEmail, { customerId: "cus_RaceLetters01", subscriptionId: "sub_RaceLetters01", active: true, tier: "pro", period: paidPeriod() });
    await setMailSettings(ownerEmail, { fromName: "Race Letters", address: "4 Paper Lane, Boston, MA 02108" });
    const store = (await storeForEmail(ownerEmail))!;
    const listId = store.listId!;
    for (const email of ["deleted@example.com", "stays@example.com"]) await upsertContact(listId, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    await real([suppressCommand(listId, "deleted@example.com")]);
    process.env.RESEND_API_KEY = "re_test_contacts_write_race_only";
    const mail = installSesMailFixture();
    mail.configure();
    await mail.setReady(true, { max24: 50_000, rate: 100 });
    const outcome = await sendTo(store, ["deleted@example.com", "stays@example.com"], "News", "Fresh stock.", "race-send");
    is("sendTo writes only to the address that was not deleted", [mail.ses.flatMap((m) => m.to), outcome.stopped], [["stays@example.com"], null]);
    redis.pipeline = async (commands: Commands) =>
      commands.length === 1 && commands[0][0] === "HMGET" && commands[0][1] === suppressedKey(listId) ? [[null, null, null]] : real(commands);
    const unsure = await sendTo(store, ["deleted@example.com", "stays@example.com"], "News", "Fresh stock.", "race-send-2");
    redis.pipeline = real;
    is("a deleted-mark read in another shape stops the send for a retry, and nothing more goes", [unsure.stopped, unsure.done, mail.ses.length], ["retry", [], 1]);
    mail.restore();
  }
  done();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
