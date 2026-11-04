/**
 * A sequence brought in from a simple file (544 [SQ9], unit 1;
 * lib/sequence-import.ts; added 2 November 2026). Synthetic files only.
 * Checked:
 *
 *   - the template's columns, and other services' names for them, are read;
 *     the emails come in the file's order, or by its order column when every
 *     row has one; a wait is whole days, from 0 to a year;
 *   - HTML is read as text: paragraphs, breaks and lists kept, a link kept
 *     as its words and its address; scripts, styles, images, pixels and
 *     comments taken out; a link through another service's click tracker
 *     taken out, as an address in a plain body too;
 *   - another service's variables are taken out and listed, never sent as
 *     written, from the subject and the body;
 *   - each row left out or changed is reported by line, column and reason;
 *     preview text is reported, not kept; the rest come in;
 *   - at most twenty emails; a file too large, with no subject or body
 *     column, or with no rows, is refused whole and says why;
 *   - nothing is sent or switched on: this only reads.
 */
import { readFileSync } from "node:fs";
import { MAX_SEQUENCE_FILE_BYTES, SEQUENCE_TEMPLATE, plainBody, readSequenceCsv } from "@/lib/sequence-import";
import { SEQUENCE_BODY_MAX, SEQUENCE_SUBJECT_MAX } from "@/lib/sequence-template";
import { MAX_MAIL_BODY, MAX_SUBJECT } from "@/lib/mail";
import { done, is, part } from "./check";

const csv = (rows: string[][]) => rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
const ZWSP = String.fromCharCode(0x200b);

part("The template");
is("its columns, in order", [...SEQUENCE_TEMPLATE], ["order", "days_after", "subject", "preview", "body"]);
const plain = readSequenceCsv(csv([["order", "days_after", "subject", "preview", "body"], ["1", "0", "Welcome", "", "Hello and welcome.\n\nHere is the guide."], ["2", "2", "Day two", "", "A second note."], ["3", "5", "Day five", "", "A third note."]]));
is(
  "three emails, their waits in hours, their words as written, nothing reported",
  plain.ok ? [plain.steps, plain.report] : plain,
  [[{ delayHours: 0, subject: "Welcome", body: "Hello and welcome.\n\nHere is the guide." }, { delayHours: 48, subject: "Day two", body: "A second note." }, { delayHours: 120, subject: "Day five", body: "A third note." }], []],
);
const named = readSequenceCsv(csv([["Step", "Delay (days)", "Subject line", "Preheader", "Content"], ["2", "1", "Second", "", "Two."], ["1", "", "First", "", "One."]]));
is("other services' names for the columns; ordered by the order column; an empty wait is none", named.ok ? named.steps.map((s) => [s.subject, s.delayHours]) : named, [["First", 0], ["Second", 24]]);
const unordered = readSequenceCsv(csv([["order", "subject", "body"], ["2", "B", "b"], ["", "A", "a"]]));
is("an order column with a gap: the order of the rows, said", unordered.ok ? [unordered.steps.map((s) => s.subject), unordered.report.map((r) => r.column)] : unordered, [["B", "A"], ["order"]]);

part("HTML read as text");
const html = plainBody(
  '<html><head><title>x</title><style>p{color:red}</style></head><body><!-- hidden --><p>Hi there,</p><p>Read <a href="https://example.com/guide">the guide</a>.<br>Thanks!</p><ul><li>One</li><li>Two</li></ul><img src="https://example.com/pixel.gif" width="1" height="1"><script>alert(1)</script><p>&copy; 2026 &amp; more &#8212; done</p></body></html>',
);
is(
  "paragraphs, breaks and a list kept; the link as its words and address; nothing of the markup",
  html.body,
  "Hi there,\n\nRead the guide (https://example.com/guide).\nThanks!\n\n- One\n- Two\n\n\u00a9 2026 & more \u2014 done",
);
is("the image (a pixel) counted as taken out; no script, style, title or comment kept", [html.images, /alert|color:red|hidden|<|>/.test(html.body.replace(/ \(https[^)]+\)/, ""))], [1, false]);
const tracked = plainBody('<p>Get it <a href="https://bela.us1.list-manage.com/track/click?u=1">here</a> or at https://ck.page/abc and <a href="https://example.com">our site</a>.</p>');
is("a link through a click tracker: taken out, its words kept; a service's landing page is an ordinary link", [tracked.body, tracked.trackers], ["Get it here or at https://ck.page/abc and our site (https://example.com).", 1]);
is("a bare tracker address and one with a trailing dot are taken out", [plainBody("See https://ct.sendgrid.net/ls/click?x=1 now").body, plainBody('<a href="https://us1.list-manage.com./t">Go</a>').body], ["See now", "Go"]);
is("an unquoted link keeps its address", plainBody("<p><a href=https://example.com/x>Read</a></p>").body, "Read (https://example.com/x)");
is("a > inside a quoted attribute is not the end of the tag: nothing of it leaks", plainBody('<img alt="a>b" src="https://x.example/p.gif">After').body, "After");
is("the HTML's own line breaks are spaces; only its breaks and paragraphs are new lines", plainBody("<p>Hello\n      world</p><p>Again</p>").body, "Hello world\n\nAgain");
is("a link that is not a web address keeps only its words", plainBody('<p><a href="javascript:alert(1)">Click</a></p>').body, "Click");
is("named characters and hex codes become the characters", plainBody("<p>&ldquo;Hi&rdquo; &hellip; &#x2014; &bogus;</p>").body, "\u201cHi\u201d \u2026 \u2014 &bogus;");
is("invisible characters are taken out", plainBody(`Hello${ZWSP} there`).body, "Hello there");

