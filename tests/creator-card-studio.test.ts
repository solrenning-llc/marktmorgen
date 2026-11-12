/**
 * 639 [GL7](22), unit 3: the business card in the studio
 * (components/creator-card-editor.tsx, app/studio/card/page.tsx). Every
 * field labeled with an example beside it, off until turned on, a preview in
 * the store's look under its own heading with nothing in it that leaves the
 * studio, refusals said in an alert, deleting it undone by saving again, and
 * the page reached from Your pages by those who may change the store's pages.
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
is("every field labeled, the optional ones said to be", labels.every((label, i) => empty.includes(`<label for="card-${["name", "title", "email", "phone", "website", "note"][i]}" class="field-label block">${label}</label>`)), true);
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
is("the words stay on the screen, and saving puts it back", editor.includes("edit((typed) => ({ ...typed, on: false }))") && editor.includes("Its words are still below: save to put it back."), true);

part("Accessibility (AAA audit, 4 Nov 2026)");
is("no button is disabled while busy, so focus stays on it (2.4.3)", [/\sdisabled=\{/.test(editor), (editor.match(/aria-disabled=\{busy \|\| undefined\}/g) ?? []).length], [false, 2]);
is("a press while busy does nothing", (editor.match(/if \(busy\) return;/g) ?? []).length, 2);
is("after deleting, focus goes to Save the card, by ref after the render", [editor.includes("ref={saveButton}"), editor.includes("focusSave.current = true;"), editor.includes("saveButton.current?.focus();"), editor.includes("useEffect(() => {")], [true, true, true, true]);
is("a refusal names its field: tied to it and shown beside it (3.3.1)", [editor.includes("field.key === answer.error"), editor.includes("aria-invalid={wrong || undefined}"), editor.includes("`card-${field.key}-hint card-${field.key}-error`"), ["name", "email", "phone", "website"].every((key) => empty.includes(`id="card-${key}-error" class="field-error mt-1 block" role="alert"`)), editor.includes('{errorField ? "" : error}')], [true, true, true, true, true]);
is("each field named by its label alone, its hint read once as a description", ["name", "email", "phone", "website"].every((key) => empty.includes(`id="card-${key}"`)) && empty.includes('<label for="card-on"') && !/<label[^>]*>[^]*?id="card-on-hint"[^]*?<\/label>/.test(empty), true);
is("what was done is said once: no toast beside the status line (4.1.3)", [editor.includes("toast("), editor.includes("@/components/toast")], [false, false]);
is("a full store is said in plain words (3.1.5)", [editor.includes("data room"), editor.includes("Your store has no room left for more records. Delete some you no longer need first.")], [false, true]);
is("the preview's Save contact is dashed and says it is a preview, not a button", [full.includes('class="btn st-btn'), full.includes("border-dashed") && full.includes('<span lang="en" class="text-sm font-normal">(preview)</span>')], [false, true]);
const typed = ["+44", "20", "7946", "0000"].join(" ");
const spaced = renderToStaticMarkup(createElement(CreatorCardView, { card: { ...card, phone: typed }, handle: "anapottery", storeName: "Ana's Pottery", words: CONTACT_WORDS.en.card }));
is("a phone typed with spaces dials from its digits and +", [spaced.includes(`href="tel:${typed.replace(/ /g, "")}"`), spaced.includes(`>${typed}</a>`)], [true, true]);
is("the phone's example is still shown whole", empty.includes(`Example: ${typed}.`), true);
is("the way back to the store is at least 44px tall (2.5.5)", page.includes('class="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold" href="/@anapottery"'), true);

part("In the studio");
const studio = readFileSync("app/studio/card/page.tsx", "utf8");
is("for those who may change the store's pages, as the route", studio.includes('"page");') && readFileSync("app/api/store/creator-card/route.ts", "utf8").includes('jsonAccess(request, "page")') && readFileSync("app/api/store/creator-card/route.ts", "utf8").includes('guardStoreWrite(request, "page"'), true);
is("the link to the card is the editor's, not the page's (it follows a save or a delete)", [studio.includes("Open your card at"), editor.includes("{shown && kept ? (") && editor.includes("{`Open your card at ${address}`}")], [false, true]);
is("shown for a card kept on, not for one kept off or not kept", [draw(card).includes("Open your card at marktmorgen.com/@anapottery/contact"), draw({ ...card, on: false }).includes("Open your card at"), empty.includes("Open your card at")], [true, false, false]);
is("says whether visitors can leave their details under it, and where to turn that on", studio.includes("{contactOpen(store) ? (") && studio.includes("your store&apos;s contact form lets visitors leave their name") && studio.includes('<Link href={`${studioPath(store)}#contact`}') && studio.includes("Turn on the contact form"), true);
// Independent review of #1965: "off" is only the creator's own switch; switched on but unable to take messages (the store
// switched off, no email, sending unavailable) says so, and never offers to turn on what is already on.
is("the form said off only when its switch is off", studio.includes(") : !store.contact.on ? ("), true);
const unavailable = studio.slice(studio.indexOf("function contactUnavailableWords"), studio.indexOf("export default"));
is("switched on but unavailable: said so, with why, and no turning it on", [unavailable.includes("contact form is on, but"), unavailable.includes("is off"), unavailable.includes("Turn on"), unavailable.includes("switched off"), unavailable.includes("email address")], [true, false, false, true, true]);
is("said when it cannot be read", studio.includes("Your card could not be read just now. Nothing was changed."), true);
const site = readFileSync("app/studio/site/page.tsx", "utf8");
is("reached from Your pages, for the same people", site.includes('"page");') && site.includes('<Link href={studioPath(store, "", "card")}') && site.includes("Set up your business card"), true);

done();
