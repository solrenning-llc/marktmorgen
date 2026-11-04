/**
 * A web address checked when the person leaves the field (487 [IT4],
 * pattern 1; added 1 November 2026; lib/url-check.ts,
 * components/url-field.tsx). Checked:
 *
 *   - the check is the server's own reading (readLink in lib/product-link.ts),
 *     so the field never passes what the save refuses, or refuses what it keeps;
 *   - an empty optional field is fine;
 *   - an address missing https:// is offered back with it, in one press,
 *     only when that makes it one the server keeps; an http:// one too;
 *   - nothing is said while the person is still typing: only after they
 *     leave the field, and the message goes as soon as the address is right;
 *   - the message is tied to the field (aria-describedby, aria-invalid) and
 *     the fix is a real button at least 44 px tall;
 *   - the lesson link in the course editor uses it, with a visible label.
 */
import { readFileSync } from "node:fs";
import { checkWith, linkOnLeave, roomOnLeave } from "@/lib/url-check";
import { MAX_CHAT_URL, chatKind } from "@/lib/chat-kind";
import { MAX_REVIEW_URL, parseReviewElsewhere } from "@/lib/review-elsewhere";
import { readReport } from "@/lib/takedown-rules";
import { MAX_ROOM_LENGTH, cleanRoom } from "@/lib/call-setup";
import { readLink, LINK_PROBLEMS } from "@/lib/product-link";
import { done, is, part } from "./check";

part("The check");
is("empty is fine in an optional field", linkOnLeave(""), { problem: null, fix: null });
is("a good address is fine", linkOnLeave("https://notion.so/my-course"), { problem: null, fix: null });
is("missing https://: said, with the address offered back with it", linkOnLeave("notion.so/my-course"), { problem: "This address needs https:// at the start.", fix: "https://notion.so/my-course" });
is("http://: offered back as https://", linkOnLeave("http://example.com/page"), { problem: "This address needs https:// at the start.", fix: "https://example.com/page" });
is("spaces around it are not a problem", linkOnLeave("  https://example.com  ").problem, null);
is("something no prefix can save: the server's own words, no fix", linkOnLeave("my course"), { problem: LINK_PROBLEMS.shape, fix: null });
is("a local address: why it is refused, never offered back", linkOnLeave("localhost:3000"), { problem: LINK_PROBLEMS.host, fix: null });
is("a password in it: the server's words", linkOnLeave("https://me:secret@example.com").problem, LINK_PROBLEMS.credentials);
is("another kind of address (mailto:) is not taken for a password", linkOnLeave("mailto:a@b.com"), { problem: LINK_PROBLEMS.scheme, fix: null });
is("a port is not a scheme: offered back with https://", linkOnLeave("example.com:8080/x"), { problem: "This address needs https:// at the start.", fix: "https://example.com:8080/x" });
is("too long is said, never cut", linkOnLeave(`https://example.com/${"a".repeat(2_000)}`).problem, LINK_PROBLEMS.long);
const route = readFileSync("app/api/store/course/route.ts", "utf8");
is("the server reads one past the length kept, so too long is refused, not cut", route.includes("text(body.link, MAX_LINK_LENGTH + 1)"), true);
for (const typed of ["notion.so/x", "http://example.com", "https://example.com", "my course", "https://10.0.0.1/a", "ftp://example.com", "https://me:pw@example.com", ""]) {
  const leave = linkOnLeave(typed);
  const server = typed.trim() ? readLink(typed) : null;
  is(`"${typed}": passes here exactly when the server keeps it`, leave.problem === null, server === null || server.ok);
  if (leave.fix) is(`"${typed}": what is offered is kept by the server`, readLink(leave.fix).ok, true);
}