part("Another service's variables");
const vars = plainBody("Hi *|FNAME|*, thanks {{ subscriber.first_name }}.{% if vip %} VIP!{% endif %} From %SENDER% and {$name}.");
is("taken out and listed, never sent as written", [vars.body, vars.variables], ["Hi , thanks . VIP! From and .", ["*|FNAME|*", "{{ subscriber.first_name }}", "{% if vip %}", "{% endif %}", "%SENDER%", "{$name}"]]);
const unsub = plainBody('<p><a href="*|UNSUB|*">Unsubscribe</a> or <a href="{$unsubscribe}">Stop</a></p>');
is("a variable as a link's address: the link keeps only its words, and the variable is listed", [unsub.body, unsub.variables], ["Unsubscribe or Stop", ["*|UNSUB|*", "{$unsubscribe}"]]);
const subjectVar = readSequenceCsv(csv([["subject", "body"], ["Hi {{ first_name }}, welcome", "Body"]]));
is("from the subject too, and reported for the creator to read the sentence around it", subjectVar.ok ? [subjectVar.steps[0].subject, subjectVar.report[0].reason.includes("{{ first_name }}")] : subjectVar, ["Hi , welcome", true]);

part("The report");
const mixed = readSequenceCsv(
  csv([
    ["order", "days_after", "subject", "preview", "body"],
    ["1", "0", "Fine", "A preview", "Fine body"],
    ["2", "1.5", "Half a day", "", "Body"],
    ["3", "2", "", "", "No subject"],
    ["4", "3", "No body", "", "<p><img src='x.gif'></p>"],
    ["5", "400", "Too late", "", "Body"],
    ["6", "4", "x".repeat(151), "", "Body"],
    ["7", "5", "Last", "", "Last body"],
  ]),
);
is(
  "the rest come in, in order; the waits of the rows left out are added to the next email's, so it keeps its day",
  mixed.ok ? mixed.steps.map((s) => [s.subject, s.delayHours]) : mixed,
  [["Fine", 0], ["Last", 14 * 24]],
);
is(
  "each left out or changed by line, column and reason",
  mixed.ok ? mixed.report.map((r) => [r.line, r.column]) : mixed,
  [[2, "preview"], [3, "days_after"], [4, "subject"], [5, "body"], [6, "days_after"], [7, "subject"]],
);
is("the reasons are plain words", mixed.ok ? mixed.report.every((r) => r.reason.length > 20 && /\.$/.test(r.reason)) : mixed, true);

part("Limits");
const many = readSequenceCsv(csv([["subject", "body"], ...Array.from({ length: 22 }, (_, i) => [`Email ${i + 1}`, "Body"])]));
is("at most twenty emails; the rest reported", many.ok ? [many.steps.length, many.report.filter((r) => /at most 20 emails/.test(r.reason)).length] : many, [20, 2]);
is("a file too large is refused whole", readSequenceCsv("subject,body\nA,B", MAX_SEQUENCE_FILE_BYTES + 1), { ok: false, why: "size", report: [{ line: 0, column: "file", reason: "The file is larger than 150 KB. Split it into two sequences, or keep the emails' text only." }] });
const none = readSequenceCsv("subject,body\nA,\nB,");
is("a file where no email could be kept is refused, with each reason", none.ok ? none : [none.why, none.report.length, none.report.at(-1)?.reason], ["empty", 3, "No email in the file could be brought in."]);
is(
  "no subject or body column, or no rows: refused, saying why",
  [readSequenceCsv("title\nx"), readSequenceCsv("subject,body\n")].map((r) => (r.ok ? "read" : [r.why, r.report.map((x) => x.column)])),
  [["columns", ["body"]], ["empty", ["file"]]],
);
is("a spreadsheet's semicolons are read too", (() => { const r = readSequenceCsv("subject;body\nHello;World"); return r.ok ? r.steps : r; })(), [{ delayHours: 0, subject: "Hello", body: "World" }]);

part("The subject, the columns and the order");
const subject = readSequenceCsv(csv([["subject", "body"], [`&lt;b&gt;Hi&lt;/b&gt; &amp; <i>you</i>${String.fromCharCode(0x202e)}`, "Body"]]));
is("the subject is one plain line: references read, markup and reordering characters taken out", subject.ok ? subject.steps[0].subject : subject, "<b>Hi</b> & you");
const both = readSequenceCsv(csv([["title", "subject", "body"], ["Not this", "This", "Body"]]));
is("the template's own column name comes before another service's", both.ok ? both.steps[0].subject : both, "This");
const odd = readSequenceCsv(csv([["order", "subject", "body"], ["1e1", "A", "a"], ["2", "B", "b"]]));
is("an order that is not a plain whole number keeps the rows' order", odd.ok ? odd.steps.map((s) => s.subject) : odd, ["A", "B"]);

part("Time in proportion to the size");
const at = Date.now();
plainBody('<p><a href="https://e.com">x '.repeat(5_000));
plainBody("<a".repeat(60_000));
plainBody(`<p>${"<".repeat(60_000)}</p>`);
readSequenceCsv(csv([["subject", "body"], ["S", '<a href="https://e.com">x '.repeat(4_000)]]));
is("a file of unclosed links or stray brackets at the size limit is read in well under two seconds", Date.now() - at < 2_000, true);

part("Nothing is sent or switched on");
const source = readFileSync("lib/sequence-import.ts", "utf8");
is(
  "this file only reads, from pure modules: no email, store, Redis or network",
  [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]),
  ["@/lib/csv", "@/lib/flow-limits", "@/lib/flow-rules", "@/lib/sequence-template"],
);
is("and the limits it reads are the mail's own", [SEQUENCE_SUBJECT_MAX, SEQUENCE_BODY_MAX], [MAX_SUBJECT, MAX_MAIL_BODY]);

done();
