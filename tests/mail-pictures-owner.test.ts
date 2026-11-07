/**
 * A picture in an email is drawn only where "Add a picture" put it: in an
 * email to the store's own list, and only from that store's own picture
 * folder (lib/mail-picture-rules.ts ownPicturesOnly; study of 6 November 2026,
 * part 1). Every picture is fetched from /api/image when the email is opened,
 * and those fetches have no line of their own in the cost registry, so a
 * picture nobody chose to put there is a cost nobody counted.
 *
 * Checked, on the real code:
 *
 *   - a store's own email, not to its list (a win-back, an offer, a notice;
 *     render() with no folder), carries no picture: each one becomes its
 *     description, as withoutPictures makes it for the text version;
 *   - bodyHtml with no folder draws none (a community event's email);
 *   - an email to the list draws the store's own pictures, and a picture from
 *     another store's folder becomes its description;
 *   - the same through a real broadcast (lib/mail.ts sendTo), the "[Test]"
 *     email the studio sends (app/api/store/mail/route.ts), the email's page
 *     on the web (app/[handle]/letters/[letter]) and the studio's
 *     "As it is sent" preview (components/mail-designer.tsx);
 *   - an unknown folder, an empty one, or one of the wrong shape draws none;
 *   - after the owner's address changes (moveAccount, lib/store.ts), the
 *     pictures already in the store's emails are still its own: the record
 *     keeps the folders it had (imageFolders, at most MAX_IMAGE_FOLDERS), and
 *     the broadcast, the [Test] email, the email's page and the preview draw
 *     them still, beside the ones kept in the new folder; another store's
 *     stays its description. A record whose earlier folders are not exactly
 *     a short list of folders keeps only the current one, never every one,
 *     and a move left half done is still settled (settleDoubledStore).
 */
import { createElement, type Context } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { pictureLine, pictureUrl } from "@/lib/mail-picture-rules";
import * as pictureRules from "@/lib/mail-picture-rules";
import { bodyHtml, render } from "@/lib/mail";
import { advanceBroadcast, type Broadcast } from "@/lib/broadcasts";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, imageFolder, moveAccount, setMailSettings, setSubscription, settleDoubledStore, storeForEmail, storeForHandle, storeRef } from "@/lib/store";
import * as storeLib from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { publishLetter } from "@/lib/letters";
import LetterPage from "@/app/[handle]/letters/[letter]/page";
import { POST as mailRoute } from "@/app/api/store/mail/route";
import * as designer from "@/components/mail-designer";
import { cookieValues } from "./letter-members-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const OWNER = "pictures@example.com";
const OTHER = "someone-else@example.com";
const MOVED = "pictures-moved@example.com";
/** The key a store's record is kept under in the stand-in, found by the owner written in it. */
const recordKeyOf = (email: string) =>
  redis.keys().find((key) => {
    try {
      const raw = redis.run(["GET", key]);
      if (typeof raw !== "string" || !raw.startsWith("{")) return false;
      const value = JSON.parse(raw) as { email?: unknown; handle?: unknown };
      return value.email === email && value.handle === "oven-notes";
    } catch {
      return false;
    }
  });
