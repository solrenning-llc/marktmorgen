/**
 * The buyer emails written around a store's own words, rendered in every
 * buyer language (lib/store-language.ts) with synthetic edge data: a name of
 * 300 characters, a right-to-left name, emoji, and the characters < > & " '.
 *
 *   - review requests (lib/review-requests.ts requestText), product updates
 *     (lib/product-updates.ts updateText), community event emails
 *     (lib/community-event-mail.ts eventMailWords) and come-back offers
 *     (lib/winback-send.ts winbackEmail), each through lib/mail.ts render
 *     with the door it is sent with;
 *   - the HTML says the language it is written in, and its title is the subject;
 *   - no "undefined", "NaN", "null", "[object Object]", "Infinity" or an
 *     unreplaced placeholder in the subject, the HTML or the text;
 *   - the store's name is escaped once in the HTML and never in the text;
 *   - every one carries its stop link in both versions and the one-click
 *     List-Unsubscribe headers pointing at the door that honours it, and the
 *     creator's postal address when the store has one.
 *
 * Synthetic store only; no provider is reached.
 */
import { requestText } from "@/lib/review-requests";
import { updateText } from "@/lib/product-updates";
import { eventMailWords } from "@/lib/community-event-mail";
import { winbackEmail } from "@/lib/winback-send";
import { render, type Door } from "@/lib/mail";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";
import { updatesWords } from "@/lib/buyer-words/updates";
import { communityWords } from "@/lib/buyer-words/community";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { claimHandle, storeForEmail, type Store } from "@/lib/store";
import { LANGUAGES, LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { SITE_URL } from "@/lib/site-url";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No real provider call allowed");
}) as typeof fetch;

