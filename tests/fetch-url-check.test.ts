/**
 * Addresses the server fetches (webhooks, calendars) checked in the browser
 * when their field is left (487 [IT4], pattern 1; lib/fetch-url-check.ts;
 * added 1 November 2026). The server's guard (checkUrl in lib/safe-fetch.ts)
 * stays where it is, untouched: it uses the server's own address reading and
 * decides every request the server sends out. The browser check is a part of
 * it, never more:
 *
 *   - it never refuses an address the server keeps, and keeps it the same way;
 *   - when it refuses, the server refuses too, in the same words;
 *   - an address written as a number (an IP) is left to the server, which
 *     alone says whether it is private;
 *   - webcal:// is read as the server reads it;
 *   - the length is the one each server keeps (1,000).
 */
import { readFileSync } from "node:fs";
import { CALENDAR_CHECK, HOST_ICS_CHECK, MAX_FETCH_URL, WEBHOOK_CHECK, fetchOnLeave, fetchableShape } from "@/lib/fetch-url-check";
import { SafeFetchError, checkUrl } from "@/lib/safe-fetch";
import { MAX_ENDPOINT_URL } from "@/lib/webhooks";
import { MAX_FEED_URL } from "@/lib/calendar-sync";
import { MAX_ICS_URL } from "@/lib/host-calendar";
import { done, is, part } from "./check";

const server = (raw: string): { ok: true; url: string } | { ok: false; words: string } => {
  try {
    return { ok: true, url: checkUrl(raw).toString() };
  } catch (error) {
    return { ok: false, words: error instanceof SafeFetchError ? error.message : "?" };
  }
};

part("Never more than the server");
const corpus = [
  "https://hooks.zapier.com/hooks/catch/1/abc",
  "webcal://calendar.google.com/calendar/ical/x/basic.ics",
  "webcals://p01-caldav.icloud.com/published/2/abc",
  "  https://example.com/feed.ics  ",
  "http://example.com/a",
  "ftp://example.com/a",
  "https://user:pw@example.com",
  "https://example.com:22/a",
  "https://example.com:8443/a",
  "https://example.com:443/a",
  "https://localhost/a",
  "https://printer.local/a",
  "https://intranet/a",
  "https://server.corp",
  "https://example.internal/x",
  "https://10.0.0.1/a",
  "https://8.8.8.8/a",
  "https://[::1]/a",
  "https://[2001:4860:4860::8888]/a",
  "https://0x7f.1/a",
  "https://2130706433/a",
  "https://münchen.de/kalender.ics",
  "not a url",
  "javascript:alert(1)",
  "https://example.com./a",
];
for (const raw of corpus) {
  const here = fetchableShape(raw);
  const there = server(raw);
  if (there.ok) is(`kept by the server, kept here the same: ${raw.trim()}`, here, there);
  else if (!here.ok) is(`refused here: refused there in the same words: ${raw.trim()}`, here.words, there.words);
  else is(`passed here, refused there: only ever an address written as a number: ${raw.trim()}`, here.ok && /^\[|^\d+\.\d+\.\d+\.\d+$/.test(new URL(here.url).hostname), true);
}

part("On leaving the field");
is("empty is fine; the save says what it needs", fetchOnLeave(""), { problem: null, fix: null });
is("missing https://: offered back", fetchOnLeave("hooks.zapier.com/hooks/catch/1/abc"), { problem: "This address needs https:// at the start.", fix: "https://hooks.zapier.com/hooks/catch/1/abc" });
is("http://: offered back as https://", fetchOnLeave("http://example.com/feed.ics"), { problem: "This address needs https:// at the start.", fix: "https://example.com/feed.ics" });
is("webcal:// is fine, as the server reads it", fetchOnLeave("webcal://calendar.google.com/calendar/ical/x/basic.ics").problem, null);
is("a local name: the server's words, nothing offered", fetchOnLeave("https://printer.local/a"), { problem: "That address is on a private or local network.", fix: null });
is("a port below 1024: the server's words", fetchOnLeave("https://example.com:22/a").problem, "Only port 443, or a port above 1023, is accepted.");
is("too long: said, never cut", fetchOnLeave(`https://example.com/${"a".repeat(MAX_FETCH_URL)}`).problem, "That address is too long.");
is("the length is each server's own", [MAX_FETCH_URL, MAX_ENDPOINT_URL, MAX_FEED_URL, MAX_ICS_URL], [1000, 1000, 1000, 1000]);
is("a field that must be filled says so when empty, in the server's words", [WEBHOOK_CHECK("").problem, CALENDAR_CHECK("").problem, HOST_ICS_CHECK("").problem, (server("") as { words: string }).words], ["That is not a web address.", "That is not a web address.", null, "That is not a web address."]);
for (const typed of ["http://10.0.0.1", "0x7f.1", "2130706433", "[::1]", "[::ffff:127.0.0.1]", "0", "http://8.8.8.8/x"]) {
  is(`an address written as a number is never offered back, the server alone decides: ${typed}`, fetchOnLeave(typed).fix, null);
}
is("a fix that grows too long once its letters are written out is not offered", fetchOnLeave(`example.com/${"ü".repeat(980)}`).fix, null);
is("a webhook refuses webcal://, in its server's words", WEBHOOK_CHECK("webcal://calendar.google.com/x.ics").problem, "Only https:// addresses are accepted.");
is("a calendar's too long is in its server's words", [CALENDAR_CHECK(`https://example.com/${"a".repeat(MAX_FETCH_URL)}`).problem, HOST_ICS_CHECK(`https://example.com/${"a".repeat(MAX_FETCH_URL)}`).problem], ["That address is longer than any calendar address we know of.", "That address is longer than any calendar address we know of."]);

part("The fields");
const webhook = readFileSync("components/webhook-editor.tsx", "utf8");
const calendar = readFileSync("components/calendar-editor.tsx", "utf8");
const host = readFileSync("components/host-calendar.tsx", "utf8");
is("a webhook endpoint uses it, never kept by the browser", webhook.includes('<UrlField\n            id="webhook-url"\n            autoComplete="off"') && webhook.includes("check={WEBHOOK_CHECK}"), true);
is("a calendar to read uses it, with its hint, beside its button, which keeps its height when a message shows", calendar.includes('id="calendar-url"\n              autoComplete="off"') && calendar.includes("check={CALENDAR_CHECK}") && calendar.includes('describedBy="calendar-url-hint"') && calendar.includes('wrapClassName="min-w-0 flex-1"') && calendar.includes("sm:flex-row sm:items-start"), true);
is("a host's secret calendar address uses it, never kept by the browser", host.includes('<UrlField id="host-ics"') && host.includes('autoComplete="off" value={url} onChange={setUrl} check={HOST_ICS_CHECK}') && host.includes("{ url: url.trim() }"), true);
const field = readFileSync("components/url-field.tsx", "utf8");
is("the field takes what the browser may keep, and a size for its row", field.includes('autoComplete = "url"') && field.includes("autoComplete={autoComplete}") && field.includes("return wrapClassName ? <div className={wrapClassName}>{parts}</div> : parts;"), true);
is("the server's guard is not touched", readFileSync("lib/safe-fetch.ts", "utf8").includes('const LOCAL_NAME = /(^|\\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|invalid|example|arpa)$/i;'), true);
is("and its list of local names is the same here", readFileSync("lib/fetch-url-check.ts", "utf8").includes('const LOCAL_NAME = /(^|\\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|invalid|example|arpa)$/i;'), true);
done();
