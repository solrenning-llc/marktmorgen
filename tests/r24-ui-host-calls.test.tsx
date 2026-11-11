/**
 * VR 2, rule 24: the team calls a host hosts are said only when read (components/host-calendar.tsx;
 * app/studio/calendar/page.tsx). Before: a read of the store's calls or teams that failed became an empty list, and
 * the page told the host "None yet. The store's owner or an Editor adds you as a host", which may be false. Now the
 * page hands `null` and the section says in words that it could not be read. A known empty list still says "None
 * yet"; a known list still names the calls.
 *
 * Real component, rendered on the server; synthetic view.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HostCalendar } from "@/components/host-calendar";
import type { HostCalendarView } from "@/lib/host-calendar";

const view: HostCalendarView = {
  email: "host@example.com",
  source: "none",
  googleOffered: false,
  google: null,
  calendars: null,
  calendarsError: "",
  read: [],
  write: "",
  ics: null,
  sync: { state: "none", lastSuccess: 0, message: "", blocked: false },
};
const render = (hosting: string[] | null) => renderToStaticMarkup(createElement(HostCalendar, { view, pin: "", tz: "UTC", hosting: hosting as never }));
const UNREAD = /We could not read which team calls you host just now\./;

test("hosting not read: said in words, never \"None yet\"", () => {
  let html = "";
  assert.doesNotThrow(() => (html = render(null)));
  assert.match(html, UNREAD);
  assert.doesNotMatch(html, /None yet/);
});

test("a known empty list still says None yet", () => {
  const html = render([]);
  assert.match(html, /None yet/);
  assert.doesNotMatch(html, UNREAD);
});

test("a known list names the calls", () => {
  const html = render(["Weekly coaching"]);
  assert.match(html, /Weekly coaching/);
  assert.doesNotMatch(html, UNREAD);
});

test("the page hands null on a failed read, never an empty list", async () => {
  const source = (await import("node:fs")).readFileSync("app/studio/calendar/page.tsx", "utf8");
  assert.doesNotMatch(source, /readKind\(store, "call"\)\.catch\(\(\) => \[\]\)/);
});
