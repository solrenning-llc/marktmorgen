/**
 * AX274 item 5 (emails), WCAG 2.4.9 Link Purpose (Link Only), AAA: a link in an
 * email says where it goes by its own words. The email audit of 11 November 2026
 * (PR #3766) found that in service letters the link's words were the address
 * itself; in the live-event emails (canceled, moved, and the reminders a day and
 * an hour before) the event page and the community's events were written as a
 * bare address at the end of a sentence, so the HTML's link read
 * "https://marktmorgen.com/@…/community/events/…".
 *
 * What must hold, in each of the store's seven languages: each address is a
 * button of its own whose words say where it leads ("Open the event page"); the
 * HTML has no link whose words are its address; the text version keeps the
 * address after those words ("Open the event page: https://…"), and the notice's
 * text version is drawn by bodyText, as the reminders' is.
 */
import { readFileSync } from "node:fs";
import { COMMUNITY_WORDS } from "@/lib/buyer-words/community";
import { bodyHtml, bodyText } from "@/lib/mail-body";
import { done, is, part } from "./check";

const EVENTS = "https://marktmorgen.com/@harbor/community/events";
const PAGE = "https://marktmorgen.com/@harbor/community/events/0123456789abcdef";

for (const [code, w] of Object.entries(COMMUNITY_WORDS)) {
  part(`${code}: each address in the event emails is a link with words`);
  for (const [kind, body, url] of [
    ["canceled", w.evCanceledBody("Harbor Kitchen", "Bread class", "The Kitchen Club", "Mon 6 PM", EVENTS), EVENTS],
    ["moved", w.evMovedBody("Harbor Kitchen", "Bread class", "The Kitchen Club", "Mon 6 PM", "Tue 6 PM", PAGE), PAGE],
    ["reminder", w.evReminderBody(true, "Bread class", "The Kitchen Club", "Mon 6 PM", 10, PAGE), PAGE],
  ] as const) {
    const html = bodyHtml(body);
    const links = [...html.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => ({ href: m[1], words: m[2] }));
    const toUrl = links.filter((l) => l.href === url);
    is(`${kind}: one link to the page`, toUrl.length, 1);
    is(`${kind}: its words are not the address`, toUrl.length === 1 && toUrl[0].words !== url && toUrl[0].words.trim().length > 0 && !/^https?:/.test(toUrl[0].words), true);
    is(`${kind}: no link anywhere reads as its address`, links.some((l) => l.words === l.href), false);
    const words = toUrl[0]?.words ?? "∅";
    is(`${kind}: the text version keeps the address after the words`, bodyText(body).includes(`${words}: ${url}`), true);
  }
}

part("The notice's text version is drawn by bodyText");
const source = readFileSync("lib/community-event-mail.ts", "utf8");
is("text: bodyText(words.body)", /text: `\$\{bodyText\(words\.body\)\}/.test(source), true);

done();
