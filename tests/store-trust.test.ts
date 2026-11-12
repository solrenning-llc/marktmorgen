/**
 * "About this store" on a store page (94 [D2-BUYER-TRUST], unit 2;
 * lib/store-trust.ts, components/store-trust-card.tsx, StoreLook.since,
 * app/api/store/look and components/look-editor.tsx; added 12 November 2026).
 * Checked:
 *
 *   - the line is the month and year of the store record's createdAt, in the
 *     store's language, never anything typed; a record with no date, a date
 *     that cannot be read or one still to come shows nothing;
 *   - it is off unless the creator turns it on: a look saved before the field
 *     existed reads as off, and only an explicit true turns it on;
 *   - saving the look through the real route turns it on and off, and a save
 *     that leaves it unsaid keeps the choice already made;
 *   - the card is a section named by its heading, with a list, each fact a
 *     sentence and its source in words, no image and no icon; no fact is no
 *     card at all;
 *   - the store page draws the card and the studio's look editor has a labeled
 *     checkbox for it (read in their source);
 *   - every language names the card, the line and its source, and the line
 *     says "open", never "selling" or "verified", which the record cannot prove.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { TRUST_WORDS, openedMonth, trustFacts } from "@/lib/store-trust";
import { StoreTrustCard } from "@/components/store-trust-card";
import { parseLook } from "@/lib/store-look";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { claimHandle, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as lookRoute } from "@/app/api/store/look/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.parse("2026-11-12T15:00:00Z");

async function main(): Promise<void> {
  redis.clear();

  part("The rule");
  is("the month and year of the record, in English", openedMonth("2025-03-04T10:00:00.000Z", "en", NOW), "March 2025");
  is("in the store's language", [openedMonth("2025-03-04T10:00:00.000Z", "de", NOW), openedMonth("2025-03-04T10:00:00.000Z", "fr", NOW)], ["März 2025", "mars 2025"]);
  is("read in UTC, as the record is written", openedMonth("2025-03-31T23:30:00.000Z", "en", NOW), "March 2025");
  is(
    "nothing for no date, an unreadable one, one still to come or not text",
    [openedMonth("", "en", NOW), openedMonth("soon", "en", NOW), openedMonth("2026-12-01T00:00:00.000Z", "en", NOW), openedMonth(1700000000000, "en", NOW), openedMonth(undefined, "en", NOW)],
    [null, null, null, null, null],
  );
  const store = (since: boolean | undefined, createdAt: unknown = "2025-03-04T10:00:00.000Z", language = "en") => ({ createdAt, language, look: { since } });
  is("off: no fact", trustFacts(store(false), NOW), []);
  is("left unset: no fact", trustFacts(store(undefined), NOW), []);
  is("on: the line and its source", trustFacts(store(true), NOW), [{ key: "since", text: "Open on Marktmorgen since March 2025", source: "From Marktmorgen's records, not typed by the creator." }]);
  is("on, but the record has no date: no fact rather than a guess", trustFacts(store(true, ""), NOW), []);

  part("The look");
  is("a look saved before the field existed reads as off", parseLook({ theme: "light", accent: "#5a36ee", badge: true, sold: true }).since, false);
  is("only an explicit true turns it on", [parseLook({ since: true }).since, parseLook({ since: "yes" }).since, parseLook({ since: 1 }).since], [true, false, false]);

  part("Saving it through the studio's route");
  const owner = "trust@example.com";
  await claimHandle(owner, "trustshop", "Trust Shop", "");
  const session = await openSession(owner);
  const before = (await storeForEmail(owner))!;
  is("a new store starts with it off", before.look.since, false);
  const post = async (body: Record<string, unknown>) =>
    lookRoute(new NextRequest("https://marktmorgen.com/api/store/look", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const base = { theme: before.look.theme, accent: before.look.accent, badge: true, sold: false, font: before.look.font, backdrop: before.look.backdrop };
  let response = await post({ ...base, since: true });
  let data = (await response.json()) as { ok?: boolean; look?: { since?: boolean } };
  is("turned on: saved and answered", [response.status, data.ok, data.look?.since, (await storeForEmail(owner))!.look.since], [200, true, true, true]);
  response = await post({ ...base });
  data = (await response.json()) as { ok?: boolean; look?: { since?: boolean } };
  is("a save that leaves it unsaid keeps the choice", [response.status, data.look?.since, (await storeForEmail(owner))!.look.since], [200, true, true]);
  response = await post({ ...base, since: false });
  is("turned off", [response.status, (await storeForEmail(owner))!.look.since], [200, false]);
  response = await post({ ...base, since: "yes" });
  is("anything but a true or a false keeps the choice", [response.status, (await storeForEmail(owner))!.look.since], [200, false]);

  part("The card");
  const html = renderToStaticMarkup(createElement(StoreTrustCard, { store: store(true, "2024-07-09T08:00:00.000Z") }));
  is("a section named by its heading", html.includes('<section') && html.includes('aria-labelledby="store-trust"') && html.includes('<h2 id="store-trust"'), true);
  is("each fact an item of a list, with its source in words", html.includes("<ul") && html.includes("<li") && html.includes("Open on Marktmorgen since July 2024") && html.includes("From Marktmorgen&#x27;s records, not typed by the creator."), true);
  is("no image, no icon, no seal", /<img|<svg|role="img"/.test(html), false);
  is("no fact, no card", renderToStaticMarkup(createElement(StoreTrustCard, { store: store(false) })), "");
  is("the card is in the store's language", renderToStaticMarkup(createElement(StoreTrustCard, { store: store(true, "2024-07-09T08:00:00.000Z", "es") })).includes("Abierta en Marktmorgen desde julio de 2024"), true);

  part("Where it is drawn and set");
  const page = readFileSync("app/[handle]/page.tsx", "utf8");
  is("the store page draws the card", page.includes("<StoreTrustCard store={store} />"), true);
  const editor = readFileSync("components/look-editor.tsx", "utf8");
  is("the look editor has a checkbox for it, inside a fieldset with a legend", editor.includes("checked={since}") && editor.includes("How long your store has been open"), true);
  is("the look editor sends it and undoes it", editor.includes("badge, sold, since, font, backdrop") && editor.includes("setSince(look.since === true);"), true);

  part("Every language");
  for (const code of LANGUAGE_CODES) {
    const w = TRUST_WORDS[code];
    const line = w.since("X");
    is(`${code}: a heading, a line with the month and a source`, Boolean(w.heading && line.includes("X") && line.includes("Marktmorgen") && w.sinceSource.includes("Marktmorgen")), true);
  }
  const all = JSON.stringify(Object.values(TRUST_WORDS).map((w) => [w.heading, w.since("X"), w.sinceSource]));
  is("never says selling, verified or guaranteed, which the record cannot prove", /sell|verif|guarant|vend|vérif|verkauf|geprüf|garant|verkoop|geverifieerd/i.test(all), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
