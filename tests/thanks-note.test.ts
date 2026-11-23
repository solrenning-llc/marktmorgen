/**
 * A creator's own note after paying (lib/thanks-note.ts, added 10 October
 * 2026). What is checked: what the studio sends is read, or which part is
 * wrong — a video that cannot be played, a button without its words or its
 * https page, a note with nothing in it; what is stored is read safely; it
 * is kept in its own record, the product marked as having one, and both go
 * when it is taken off; the confirmation email carries it; the default
 * heading speaks every store language.
 */
import { MAX_NOTE_BODY, parseNote, readNote } from "@/lib/thanks-note";
import { readThanksNote, writeThanksNote } from "@/lib/thanks-note-store";
import { THANKS_WORDS } from "@/lib/buyer-words/thanks";
import { ORDERS_WORDS } from "@/lib/buyer-words/orders";
import { addProduct, claimHandle, ensureStatsId, setProductNote, setStripeAccount, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmationFor } from "@/lib/purchase-email";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "owner@example.com";

async function main(): Promise<void> {
  redis.clear();

  part("Read from the studio, or told what is wrong");
  const full = readNote({ heading: " Welcome ", body: "Start with lesson one.\r\n\r\n\r\n- Join the group", video: "https://youtu.be/dQw4w9WgXcQ", label: "Join the group", url: "https://discord.gg/supper" });
  is("words, a video and a button", typeof full === "string" ? full : [full.heading, full.body, full.video?.provider, full.button], ["Welcome", "Start with lesson one.\n\n- Join the group", "youtube", { label: "Join the group", url: "https://discord.gg/supper" }]);
  is("words alone are a note", typeof readNote({ body: "Thank you." }) === "string" ? "refused" : "kept", "kept");
  is("a video that cannot be played is said", readNote({ body: "Hi", video: "https://example.com/video.mp4" }), "video");
  is("a button needs its words", readNote({ body: "Hi", url: "https://discord.gg/supper" }), "label");
  is("and its page", readNote({ body: "Hi", label: "Join" }), "link");
  is("an https page, nothing else", [readNote({ body: "Hi", label: "Join", url: "javascript:alert(1)" }), readNote({ body: "Hi", label: "Join", url: "http://example.com" })], ["link", "link"]);
  is("a note with nothing in it is not one", [readNote({ heading: "Only a heading" }), readNote({})], ["empty", "empty"]);
  is("as long as a note may be, no longer", typeof readNote({ body: "x".repeat(MAX_NOTE_BODY + 50) }) === "string" ? -1 : (readNote({ body: "x".repeat(MAX_NOTE_BODY + 50) }) as { body: string }).body.length, MAX_NOTE_BODY);
  is("what is stored is read safely", [parseNote(null), parseNote({ heading: "x" }), parseNote({ body: "Hi", button: { label: "Go", url: "ftp://x.y" } })?.button], [null, null, null]);

  part("Kept apart, and marked on the product");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  const statsId = (await ensureStatsId(OWNER))?.statsId;
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  const made = await addProduct(OWNER, "Supper Club Guide", "", "27", null);
  if (!made.ok || !statsId) throw new Error("no product");
  if (typeof full === "string") throw new Error("no note");
  // The note is written through the store's fence (Codex X4-20261119-1743), so the save is given the store itself.
  const noteStore = (await storeForEmail(OWNER))!;
  await writeThanksNote(statsId, made.product.id, full, noteStore);
  await setProductNote(OWNER, made.product.id, true);
  const store = (await storeForEmail(OWNER))!;
  const listing = (await readListing(store, made.product.id))!;
  is("the product says it has one, and the note reads back", [listing.note, await readThanksNote(statsId, made.product.id)], [true, full]);

  part("In the confirmation email");
  const session = {
    id: "cs_test_note00000001",
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    amount_total: 2700,
    currency: "usd",
    created: Math.floor(Date.now() / 1000),
    customer_details: { email: "buyer@example.com" },
    metadata: { store: "harbor", product: made.product.id },
  };
  const letter = confirmationFor(store, session as never, Date.now() / 1000, [], [listing], full);
  const text = letter?.text ?? "";
  is("its heading, words, video and button", [text.includes("\nWelcome\nStart with lesson one."), text.includes("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), text.includes("Join the group: https://discord.gg/supper")], [true, true, true]);
  const plain = confirmationFor(store, session as never, Date.now() / 1000, [], [listing], null);
  is("and nothing of it without one", plain?.text.includes("discord.gg") ?? true, false);

  part("Taken off");
  await setProductNote(OWNER, made.product.id, false);
  await writeThanksNote(statsId, made.product.id, null, noteStore);
  is("the product says so, and the record is gone", [(await readListing((await storeForEmail(OWNER))!, made.product.id))?.note, await readThanksNote(statsId, made.product.id)], [false, null]);

  part("The heading when the creator gives none");
  is("in every store language, on the page and in the email", [Object.values(THANKS_WORDS).map((w) => w.noteFrom("Ana")), Object.values(ORDERS_WORDS).map((w) => w.noteFrom("Ana"))].every((list) => new Set(list).size === 7 && list.every((line) => line.includes("Ana"))), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
