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
 *   - an unknown folder, an empty one, or one of the wrong shape draws none.
 */
import { createElement, type Context } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { pictureLine, pictureUrl } from "@/lib/mail-picture-rules";
import * as pictureRules from "@/lib/mail-picture-rules";
import { bodyHtml, render } from "@/lib/mail";
import { advanceBroadcast, type Broadcast } from "@/lib/broadcasts";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, imageFolder, setMailSettings, setSubscription, storeForEmail, storeForHandle, storeRef } from "@/lib/store";
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

  done();
}

void main();
