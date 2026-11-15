/**
 * 568 [GD2] (i), unit 1: no store is made without its owner's yes to "at least 18".
 *
 * The Terms say a person must be at least 18, or the age of majority where they live, to use the Services, and
 * until now nothing asked. Checked here, with the real route on the in-memory database and a real session:
 *
 *   - the rule alone (lib/adult-confirmation.ts): only exactly `true` with exactly the current version is a yes;
 *     "on", "true", 1, a missing or another version are not (unknown is never a yes); a kept yes read back from a
 *     record is kept only when it is whole, and anything else in the field reads as no yes;
 *   - the route (app/api/store/claim): without the yes it answers "adult" and makes no store, holds no address and
 *     writes nothing; with it the first store, and then another store, are made and each keeps the yes with its
 *     version and an ISO time, read back the same from the database;
 *   - the form (components/handle-form.tsx): the box starts unchecked, is marked required, says ADULT_SENTENCE in
 *     its own label, points to its note, and sends the current version; the error is shown by the box.
 *
 * Synthetic data only: no real person, account or message.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { accountStores, storeForEmail, storeForHandle } from "@/lib/store";
import { ADULT_SENTENCE, ADULT_VERSION, adultFrom, readAdult } from "@/lib/adult-confirmation";
import { HandleForm } from "@/components/handle-form";
import { POST as claim } from "@/app/api/store/claim/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ORIGIN = "https://marktmorgen.com";
const OWNER = "adult.box@example.com";
const NOW = new Date("2026-11-15T19:00:00.000Z");

const post = (session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}/api/store/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, host: "marktmorgen.com", "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE}=${session}` },
    body: JSON.stringify(body),
  });
const answer = async (response: Response) => {
  const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return [response.status, data.ok === true ? "ok" : data.error ?? "?"];
};
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function main(): Promise<void> {
  part("The rule alone");
  is("the current version is 1 and the words match the Terms' age", [ADULT_VERSION, ADULT_SENTENCE.includes("at least 18"), ADULT_SENTENCE.includes("age of majority")], [1, true, true]);
  is("exactly true with the current version is a yes, at the time given", adultFrom({ adult: true, adultVersion: ADULT_VERSION }, NOW), { version: 1, at: "2026-11-15T19:00:00.000Z" });
  const noes: Array<Record<string, unknown>> = [
    {},
    { adult: true },
    { adultVersion: ADULT_VERSION },
    { adult: false, adultVersion: ADULT_VERSION },
    { adult: "on", adultVersion: ADULT_VERSION },
    { adult: "true", adultVersion: ADULT_VERSION },
    { adult: 1, adultVersion: ADULT_VERSION },
    { adult: true, adultVersion: 0 },
    { adult: true, adultVersion: ADULT_VERSION + 1 },
    { adult: true, adultVersion: "1" },
  ];
  is("anything else is no yes", noes.map((body) => adultFrom(body, NOW)), noes.map(() => null));
  is("a whole kept yes reads back", readAdult({ version: 1, at: "2026-11-15T19:00:00.000Z" }), { version: 1, at: "2026-11-15T19:00:00.000Z" });
  const junk: unknown[] = [null, undefined, true, "yes", [], { version: 1 }, { at: "2026-11-15T19:00:00.000Z" }, { version: 0, at: "2026-11-15T19:00:00.000Z" }, { version: 1.5, at: "2026-11-15T19:00:00.000Z" }, { version: "1", at: "2026-11-15T19:00:00.000Z" }, { version: 1, at: "yesterday" }, { version: 1, at: "2026-13-45T99:99:99Z" }];
  is("anything else in the field reads as no yes", junk.map(readAdult), junk.map(() => null));

  part("The route makes no store without the yes");
  redis.clear();
  const session = await openSession(OWNER);
  const refusals = [
    { handle: "adultbox", name: "Adult Box" },
    { handle: "adultbox", name: "Adult Box", adult: "on", adultVersion: ADULT_VERSION },
    { handle: "adultbox", name: "Adult Box", adult: true, adultVersion: ADULT_VERSION - 1 },
    { handle: "adultbox", name: "Adult Box", adult: true },
  ];
  const refused = [];
  for (const body of refusals) refused.push(await answer(await claim(post(session, body))));
  is("each is refused with \"adult\"", refused, refusals.map(() => [400, "adult"]));
  is("no store was made and the address is still free", [await storeForEmail(OWNER), await storeForHandle("adultbox")], [null, null]);

  part("With the yes, the store keeps it");
  const made = await answer(await claim(post(session, { handle: "adultbox", name: "Adult Box", adult: true, adultVersion: ADULT_VERSION })));
  is("the first store is made", made, [200, "ok"]);
  const first = await storeForEmail(OWNER);
  is("it keeps the yes with the version and an ISO time, read back from the database", [first?.adultConfirmed?.version, ISO.test(first?.adultConfirmed?.at ?? "")], [1, true]);

  const anotherRefused = await answer(await claim(post(session, { handle: "adultbox2", name: "Adult Box 2", another: true })));
  is("another store without the yes is refused too", anotherRefused, [400, "adult"]);
  is("and holds no address", await storeForHandle("adultbox2"), null);
  const another = await answer(await claim(post(session, { handle: "adultbox2", name: "Adult Box 2", another: true, adult: true, adultVersion: ADULT_VERSION })));
  is("another store with the yes is made", another, [200, "ok"]);
  const stores = await accountStores(OWNER);
  const second = stores.find((s) => s.handle === "adultbox2");
  is("and keeps its own yes", [second?.extra, second?.adultConfirmed?.version, ISO.test(second?.adultConfirmed?.at ?? "")], [true, 1, true]);

  part("The form");
  const html = renderToStaticMarkup(createElement(HandleForm));
  const box = /<input[^>]*id="store-adult"[^>]*>/.exec(html)?.[0] ?? "";
  is("the box is a checkbox named adult, required and unchecked", [/type="checkbox"/.test(box), /name="adult"/.test(box), / required=""/.test(box), / checked=""/.test(box)], [true, true, true, false]);
  is("its own label holds the sentence", html.includes(`<label for="store-adult"`) && html.includes(`<span>${ADULT_SENTENCE}</span>`), true);
  is("it points to its note, which links to the Terms", [/aria-describedby="store-adult-note"/.test(box), /id="store-adult-note"[^>]*>[^]*href="\/terms"/.test(html)], [true, true]);
  is("no error is shown before anything is sent", html.includes("store-adult-missing"), false);
  const source = readFileSync("components/handle-form.tsx", "utf8");
  is("the form sends exactly true with the current version, and has the route's error", [source.includes("adult: true, adultVersion: ADULT_VERSION"), /adult: "Check the box/.test(source)], [true, true]);
  const stop = /if \(!adult\) \{[^]*?adultBox\.current\?\.focus\(\);\s*return;/.exec(source);
  is("an unchecked box stops the form before any request, focusing the box", stop !== null && stop.index < source.indexOf("await fetch("), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