const OWNER = "i18n-email-render@example.test";
const ADDRESS = "100 Main St, Springfield, IL 62701, USA";
const NAMES = [
  `Tom & Jerry's <b>"Shop"</b>`,
  "متجر الكتب",
  "Café 🎨✨ Studio",
  "N".repeat(300),
];
const BAD = /\bundefined\b|\bNaN\b|\bnull\b|\[object Object\]|\bInfinity\b|⟦|\$\{/;
const TOKEN = "a".repeat(40);

const escapeOnce = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Mail = { label: string; subject: string; body: string; door: Door; key: string };

function mails(store: Store, language: LanguageCode, name: string): Mail[] {
  const g = givingWords(language);
  const u = updatesWords(language);
  const c = communityWords(language);
  const lang = speech(store).lang.locale;
  const review = requestText(store, [name, `${name} 2`], 1_790_000_000, `${SITE_URL}/@${store.handle}/review?ask=${TOKEN}`, "first");
  const again = requestText({ ...store, reviewAsk: { ...store.reviewAsk, again: 7 } }, [name], 1_790_000_000, `${SITE_URL}/@${store.handle}/review?ask=${TOKEN}`, "again");
  const update = updateText(store, name, `A note with ${name}`);
  const event = { id: "e1", title: name, start: 1_790_000_000, minutes: 90, tz: "America/New_York" } as Parameters<typeof eventMailWords>[2];
  const reviewDoor = (page: string): Door => ({ page, oneClick: page.replace("/unsubscribe?", "/api/mail/unsubscribe?"), why: g.askWhy(name), label: g.askStopLabel, after: g.askStopAfter(name), line: g.askStopLine(page), sent: g.sentWith, lang });
  const updateDoor = (page: string): Door => ({ page, oneClick: page.replace("/unsubscribe?", "/api/mail/unsubscribe?"), why: u.why(name, name), label: u.stopLabel, after: u.stopAfter(name), line: u.stopLine(page), sent: g.sentWith, lang });
  const out: Mail[] = [
    { label: "review request", ...review, door: reviewDoor(`${SITE_URL}/unsubscribe?v=${TOKEN}`), key: "v" },
    { label: "review reminder", ...again, door: reviewDoor(`${SITE_URL}/unsubscribe?v=${TOKEN}`), key: "v" },
    { label: "product update", ...update, door: updateDoor(`${SITE_URL}/unsubscribe?u=${TOKEN}`), key: "u" },
  ];
  for (const kind of ["24", "1"] as const) {
    const words = eventMailWords(store, { name }, event, { kind, was: 0, wasMinutes: 0 } as Parameters<typeof eventMailWords>[3]);
    out.push({
      label: `event reminder ${kind}`,
      subject: words.subject,
      body: words.body,
      door: { page: `${SITE_URL}/unsubscribe?c=${TOKEN}`, oneClick: `${SITE_URL}/api/mail/unsubscribe?c=${TOKEN}`, why: words.why, label: c.stopLabel, after: c.stopAfterEvents },
      key: "c",
    });
  }
  out.push({
    label: "announcement",
    subject: `News from ${name}`,
    body: "Hello",
    door: { page: `${SITE_URL}/unsubscribe?c=${TOKEN}`, oneClick: `${SITE_URL}/api/mail/unsubscribe?c=${TOKEN}`, why: c.announceWhy(name, name), label: c.stopLabel, after: c.stopAfterAnnounce },
    key: "c",
  });
  return out;
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "i18nemailrender", "Plain Shop", "");
  const base = (await storeForEmail(OWNER))!;

  for (const language of LANGUAGE_CODES) {
    for (const currency of ["USD", "JPY", "EUR"]) {
      for (const name of NAMES) {
        const store: Store = { ...base, name, language, currency, mail: { ...(base.mail ?? {}), fromName: name, address: ADDRESS } } as Store;
        const locale = LANGUAGES[language].locale;
        for (const mail of mails(store, language, name)) {
          const where = `${mail.label} in ${language}/${currency} for ${name.slice(0, 20)}`;
          const r = render(store, mail.subject, mail.body, null, mail.door);
          is(`${where}: nothing unwritten`, [BAD.test(r.subject), BAD.test(r.text), BAD.test(r.html)], [false, false, false]);
          is(`${where}: the HTML says its language`, r.html.includes(`<html lang="${locale}">`), true);
          is(`${where}: the name escaped once in the HTML, never raw`, [r.html.includes(escapeOnce(name)), name === escapeOnce(name) || !r.html.includes(name), r.html.includes("&amp;amp;")], [true, true, false]);
          is(`${where}: the text keeps the name as typed`, [r.text.includes(name), /&(amp|lt|gt|quot);/.test(r.text)], [true, false]);
          is(`${where}: the stop link in both versions`, [r.text.includes(mail.door.page), r.html.includes(`href="${escapeOnce(mail.door.page)}"`)], [true, true]);
          is(`${where}: one-click headers to the door`, r.headers, {
            "List-Unsubscribe": `<${SITE_URL}/api/mail/unsubscribe?${mail.key}=${TOKEN}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          });
          is(`${where}: the postal address in both versions`, [r.text.includes(ADDRESS), r.html.includes(escapeOnce(ADDRESS))], [true, true]);
          is(`${where}: a subject that is not empty and fits`, r.subject.length > 0 && r.subject.length <= 200, true);
        }
        // A come-back offer is sent as plain text with the list's own door.
        const wb = winbackEmail({ storeName: name, title: name, endedOn: speech(store).date(1_790_000_000_000), offer: affiliatesWords(language).winbackOffer(30, 3), link: `${SITE_URL}/@x/renew/p?back=${TOKEN}`, until: speech(store).date(1_791_000_000_000), language });
        const r = render(store, wb.subject, wb.body, TOKEN);
        is(`come-back offer in ${language}/${currency} for ${name.slice(0, 20)}: nothing unwritten, its unsubscribe and address`, [
          BAD.test(r.subject) || BAD.test(r.text),
          r.text.includes(`${SITE_URL}/unsubscribe?t=${TOKEN}`),
          r.headers["List-Unsubscribe"],
          r.text.includes(ADDRESS),
        ], [false, true, `<${SITE_URL}/api/mail/unsubscribe?t=${TOKEN}>`, true]);
      }
    }
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
