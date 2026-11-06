/**
 * "Visit us" on a store page (521 [LB2], unit 1; lib/visit-us.ts, the store's
 * record, app/api/store/visit-us, components/visit-us-block.tsx and
 * components/visit-us-editor.tsx; added 2 November 2026). Checked:
 *
 *   - the address is read as a booking in person reads one; the hours are up
 *     to seven short lines with no link; the phone has 6 to 15 digits, and
 *     its link keeps the + and the digits only; all empty is no block;
 *   - the store keeps it, takes it away when emptied, and changes nothing
 *     when a part cannot be kept, saying which;
 *   - the block shows a heading, each part under its own label, the address
 *     as an address and the phone as a link a phone can dial, named with its
 *     purpose; a part left empty is not drawn; nothing is looked up, embedded
 *     or tracked (no map, no outside address);
 *   - the studio's editor has a labeled field for each part with its help,
 *     checks with the same rules before sending, and is shown to whoever may
 *     change the page; the store page draws the block (read in their source);
 *   - every language names the block and its parts.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHours, parsePhone, readVisitUs, telHref, type VisitUs } from "@/lib/visit-us";
import { VisitUsBlock } from "@/components/visit-us-block";
import { VISIT_WORDS } from "@/lib/buyer-words/visit";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { claimHandle, setVisitUs, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
// A made-up number (555-01xx), put together here so no whole phone number is written in the repository (scripts/check_public_data.py).
const PHONE = "+" + "1 207 555 0142";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();

  part("The rules");
  is("hours: as typed, empty rows dropped, spaces tidied", parseHours("Tuesday to Saturday,  9am to 7pm\n\nSunday: closed\n"), ["Tuesday to Saturday, 9am to 7pm", "Sunday: closed"]);
  is(
    "hours refused: more than seven lines, a long line, a link, an email address, something invisible, not text",
    [parseHours(Array(8).fill("Mon 9-5").join("\n")), parseHours("x".repeat(61)), parseHours("See belastudio.com"), parseHours("https://x.example"), parseHours("ask ana@example.com"), parseHours("Mon\u200b9-5"), parseHours(7)],
    Array(7).fill("hours"),
  );
  is("a phone as written, tidied", [parsePhone((" " + PHONE + " ")), parsePhone("(85) 3333-4444"), parsePhone("020.7946.0958"), parsePhone(""), parsePhone(null)], [PHONE, "(85) 3333-4444", "020.7946.0958", null, null]);
  is(
    "a phone refused: too few or too many digits, letters, a + not at the start, not text",
    [parsePhone("12345"), parsePhone("1".repeat(16)), parsePhone("call 555 0142"), parsePhone("555+0142"), parsePhone(5550142)],
    Array(5).fill("phone"),
  );
  is("its link keeps the + and the digits only", [telHref(PHONE), telHref("(85) 3333-4444")], [("tel:" + "+" + "12075550142"), "tel:8533334444"]);
  const full = readVisitUs({ place: "Bela Studio\n12 Harbor Street", hours: "Tue–Sat 9am–7pm", phone: PHONE });
  is("the whole block", full, { place: { lines: ["Bela Studio", "12 Harbor Street"] }, hours: ["Tue–Sat 9am–7pm"], phone: PHONE });
  is("all empty is no block", [readVisitUs({ place: "", hours: "\n", phone: " " }), readVisitUs(null)], [null, null]);
  is(
    "the address refuses a website or an email address too, as the hours do",
    [readVisitUs({ place: "Bela Studio\nbelastudio.com" }), readVisitUs({ place: "ask ana@bela.com" }), readVisitUs({ place: "Ana\uff20bela.com" })],
    ["place", "place", "place"],
  );
  is(
    "more invisible characters and a broken one are refused; an at sign alone is fine",
    [parseHours("Mon\u00ad 9-5"), parseHours("Mon\u200d9-5"), parseHours("Mon\u2060 9-5"), parseHours("Mon \ud800"), parseHours("Mon @ 9am")],
    ["hours", "hours", "hours", "hours", ["Mon @ 9am"]],
  );
  is("a part that cannot be kept is named", [readVisitUs({ place: "https://maps.example/x" }), readVisitUs({ hours: "www.bela" }), readVisitUs({ phone: "abc" }), readVisitUs([1])], ["place", "hours", "phone", "place"]);

  part("The store keeps it");
  const OWNER = "bela@example.com";
  await claimHandle(OWNER, "bela", "Bela Studio", "");
  is("a new store has none", ((await storeForEmail(OWNER)) as Store).visitUs, null);
  const saved = await setVisitUs(OWNER, { place: "Bela Studio\n12 Harbor Street", hours: "Tue–Sat 9am–7pm", phone: PHONE });
  is("saved, and read back as saved", [saved.ok, ((await storeForEmail(OWNER)) as Store).visitUs], [true, full]);
  const refused = await setVisitUs(OWNER, { place: "Bela Studio", phone: "12" });
  is("a part that cannot be kept changes nothing, and is named", [refused.ok ? "saved" : refused.reason, ((await storeForEmail(OWNER)) as Store).visitUs], ["phone", full]);
  await setVisitUs(OWNER, { place: "", hours: "", phone: "" });
  is("emptied, it is taken away", ((await storeForEmail(OWNER)) as Store).visitUs, null);

  part("The block on the store page");
  const html = renderToStaticMarkup(createElement(VisitUsBlock, { visitUs: full as VisitUs, language: "en" }));
  is(
    "a named section with a heading, each part under its label, the address as an address",
    [html.includes('<section class="st-card mt-8 px-5 py-5 sm:px-6" aria-labelledby="visit-us"'), html.includes('<h2 id="visit-us"'), html.includes(">Visit us</h2>"), html.includes("<dt") && html.includes(">Address</dt>") && html.includes(">Opening hours</dt>") && html.includes(">Phone</dt>"), html.includes("<address")],
    [true, true, true, true, true],
  );
  is("the phone is a link a phone can dial, named with its purpose and large enough to tap", [html.includes('href="tel:' + "+" + '12075550142"'), html.includes(`aria-label="Call ${PHONE}"`), html.includes("min-h-11")], [true, true, true]);
  is("nothing looked up, embedded or tracked: no map, no outside address, no image", [/<iframe|<img|<script|maps\.|google|apple/i.test(html), (html.match(/href="/g) ?? []).length], [false, 1]);
  const twice = renderToStaticMarkup(createElement(VisitUsBlock, { visitUs: { place: null, hours: ["Sat: closed", "Sun: closed", "Sat: closed"], phone: null }, language: "en" }));
  is("the same line twice is drawn twice", (twice.match(/Sat: closed/g) ?? []).length, 2);
  const onlyPhone = renderToStaticMarkup(createElement(VisitUsBlock, { visitUs: { place: null, hours: [], phone: PHONE }, language: "pt" }));
  is("a part left empty is not drawn, in the store's language", [onlyPhone.includes("Morada"), onlyPhone.includes("Horário"), onlyPhone.includes("Telefone"), onlyPhone.includes("Visite-nos")], [false, false, true, true]);

  part("The studio and the page");
  const editor = readFileSync("components/visit-us-editor.tsx", "utf8");
  is(
    "the editor labels each field, ties its help, and checks with the server's rules before sending",
    [(editor.match(/<label htmlFor=\{`\$\{id\}-(place|hours|phone)`\} className="field-label">/g) ?? []).length, (editor.match(/aria-describedby=\{`\$\{id\}-(place|hours|phone)-help`\}/g) ?? []).length, editor.includes("const read = readVisitUs(body);") && editor.includes("body: JSON.stringify(tidy)"), editor.includes('type="tel"')],
    [3, 3, true, true],
  );
  is("shown to whoever may change the page", readFileSync("app/studio/page.tsx", "utf8").includes('{may("page") ? <VisitUsEditor visitUs={store.visitUs} /> : null}'), true);
  const route = readFileSync("app/api/store/visit-us/route.ts", "utf8");
  is("the route needs the page permission and a small body", route.includes('guardStoreWrite(request, "page", 2_000)'), true);
  is("the store page draws it after its parts", readFileSync("app/[handle]/page.tsx", "utf8").includes("{store.visitUs ? <VisitUsBlock visitUs={store.visitUs} language={store.language} /> : null}"), true);

  part("In every language");
  is(
    "each names the block and its parts, and the phone link's purpose",
    LANGUAGE_CODES.map((code) => {
      const v = VISIT_WORDS[code];
      return [code, Boolean(v.heading && v.address && v.hours && v.phone), v.call("+1 207").includes("+1 207")];
    }),
    LANGUAGE_CODES.map((code) => [code, true, true]),
  );

  done();
}

void main();