const imgs = (html: string) => [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "oven-notes", "Oven Notes", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_OvenNotes0001", subscriptionId: "sub_OvenNotes0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Oven Notes", address: "1 Main St, Boston, MA 02108" });
  const store = (await storeForEmail(OWNER))!;
  const own = await imageFolder(storeRef(store));
  const theirs = await imageFolder(OTHER);
  const mine = pictureUrl(own, `${"b".repeat(31)}1.jpg`);
  const notMine = pictureUrl(theirs, `${"c".repeat(31)}2.jpg`);
  const body = `Hello,\n\n${pictureLine("The loaf", mine)}\nIt rose.\n\n${pictureLine("Their cake", notMine)}\n\n${pictureLine("", notMine)}\n\nSee you.`;

  part("A store's own email, not to its list: no picture, the description instead");
  const winback = render(store, "We miss you", body, "tok");
  is("no picture is drawn", imgs(winback.html), []);
  is("each description stays, in brackets, as the text version has it", [winback.html.includes("[The loaf]"), winback.html.includes("[Their cake]")], [true, true]);
  is("no picture's address is left in it", [winback.html.includes(mine), winback.html.includes(notMine)], [false, false]);
  is("the words around them stay", [winback.html.includes("Hello,"), winback.html.includes("It rose."), winback.html.includes("See you.")], [true, true, true]);
  is("bodyHtml with no folder draws none either (a community event's email)", imgs(bodyHtml(body)), []);

  part("An email to the list: only the store's own pictures");
  const listed = render(store, "New loaf", body, "tok", undefined, undefined, undefined, own);
  is("its own picture is drawn, as before (control)", imgs(listed.html).includes(mine), true);
  is("and no other", imgs(listed.html), [mine]);
  is("with its description", listed.html.includes(`alt="The loaf"`), true);
  is("another store's becomes its description", [listed.html.includes("[Their cake]"), listed.html.includes(notMine)], [true, false]);
  is("the text version is as it was", [listed.text.includes("[The loaf]"), listed.text.includes(mine)], [true, false]);
  const ownPicturesOnly = (pictureRules as Record<string, unknown>).ownPicturesOnly as ((body: string, folder?: string) => string) | undefined;
  is("the rule is one function the browser can read too", typeof ownPicturesOnly, "function");
  if (ownPicturesOnly) {
    is("an unknown folder keeps none", ownPicturesOnly(body), ownPicturesOnly(body, ""));
    is("nor one of the wrong shape", ownPicturesOnly(body, `${own}/`).includes(mine), false);
    is("and keeps the store's own line exactly", ownPicturesOnly(body, own).includes(pictureLine("The loaf", mine)), true);
  }

  part("Through a real broadcast to the list");
  process.env.RESEND_API_KEY = "re_test_mail_pictures_owner_only";
  const mail = installSesMailFixture();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  await upsertContact(store.listId!, "reader@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const id = "333333333333333333333333";
  const key = `nl:mail:bc:${id}`;
  const broadcast = { id, listId: store.listId, handle: store.handle, subject: "New loaf", body, productId: null, notProductId: null, who: "all", narrow: null, status: "sending", createdAt: 100, sendAt: 100, finishedAt: 0, total: 1, sent: 0, note: "", failures: 0, listed: true, tagged: true, test: null };
  await redis.pipeline([["SET", key, JSON.stringify(broadcast)], ["RPUSH", `${key}:to`, "reader@example.com"], ["SADD", "nl:mail:queue", id]]);
  await advanceBroadcast(id, storeForHandle, Date.now() + 10_000);
  is("it went", mail.ses.length, 1);
  is("with the store's own picture and not the other", imgs(mail.ses[0]?.html ?? ""), [mine]);

  part("The [Test] email the studio sends");
  const session = await openSession(OWNER);
  const tested = await mailRoute(new NextRequest("https://marktmorgen.com/api/store/mail", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "test", subject: "New loaf", body }) }));
  is("it went", [tested.status, mail.ses.length], [200, 2]);
  is("with the store's own picture and not the other", imgs(mail.ses[1]?.html ?? ""), [mine]);
  mail.restore();

  part("The email's page on the web");
  const sent = { ...broadcast, status: "sent", finishedAt: 200, sent: 1 } as unknown as Broadcast;
  await redis.pipeline([["SET", key, JSON.stringify(sent)]]);
  const published = await publishLetter(store, sent, Date.now());
  is("it is published", published.ok, true);
  const letterId = published.ok ? published.letter.id : "";
  cookieValues.clear();
  const page = renderToStaticMarkup(await LetterPage({ params: Promise.resolve({ handle: `@${store.handle}`, letter: letterId }), searchParams: Promise.resolve({}) }));
  is("the store's own picture and not the other", imgs(page).filter((src) => src.includes("/api/image/")), [mine]);
  is("the other's description is there", page.includes("[Their cake]"), true);

  part("The studio's \"As it is sent\" preview");
  const MailPictures = (designer as Record<string, unknown>).MailPictures as Context<string> | undefined;
  is("the studio tells the preview which folder is the store's", typeof MailPictures, "object");
  if (MailPictures) {
    // The preview draws the email's own absolute addresses; the small pictures beside "Add a picture"
    // (components/mail-picture-button.tsx) are the studio's own way to tell the lines apart, not the email.
    const drawn = (html: string) => [...new Set(imgs(html).filter((src) => src.startsWith("https://")))];
    const preview = renderToStaticMarkup(createElement(MailPictures.Provider, { value: own }, createElement(designer.MailBodyEditor, { body, onChange: () => {} })));
    is("its own picture is drawn, the other is not", drawn(preview), [mine]);
    const unknown = renderToStaticMarkup(createElement(designer.MailBodyEditor, { body, onChange: () => {} }));
    is("with no folder told, none is", drawn(unknown), []);
  }

  part("After the owner's address changes: the pictures already posted are still the store's own");
  const pictureFolders = (storeLib as Record<string, unknown>).pictureFolders as ((store: storeLib.Store) => Promise<string[]>) | undefined;
  const maxFolders = (storeLib as Record<string, unknown>).MAX_IMAGE_FOLDERS as number | undefined;
  is("the store says which folders are its own", typeof pictureFolders, "function");
  is("with a small ceiling", maxFolders, 10);
  const fromKey = recordKeyOf(OWNER);
  is("the record is found (control)", typeof fromKey, "string");
  const moved = await moveAccount(OWNER, MOVED);
  is("the account moved", moved.ok, true);
  const after = (await storeForEmail(MOVED))!;
  const now = await imageFolder(storeRef(after));
  is("new pictures go to another folder now (control)", now !== own, true);
  is("the record keeps the folder it had", (after as storeLib.Store & { imageFolders?: string[] }).imageFolders, [own]);
  const folders = pictureFolders ? await pictureFolders(after) : [now];
  is("its own folders: the current first, then the one before", folders, [now, own]);
  const fresh = pictureUrl(now, `${"d".repeat(31)}3.jpg`);
  const later = `${body}\n\n${pictureLine("The new loaf", fresh)}`;

  const again = installSesMailFixture();
  again.configure();
  await again.setReady(true, { max24: 50_000, rate: 100 });
  const id2 = "444444444444444444444444";
  const key2 = `nl:mail:bc:${id2}`;
  await redis.pipeline([["SET", key2, JSON.stringify({ ...broadcast, id: id2, body: later })], ["RPUSH", `${key2}:to`, "reader@example.com"], ["SADD", "nl:mail:queue", id2]]);
  await advanceBroadcast(id2, storeForHandle, Date.now() + 20_000);
  is("a broadcast went", again.ses.length, 1);
  is("drawing the picture posted before the move and the one after, not another store's", imgs(again.ses[0]?.html ?? ""), [mine, fresh]);
  is("another store's is still its description", (again.ses[0]?.html ?? "").includes("[Their cake]"), true);

  const session2 = await openSession(MOVED);
  const tested2 = await mailRoute(new NextRequest("https://marktmorgen.com/api/store/mail", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session2}` }, body: JSON.stringify({ action: "test", subject: "New loaf", body: later }) }));
  is("the [Test] email went", [tested2.status, again.ses.length], [200, 2]);
  is("with both of the store's own pictures, not another store's", imgs(again.ses[1]?.html ?? ""), [mine, fresh]);
  again.restore();

  cookieValues.clear();
  const page2 = renderToStaticMarkup(await LetterPage({ params: Promise.resolve({ handle: `@${store.handle}`, letter: letterId }), searchParams: Promise.resolve({}) }));
  is("the email's page still draws the picture it was sent with", imgs(page2).filter((src) => src.includes("/api/image/")), [mine]);

  if (MailPictures) {
    const drawn = (html: string) => [...new Set(imgs(html).filter((src) => src.startsWith("https://")))];
    const preview2 = renderToStaticMarkup(createElement(MailPictures.Provider, { value: folders as unknown as string }, createElement(designer.MailBodyEditor, { body: later, onChange: () => {} })));
    is("the preview, told the store's folders, draws both and not another store's", drawn(preview2), [mine, fresh]);
  }
  if (ownPicturesOnly) {
    const rule = ownPicturesOnly as unknown as (body: string, folder?: string | readonly string[]) => string;
    is("the rule takes the store's folders", [rule(later, folders).includes(mine), rule(later, folders).includes(fresh), rule(later, folders).includes(notMine)], [true, true, false]);
    is("and an empty list keeps none", rule(later, []).includes(mine), false);
    is("nor a list of wrong shapes", rule(later, ["*", `${own}/`, ""]).includes(mine), false);
  }

  part("A record whose earlier folders are not exactly a short list of folders keeps only the current one");
  const toKey = recordKeyOf(MOVED)!;
  const kept = redis.run(["GET", toKey]) as string;
  const wrongs: unknown[] = ["all", "*", [own, "not-a-folder"], [own.toUpperCase()], Array.from({ length: 11 }, (_, i) => own.slice(0, 23) + (i % 10)), { 0: own }, [[own]], [own, own], [now]];
  for (const wrong of wrongs) {
    redis.run(["SET", toKey, JSON.stringify({ ...JSON.parse(kept), imageFolders: wrong })]);
    const read = (await storeForEmail(MOVED))!;
    is(`${JSON.stringify(wrong).slice(0, 40)}: only the current folder`, pictureFolders ? await pictureFolders(read) : null, [now]);
  }
  redis.run(["SET", toKey, kept]);

  part("A move left half done is settled as before (lib/move-repair.ts)");
  // The old address still holds the record as it was before the move, the handle already points to the new one.
  const before = JSON.parse(kept) as Record<string, unknown>;
  delete before.imageFolders;
  redis.run(["SET", fromKey!, JSON.stringify({ ...before, email: OWNER })]);
  is("the address that keeps it is the new one", await settleDoubledStore(OWNER, MOVED), MOVED);
  is("the copy at the old address is gone", redis.run(["GET", fromKey!]), null);
  is("the folders it had are kept", ((await storeForEmail(MOVED)) as storeLib.Store & { imageFolders?: string[] }).imageFolders, [own]);

  part("Moved again and again: at most the ceiling, the latest first");
  let at = MOVED;
  const seen: string[] = [now];
  for (let i = 0; i < 11; i++) {
    const next = `pictures-moved-${i}@example.com`;
    is(`move ${i + 1}`, (await moveAccount(at, next)).ok, true);
    at = next;
    seen.unshift(await imageFolder(at));
  }
  const last = (await storeForEmail(at))! as storeLib.Store & { imageFolders?: string[] };
  is("the record keeps ten", last.imageFolders?.length, 10);
  is("the latest ones, newest first", last.imageFolders, seen.slice(1, 11));
  is("the current folder is never among them", last.imageFolders?.includes(seen[0]), false);

  done();
}

void main();
