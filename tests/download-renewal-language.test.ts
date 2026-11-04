import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextRequest } from "next/server";
import { paidDownloadGet, paidDownloadRenewalPost } from "@/app/api/store/download/route";
import { setLanguage } from "@/lib/store";
import { ordersWords } from "@/lib/buyer-words/orders";
import { renewalFixture, request, formFields } from "./single-digital-access-renewal-world";

const copies = {
  en: ["Request a new download link", "Email a new link", "Your request is saved", "This download link could not be checked."],
  es: ["Solicita un nuevo enlace de descarga", "Enviar un nuevo enlace por email", "Tu solicitud está guardada", "No hemos podido comprobar este enlace de descarga."],
  fr: ["Demandez un nouveau lien de téléchargement", "Recevoir un nouveau lien par email", "Votre demande est enregistrée", "Ce lien de téléchargement n’a pas pu être vérifié."],
  de: ["Neuen Download-Link anfordern", "Neuen Link per E-Mail senden", "Deine Anfrage ist gespeichert", "Dieser Download-Link konnte nicht geprüft werden."],
  it: ["Richiedi un nuovo link per scaricare", "Invia un nuovo link via email", "La tua richiesta è stata salvata", "Non è stato possibile verificare questo link per scaricare."],
  nl: ["Vraag een nieuwe downloadlink aan", "Een nieuwe link e-mailen", "Je verzoek is opgeslagen", "Deze downloadlink kon niet worden gecontroleerd."],
  pt: ["Peça uma nova ligação para descarregar", "Enviar uma nova ligação por email", "O seu pedido foi guardado", "Não foi possível verificar esta ligação para descarregar."],
} as const;

for (const [language, [title, button, saved, invalid]] of Object.entries(copies)) {
  test(`actual download renewal GET and POST use the store's ${language} words and HTML language`, async () => {
    const f = await renewalFixture();
    await setLanguage(f.store.email, language);
    const form = await paidDownloadGet({ nextUrl: f.url, headers: new Headers() } as NextRequest, f.runtime);
    assert.equal(form.status, 200);
    const html = await form.text();
    assert.ok(html.includes(`<html lang="${language}">`), html);
    assert.ok(html.includes(`<h1>${title}</h1>`), html);
    assert.ok(html.includes(`<button type="submit">${button}</button>`), html);
    assert.equal(html.includes(f.email), false);
    const fields = formFields(html);
    assert.deepEqual([...fields.keys()].sort(), ["handle", "origin", "request"], "the language hint adds no authorized form field");
    const action = new URL(html.match(/<form[^>]*action="([^"]+)"/)![1].replace(/&amp;/g, "&"), f.url);
    assert.equal(action.searchParams.get("language"), language);
    const response = await paidDownloadRenewalPost(request(action, fields), f.runtime);
    assert.equal(response.status, 200);
    const confirmation = await response.text();
    assert.ok(confirmation.includes(`<html lang="${language}">`), confirmation);
    assert.ok(confirmation.includes(`<h1>${saved}</h1>`), confirmation);
    assert.equal(confirmation.includes(f.email), false);
    if (language !== "en") {
      assert.equal(html.includes("A new link can be emailed"), false);
      assert.equal(confirmation.includes("A new link will be emailed"), false);
    }
    f.session.payment_intent.latest_charge.refunded = true;
    f.session.payment_intent.latest_charge.amount_refunded = 3500;
    const gone = await paidDownloadGet({ nextUrl: f.url, headers: new Headers() } as NextRequest, f.runtime);
    assert.equal(gone.status, 410);
    const goneText = await gone.text();
    assert.equal(goneText.includes("<form"), false);
    const postGone = await paidDownloadRenewalPost(request(action, fields), f.runtime);
    assert.equal(postGone.status, 410);
    assert.equal(await postGone.text(), goneText);
    if (language !== "en") assert.equal(goneText.includes("This purchase"), false);
    globalThis.fetch = async () => { throw Error("SYNTHETIC_PROVIDER_UNAVAILABLE"); };
    const unavailable = await paidDownloadGet({ nextUrl: f.url, headers: new Headers() } as NextRequest, f.runtime);
    assert.equal(unavailable.status, 503);
    assert.equal(await unavailable.text(), ordersWords(language).downloadProblems.purchaseCheckFailed);
    const retry = await paidDownloadRenewalPost(request(action, fields), f.runtime);
    assert.equal(retry.status, 503);
    if (language !== "en") assert.equal((await retry.text()).includes("A new link cannot be requested"), false);
    // The sixth request for this address reaches the existing request limit.
    await paidDownloadRenewalPost(request(action, fields), f.runtime);
    await paidDownloadRenewalPost(request(action, fields), f.runtime);
    const limited = await paidDownloadRenewalPost(request(action, fields), f.runtime);
    assert.equal(limited.status, 429);
    if (language !== "en") assert.equal((await limited.text()).includes("Please wait"), false);
    fields.set("origin", `${fields.get("origin")}corrupt`);
    const rejected = await paidDownloadRenewalPost(request(action, fields), f.runtime);
    assert.equal(rejected.status, 404);
    assert.equal(await rejected.text(), invalid);
  });
}

