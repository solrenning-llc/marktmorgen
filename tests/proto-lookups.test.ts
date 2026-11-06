/**
 * A key from the address (?status=, ?notice=, ?discord=) picks a message only
 * when the table itself holds it: "constructor", "toString", "__proto__" and
 * the like are inherited from Object.prototype and must read as no message,
 * never as Object or Function.
 *
 *   - app/affiliate/page.tsx (?status=): rendered with each inherited name, the
 *     page is the page with no status at all;
 *   - app/studio/discord/page.tsx (?discord=), app/[handle]/sign/[agreement]
 *     (?notice=), app/[handle]/pay/[request] (?notice=) and
 *     app/[handle]/review/page.tsx (?status=, which picks the form's notice)
 *     look the key up as the table's own.
 *
 * Synthetic only; nothing is read from Redis or sent.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import AffiliateHubPage from "@/app/affiliate/page";

const INHERITED = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"];

const hub = async (query: Record<string, string>) => renderToStaticMarkup(await AffiliateHubPage({ searchParams: Promise.resolve(query) } as never));

test("the affiliate hub's own statuses still show (control)", async () => {
  const plain = await hub({});
  const sent = await hub({ status: "sent" });
  assert.notEqual(sent, plain);
  assert.ok(sent.includes("a link to your page is on its way"));
});

for (const name of INHERITED) {
  test(`the affiliate hub with ?status=${name} is the page with no status`, async () => {
    assert.equal(await hub({ status: name }), await hub({}));
  });
}

const source = (path: string) => readFileSync(path, "utf8");
const pages: [string, string, RegExp][] = [
  ["app/studio/discord/page.tsx", "?discord=", /Object\.hasOwn\(NOTICES, query\.discord\) \? NOTICES\[query\.discord\]/],
  ["app/[handle]/sign/[agreement]/page.tsx", "?notice=", /Object\.hasOwn\(w\.notices, query\.notice\) \? w\.notices\[query\.notice\]/],
  ["app/[handle]/pay/[request]/page.tsx", "?notice=", /Object\.hasOwn\(w\.notices, query\.notice\) \? w\.notices\[query\.notice\]/],
  ["app/[handle]/review/page.tsx", "?status=", /Object\.hasOwn\(REVIEW_NOTICES, status\) \? status/],
];
for (const [path, key, own] of pages) {
  test(`${path} reads ${key} only as one of its own messages`, () => {
    const text = source(path);
    assert.match(text, own);
    // No other lookup of the same table by the raw key is left beside it.
    const raw = (text.match(/(?:NOTICES|w\.notices|REVIEW_NOTICES)\[(?:query\.[a-z]+|status)\]/g) ?? []).length;
    const guarded = (text.match(/Object\.hasOwn\((?:NOTICES|w\.notices|REVIEW_NOTICES), (?:query\.[a-z]+|status)\)/g) ?? []).length;
    assert.ok(raw <= guarded, `${raw} lookups, ${guarded} guarded`);
  });
}
