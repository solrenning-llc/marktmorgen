/**
 * WCAG 3.1.4 Abbreviations (AAA, AX274) on the help center (/help): in each
 * section, the first time an abbreviation appears (in a question or an
 * answer) it is drawn as <abbr title> with what it stands for, from the one
 * list (lib/abbreviations.ts). The real page is rendered.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import HelpPage from "@/app/help/page";
import { done, is, part } from "./check";

/** The abbreviations the help center writes (found on /help on 14 November 2026). */
const FOUND = ["QR", "GB", "MB", "KB", "PDF", "ZIP", "PNG", "JPG", "JPEG", "GIF", "SVG", "WAV", "MOV", "TXT", "CSV", "ID", "HTML", "UTC", "SHA", "ACH", "SEPA", "API", "RSVP", "CRM", "VPN", "RSS", "ICS", "VAT", "JSON", "HMAC", "DRM", "PIN", "HSTS", "FTC", "URL", "MP3", "MP4"];

const html = renderToStaticMarkup(createElement(HelpPage));
const sections = [...html.matchAll(/<section id="([^"]+)" data-help-section[^>]*>([\s\S]*?)<\/section>/g)];
part(`${sections.length} help sections`);
is("the help center's sections are found", sections.length > 3, true);
let checked = 0;
for (const [, id, body] of sections) {
  // The section's words in order, each abbreviation marked when it sits in an <abbr title>.
  const words = body.replace(/<abbr title="[^"]+">([^<]+)<\/abbr>/g, "\u0001$1\u0002").replace(/<[^>]+>/g, " ");
  for (const short of FOUND) {
    const first = new RegExp(`(\u0001)?\\b${short}(?=s?\\b)`).exec(words);
    if (!first) continue;
    checked++;
    is(`${id}: the first ${short} says what it stands for`, Boolean(first[1]), true);
  }
}
is("abbreviations were checked", checked > 10, true);
done();