test("renewal funding and cross-site guards reject before reading the form or looking up a store", async () => {
  const f = await renewalFixture();
  const r = request(f.url, new URLSearchParams());
  Object.defineProperty(r, "body", { get: () => { throw Error("The form must not be read"); } });
  assert.equal((await paidDownloadRenewalPost(r)).status, 503, "the production default NULL policy rejects before reading a body");
  assert.equal((await paidDownloadRenewalPost(r, { ...f.runtime, policy: null })).status, 503);
  assert.equal((await paidDownloadRenewalPost(request(f.url, new URLSearchParams(), "https://elsewhere.test"), f.runtime)).status, 403);
});

const guardCopies = {
  en: ["This request must come from this site.", "Please use the download link's form.", "This request could not be read.", "This request is incomplete.", "We could not find this store.", "A new link cannot be requested right now. Please try again later."],
  es: ["Esta solicitud debe proceder de este sitio.", "Usa el formulario del enlace de descarga.", "No hemos podido leer esta solicitud.", "Esta solicitud está incompleta.", "No hemos podido encontrar esta tienda.", "Ahora no se puede solicitar un nuevo enlace. Inténtalo de nuevo más tarde."],
  fr: ["Cette demande doit provenir de ce site.", "Veuillez utiliser le formulaire du lien de téléchargement.", "Cette demande n’a pas pu être lue.", "Cette demande est incomplète.", "Cette boutique est introuvable.", "Impossible de demander un nouveau lien pour le moment. Veuillez réessayer plus tard."],
  de: ["Diese Anfrage muss von dieser Website kommen.", "Bitte nutze das Formular des Download-Links.", "Diese Anfrage konnte nicht gelesen werden.", "Diese Anfrage ist unvollständig.", "Dieser Shop wurde nicht gefunden.", "Ein neuer Link kann gerade nicht angefordert werden. Bitte versuche es später erneut."],
  it: ["Questa richiesta deve provenire da questo sito.", "Usa il modulo del link per scaricare.", "Non è stato possibile leggere questa richiesta.", "Questa richiesta è incompleta.", "Non è stato possibile trovare questo negozio.", "Al momento non è possibile richiedere un nuovo link. Riprova più tardi."],
  nl: ["Dit verzoek moet van deze website komen.", "Gebruik het formulier van de downloadlink.", "Dit verzoek kon niet worden gelezen.", "Dit verzoek is onvolledig.", "We konden deze winkel niet vinden.", "Je kunt nu geen nieuwe link aanvragen. Probeer het later opnieuw."],
  pt: ["Este pedido tem de ser feito a partir deste site.", "Utilize o formulário da ligação para descarregar.", "Não foi possível ler este pedido.", "Este pedido está incompleto.", "Não foi possível encontrar esta loja.", "Não é possível pedir uma nova ligação neste momento. Tente novamente mais tarde."],
} as const;