part("The field");
const field = readFileSync("components/url-field.tsx", "utf8");
is("said when the field is left or its form is sent, never while typing", field.includes("onBlur={() => check(value)}") && field.includes('form.addEventListener("submit", onSubmit, true)') && !field.slice(field.indexOf("onChange={(e)"), field.indexOf("onBlur=")).includes("check("), true);
is("while typing, a message only goes away, when the address is right; a new one waits for the next leave", field.includes("if (said && !reading.current(next).problem) setSaid(null);"), true);
is("tied to the field, and marked invalid only while said", field.includes("aria-invalid={said ? true : undefined}") && field.includes("aria-describedby="), true);
is("the fix is a button at least 44 px tall that puts the address in, offered only for the address it came from", field.includes('type="button"') && field.includes("min-h-11") && field.includes("onChange(fix)") && field.includes("said && said.value === value ? said.fix : null"), true);
is("after the fix the focus goes back to the field, never to the page", field.includes("input.current?.focus();"), true);
is("no browser bubble in other words, and no silent cut of a long address", field.includes('type="text"') && field.includes('inputMode="url"') && !field.includes("maxLength"), true);
is("the message is announced", field.includes('role="status"'), true);
is("the message has an icon beside its words, so it is not told by color alone", field.includes('<Icon name="alert" size={18} className="mt-0.5 shrink-0" />'), true);
const course = readFileSync("components/course-editor.tsx", "utf8");
is("the lesson link uses it, with a visible label tied by its id", course.includes("<UrlField") && /htmlFor=\{`\$\{prefix\}-link`\}/.test(course) && course.includes("id={`${prefix}-link`}"), true);
const product = readFileSync("components/product-editor.tsx", "utf8");
is("a product's link uses it too, with its help tied to it", product.includes("<UrlField") && product.includes("describedBy={`link-${target.id}-help`}") && product.includes('<p id={`link-${target.id}-help`}'), true);
is("and its route refuses a long link rather than cutting it", readFileSync("app/api/store/product/route.ts", "utf8").includes("text(body.link, MAX_LINK_LENGTH + 1)"), true);
const links = readFileSync("components/link-editor.tsx", "utf8");
is("a store link uses it too, with its help tied to it", links.includes("<UrlField") && links.includes('describedBy="link-url-help"') && links.includes('<p id="link-url-help"'), true);
is("and its route refuses a long link rather than cutting it", readFileSync("app/api/store/links/route.ts", "utf8").includes("text(body.url, MAX_LINK_LENGTH + 1)"), true);
part("A meeting link, by the reading calls and events keep");
const room = roomOnLeave("The meeting link has to be a full web address starting with https://.");
is("a good room is fine, empty too", [room("https://zoom.us/j/123").problem, room("").problem], [null, null]);
is("missing https://: offered back, as cleanRoom keeps it", room("meet.google.com/abc-defg-hij"), { problem: "This address needs https:// at the start.", fix: "https://meet.google.com/abc-defg-hij" });
is("anything else: the editor's own words, no fix", room("my zoom"), { problem: "The meeting link has to be a full web address starting with https://.", fix: null });
for (const typed of ["zoom.us/j/1", "http://whereby.com/me", "https://meet.google.com/x", "zoom", "ftp://x.com", "https://zoom.us/j/1?pwd=abc"]) {
  const kept = cleanRoom(typed);
  is(`"${typed.slice(0, 30)}": passes here exactly when cleanRoom keeps it`, room(typed).problem === null, typeof kept === "string" && kept !== "bad");
  const fix = room(typed).fix;
  if (fix) is(`"${typed.slice(0, 30)}": what is offered, cleanRoom keeps`, cleanRoom(fix) === fix, true);
}
is("a room longer than the server keeps whole is said too long before it is cut", room(`https://zoom.us/${"a".repeat(MAX_ROOM_LENGTH)}`).problem, LINK_PROBLEMS.long);
is("measured as stored too: letters written out longer can take it past the length", room(`https://zoom.us/j/${"é".repeat(200)}`).problem, LINK_PROBLEMS.long);
is("the server's reading of stored links is left as it was", readFileSync("lib/call-setup.ts", "utf8").includes("const text = raw.trim().slice(0, MAX_ROOM_LENGTH);"), true);
const call = readFileSync("components/call-editor.tsx", "utf8");
is("a call's meeting links use it, each with a visible label tied by id", (call.match(/<UrlField/g) ?? []).length === 2 && call.includes("check={ROOM_CHECK}") && call.includes("check={SESSION_ROOM_CHECK}") && call.includes("htmlFor={`call-${product.id}-room`}") && call.includes("htmlFor={`call-${product.id}-session-${index}-room`}"), true);
const events = readFileSync("components/community-events-studio.tsx", "utf8");
is("a community event's link uses it", events.includes("<UrlField") && events.includes("check={LINK_CHECK}"), true);
is("and an empty one is said there, since it is required", events.includes('const LINK_CHECK: LinkCheck = (raw) => (raw.trim() ? ROOM_CHECK(raw) : { problem: MESSAGES.link, fix: null });'), true);
part("A notice's page address, by the reading the notice is held to");
const reportForm = readFileSync("components/report-form.tsx", "utf8");
is("the report form's page address uses it, required, with its help tied to it", reportForm.includes('<UrlField id="report-url"') && reportForm.includes("check={REPORT_URL_CHECK}") && reportForm.includes('describedBy="report-url-help"') && reportForm.includes('<p id="report-url-help"'), true);
is("a notice whose address the field refuses is not sent, and the focus goes to the field", reportForm.includes('if (REPORT_URL_CHECK(fields.url).problem) {') && reportForm.includes('document.getElementById("report-url")?.focus();'), true);
const longReport = readReport({ kind: "other", url: `https://marktmorgen.com/@x/${"a".repeat(600)}`, work: "x".repeat(40), name: "Jo Doe", email: "jo@example.org", contact: "Somewhere 1", signature: "Jo Doe", goodFaith: true, accurate: true });
is("the server refuses an address longer than it keeps, never cuts it", longReport.ok ? "kept" : longReport.problem, "url");
is("it is held to the same pattern as readReport", reportForm.includes("/^https?:\\/\\/\\S+$/i.test(raw)") && readFileSync("lib/takedown-rules.ts", "utf8").includes("if (!/^https?:\\/\\/\\S+$/i.test(report.url))"), true);
part("A chat's webhook address, by the reading the server posts with");
const chat = checkWith((raw) => (chatKind(raw) ? raw.trim() : null), "not a chat", MAX_CHAT_URL);
is("a Slack address missing https:// is offered back", chat("hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXX").fix, "https://hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXX");
is("another address is the editor's words, nothing offered", chat("https://example.com/hook"), { problem: "not a chat", fix: null });
is("the longest address either chat takes fits", ["https://hooks.slack.com/services/" + "a".repeat(200), "https://discordapp.com/api/webhooks/" + "1".repeat(30) + "/" + "a".repeat(200)].every((u) => chatKind(u) !== null && u.length <= MAX_CHAT_URL), true);
const chatEditor = readFileSync("components/chat-summary-editor.tsx", "utf8");
is("the chat summary's address uses it, by chatKind, never kept by the browser", chatEditor.includes('<UrlField\n            id="chat-summary-url"') && chatEditor.includes("check={CHAT_CHECK}") && chatEditor.includes('autoComplete="off"') && chatEditor.includes("chatKind(raw) ? raw.trim() : null"), true);
is("neither an empty address (it would stop the posting) nor one the server refuses is sent: each try counts in the hour", chatEditor.includes("if (url.trim() && !CHAT_CHECK(url).problem) save(url.trim());"), true);
is("the chat is named by the same reading, never by a word in the address", chatEditor.includes('setKind(answer.result === "saved" ? chatKind(value) : null);') && !chatEditor.includes('value.includes("slack")'), true);
is("its buttons line up with the field, not with the message under it", chatEditor.includes('className="mt-1 flex flex-wrap items-start gap-2 text-sm"') && chatEditor.includes('wrapClassName="min-w-0 flex-1"'), true);
is("the server reads it with the same function", readFileSync("lib/chat-summary.ts", "utf8").includes('import { type ChatKind, chatKind } from "@/lib/chat-kind";'), true);
part("A public review page, by the reading the server keeps");
const elsewhere = checkWith((raw) => parseReviewElsewhere(raw)?.url ?? null, "not a review page", MAX_REVIEW_URL);
is("a Trustpilot page missing https:// is offered back as the server keeps it", elsewhere("www.trustpilot.com/review/harborkitchen.com").fix, parseReviewElsewhere("https://www.trustpilot.com/review/harborkitchen.com")?.url ?? "none");
is("a page elsewhere is the editor's words, nothing offered", elsewhere("https://example.com/reviews"), { problem: "not a review page", fix: null });
const reviewStudio = readFileSync("components/review-studio.tsx", "utf8");
is("a refused review page is said once, beside the field, with the focus taken there", reviewStudio.includes('const field = document.getElementById("ask-elsewhere");') && reviewStudio.includes("else setError(MESSAGES.elsewhere);"), true);
is("the review page field uses it, optional, with its note tied to it", reviewStudio.includes('<UrlField\n            id="ask-elsewhere"') && reviewStudio.includes("check={ELSEWHERE_CHECK}") && reviewStudio.includes('describedBy="ask-elsewhere-note"'), true);
done();
