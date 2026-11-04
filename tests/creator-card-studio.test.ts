/**
 * 639 [GL7](22), unit 3: the business card in the studio
 * (components/creator-card-editor.tsx, app/studio/card/page.tsx). Every
 * field labeled with an example beside it, off until turned on, a preview in
 * the store's look under its own heading with nothing in it that leaves the
 * studio, refusals said in an alert, deleting it undone by saving again, and
 * the page reached from the studio by those who may change settings.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CreatorCardEditor } from "@/components/creator-card-editor";
import { CreatorCardView } from "@/components/creator-card-view";
import { CONTACT_WORDS } from "@/lib/buyer-words/contact";
import { type CreatorCard, NO_CARD } from "@/lib/creator-card";
import { done, is, part } from "./check";

// Made at run time, so no number in this file reads as someone's.
const phone = "+" + "15550104477";
const card: CreatorCard = { on: true, name: "Ana Souza", title: "Pottery teacher", email: "ana@example.com", phone, website: "https://ana.example.com/", note: "Classes online" };
const draw = (initial: CreatorCard) =>
  renderToStaticMarkup(createElement(CreatorCardEditor, { initial, handle: "anapottery", storeName: "Ana's Pottery", words: CONTACT_WORDS.pt.card, address: "marktmorgen.com/@anapottery/contact", look: { className: "st-page st-theme-warm", style: {}, lang: "pt-PT" } }));

part("Filling it in");
const empty = draw(NO_CARD);
const labels = ["Name on the card", "What you do (optional)", "Email to show (optional)", "Phone to show (optional)", "Your website (optional)", "A line under your name (optional)"];
is("every field labeled, the optional ones said to be", labels.every((label) => empty.includes(`<span class="field-label">${label}</span>`)), true);
is("each with an example beside it, read with the field", ["name", "title", "email", "phone", "website", "note"].every((key) => empty.includes(`aria-describedby="card-${key}-hint"`) && empty.includes(`id="card-${key}-hint"`)), true);
is("the phone's hint says how to type it", empty.includes("With + and your country code first"), true);
is("the browser can fill each in", ['autoComplete="name"', 'autoComplete="email"', 'autoComplete="tel"', 'autoComplete="url"'].every((a) => empty.includes(a)), true);
is("off until turned on, saying where and who can see it", empty.includes("Show my card") && !/type="checkbox"[^>]*checked/.test(empty) && empty.includes("At marktmorgen.com/@anapottery/contact, with a Save contact button. Anyone with the address can see it."), true);
is("nothing to delete before anything is kept", empty.includes("Delete the card"), false);
is("refusals said in an alert, and what was done in a status", empty.includes('role="alert"') && empty.includes('role="status"'), true);

part("The preview");
is("asks for the name first", empty.includes("Type the name on the card, and the preview appears here."), true);
const full = draw(card);
is("drawn in the store's look and language", full.includes('class="mt-4 rounded-xl st-page st-theme-warm"') && full.includes('lang="pt-PT"'), true);
is("under its own heading, the card's name a third-level one", full.includes('<h2 id="card-preview-title"') && full.includes('<h3 id="card-preview-name"') && !full.includes("<h1"), true);
is("nothing in it leaves the studio or saves a card not yet kept", [full.includes("mailto:"), full.includes("tel:"), full.includes("/contact/vcard")], [false, false, false]);
is("in the store's language", full.includes("Guardar o contacto"), true);
is("a kept card can be deleted", full.includes("Delete the card"), true);
const page = renderToStaticMarkup(createElement(CreatorCardView, { card, handle: "anapottery", storeName: "Ana's Pottery", words: CONTACT_WORDS.en.card }));
is("the card itself, outside the studio, keeps its links and its heading", page.includes('<h1 id="card-name"') && page.includes("mailto:ana@example.com") && page.includes("/@anapottery/contact/vcard"), true);

part("Deleting, undone");
const editor = readFileSync("components/creator-card-editor.tsx", "utf8");
is("the words stay on the screen, and saving puts it back", editor.includes("setCard((typed) => ({ ...typed, on: false }))") && editor.includes("Its words are still below: save to put it back."), true);

part("In the studio");
const studio = readFileSync("app/studio/card/page.tsx", "utf8");
is("only for those who may change settings, as the route", studio.includes('"settings");') && readFileSync("app/api/store/creator-card/route.ts", "utf8").includes('jsonAccess(request, "settings")'), true);
is("a link to the card once it is shown", studio.includes("{card?.on ? (") && studio.includes("Open your card at"), true);
is("said when it cannot be read", studio.includes("Your card could not be read just now. Nothing was changed."), true);
const home = readFileSync("app/studio/page.tsx", "utf8");
is("reached from the studio's tools, for the same people", /may\("settings"\)\s*\?\s*\[\{ href: studioPath\(store, "", "card"\), title: "Business card"/.test(home), true);

done();