for (const [language, [sameSite, badForm, unreadable, incomplete, missingStore, unavailable]] of Object.entries(guardCopies)) {
  test(`real ${language} form action keeps every early guard in the store's language`, async () => {
    const f = await renewalFixture();
    await setLanguage(f.store.email, language);
    const html = await (await paidDownloadGet({ nextUrl: f.url, headers: new Headers() } as NextRequest, f.runtime)).text();
    const action = new URL(html.match(/<form[^>]*action="([^"]+)"/)![1].replace(/&amp;/g, "&"), f.url);
    const fields = formFields(html);
    // Supply the hint directly too: this catches untranslated guards independently of the form action assertion.
    action.searchParams.set("language", language);
    const crossSite = request(action, fields, "https://elsewhere.test");
    Object.defineProperty(crossSite, "body", { get: () => { throw Error("CSRF must reject before reading the form"); } });
    const crossSiteResponse = await paidDownloadRenewalPost(crossSite, f.runtime);
    assert.equal(crossSiteResponse.status, 403); assert.equal(await crossSiteResponse.text(), sameSite);
    const unfunded = request(action, fields);
    Object.defineProperty(unfunded, "body", { get: () => { throw Error("NULL policy must reject before reading the form"); } });
    for (const runtime of [undefined, { ...f.runtime, policy: null }]) {
      const response = await paidDownloadRenewalPost(unfunded, runtime);
      assert.equal(response.status, 503); assert.equal(await response.text(), unavailable);
    }
    const wrongForm = request(action, fields); wrongForm.headers.set("content-type", "application/json");
    const wrongFormResponse = await paidDownloadRenewalPost(wrongForm, f.runtime);
    assert.equal(wrongFormResponse.status, 415); assert.equal(await wrongFormResponse.text(), badForm);
    const oversized = request(action, fields); oversized.headers.set("content-length", "16385");
    const oversizedResponse = await paidDownloadRenewalPost(oversized, f.runtime);
    assert.equal(oversizedResponse.status, 400); assert.equal(await oversizedResponse.text(), unreadable);
    for (const malformed of [new URLSearchParams(), new URLSearchParams({ ...Object.fromEntries(fields), request: "invalid" })]) {
      const response = await paidDownloadRenewalPost(request(action, malformed), f.runtime);
      assert.equal(response.status, 400); assert.equal(await response.text(), incomplete);
    }
    fields.set("handle", "synthetic-missing-store");
    const missing = await paidDownloadRenewalPost(request(action, fields), f.runtime);
    assert.equal(missing.status, 404); assert.equal(await missing.text(), missingStore);
    assert.equal(f.gets.length, 1, "early guard errors do not look up payment");
  });
}

test("invalid or absent language hints fall back to English and a loaded store overrides a mismatched hint", async () => {
  const f = await renewalFixture();
  await setLanguage(f.store.email, "pt");
  const fields = new URLSearchParams({ handle: f.store.handle, origin: f.url.searchParams.get("origin")!, request: "b".repeat(64) });
  for (const hint of [null, "hi", '<img src=x onerror=alert(1)>']) {
    const action = new URL(f.url); if (hint !== null) action.searchParams.set("language", hint);
    const response = await paidDownloadRenewalPost(request(action, fields, "https://elsewhere.test"), f.runtime);
    assert.equal(response.status, 403); assert.equal(await response.text(), guardCopies.en[0]);
  }
  const action = new URL(f.url); action.searchParams.set("language", "fr");
  const saved = await paidDownloadRenewalPost(request(action, fields), f.runtime);
  assert.equal(saved.status, 200); assert.match(await saved.text(), /<html lang="pt">/);
  fields.set("origin", `${fields.get("origin")}corrupt`);
  const denied = await paidDownloadRenewalPost(request(action, fields), f.runtime);
  assert.equal(denied.status, 404); assert.equal(await denied.text(), copies.pt[3]);
});

import { enqueueSingleDigitalRenewal } from "@/lib/order-confirmation-outbox";
import { seal } from "@/lib/secret-box";
import { metadataHash } from "./single-digital-access-targeted-world";
import { store as redis } from "./redis-stub";
import { tokenKeys } from "./single-digital-access-renewal-world";

const capacityCopies = {
  en: "There is no capacity for another pending download link request. Your request has not been saved, and no email has been scheduled. Contact the store for help.",
  es: "No hay capacidad para otra solicitud de enlace de descarga pendiente. Tu solicitud no se ha guardado y no se ha programado ningún email. Contacta con la tienda para obtener ayuda.",
  fr: "La capacité disponible ne permet pas d’ajouter une demande de lien de téléchargement en attente. Votre demande n’a pas été enregistrée et aucun email n’a été programmé. Contactez la boutique pour obtenir de l’aide.",
  de: "Für eine weitere ausstehende Download-Link-Anfrage ist keine Kapazität verfügbar. Deine Anfrage wurde nicht gespeichert und es wurde keine E-Mail eingeplant. Bitte wende dich an den Shop.",
  it: "Non è disponibile capacità per un’altra richiesta di link per scaricare in attesa. La tua richiesta non è stata salvata e non è stata programmata alcuna email. Contatta il negozio per assistenza.",
  nl: "Er is geen capaciteit voor nog een openstaande aanvraag voor een downloadlink. Je verzoek is niet opgeslagen en er is geen e-mail ingepland. Neem contact op met de winkel voor hulp.",
  pt: "Não há capacidade para mais um pedido pendente de ligação para descarregar. O seu pedido não foi guardado e não foi programado nenhum email. Contacte a loja para obter ajuda.",
} as const;

for (const [language, expected] of Object.entries(capacityCopies)) {
  test(`full renewal capacity tells the ${language} buyer that no request or email was saved`, async () => {
    const f = await renewalFixture(); await setLanguage(f.store.email, language);
    const capsules = Array.from({ length: 9 }, (_, i) => {
      const sessionId = `cs_test_LanguageCapacity${i}00000001`, email = `capacity${i}@example.test`;
      const metadata = { ...f.session.metadata, mm_order_intent: String(i+100).padStart(64, "0") };
      f.sessions.set(sessionId, { ...structuredClone(f.session), id: sessionId, metadata, customer_details: { email } });
      return seal(JSON.stringify({ ...f.capsule, sessionId, email, metadataHash: metadataHash(metadata) }), "single-digital-access|v1");
    });
    const ids = new Set<string>();
    for (let i=0; i<8; i++) {
      const queued = await enqueueSingleDigitalRenewal(f.store, capsules[i], String(i+1).padStart(64, "0"), f.runtime);
      assert.ok(queued.ok, "eight independently verified paid buyers have their own pending slots"); ids.add(queued.id);
    }
    assert.equal(ids.size, 8);
    const beforeRows = [...redis.keys()].filter(k => k.startsWith("nl:order-confirmation:row:")).length;
    const beforePosts = f.calls.filter(c => c.method === "POST").length;
    const fields = new URLSearchParams({ handle: f.store.handle, origin: capsules[8], request: "f".repeat(64) });
    const response = await paidDownloadRenewalPost(request(f.url, fields), f.runtime);
    assert.equal(response.status, 503); assert.equal(await response.text(), expected);
    assert.equal([...redis.keys()].filter(k => k.startsWith("nl:order-confirmation:row:")).length, beforeRows);
    assert.equal(f.calls.filter(c => c.method === "POST").length, beforePosts);
    assert.equal(tokenKeys().length, 0);
    const refused = await enqueueSingleDigitalRenewal(f.store, capsules[8], "e".repeat(64), f.runtime);
    assert.deepEqual(refused, { ok: false, reason: "capacity" });
    fields.set("origin", capsules[0]); fields.set("request", "d".repeat(64));
    const duplicate = await paidDownloadRenewalPost(request(f.url, fields), f.runtime);
    assert.equal(duplicate.status, 200, "the already saved request remains deduplicated when the store is full");
  });
}


test("renewal form reader decodes each HTML entity exactly once", () => {
  const fields = formFields('<input type="hidden" name="origin" value="&amp;quot;"><input type="hidden" name="request" value="&quot;&amp;">');
  assert.equal(fields.get("origin"), "&quot;");
  assert.equal(fields.get("request"), '\"&');
});
