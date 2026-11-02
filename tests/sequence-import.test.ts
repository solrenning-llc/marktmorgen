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
is("a link through a click tracker: taken out, its words kept; a bare one too; an ordinary link kept", [tracked.body, tracked.trackers], ["Get it here or at and our site (https://example.com).", 2]);
is("a link that is not a web address keeps only its words", plainBody('<p><a href="javascript:alert(1)">Click</a></p>').body, "Click");
is("named characters and hex codes become the characters", plainBody("<p>&ldquo;Hi&rdquo; &hellip; &#x2014; &bogus;</p>").body, "\u201cHi\u201d \u2026 \u2014 &bogus;");
is("invisible characters are taken out", plainBody(`Hello${ZWSP} there`).body, "Hello there");

part("Another service's variables");
const vars = plainBody("Hi *|FNAME|*, thanks {{ subscriber.first_name }}.{% if vip %} VIP!{% endif %} From %SENDER%.");
is("taken out and listed, never sent as written", [vars.body, vars.variables], ["Hi , thanks . VIP! From .", ["*|FNAME|*", "{{ subscriber.first_name }}", "{% if vip %}", "{% endif %}", "%SENDER%"]]);
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
  "the rest come in, in order",
  mixed.ok ? mixed.steps.map((s) => s.subject) : mixed,
  ["Fine", "Last"],
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
is("a file too large is refused whole", readSequenceCsv("subject,body\nA,B", MAX_SEQUENCE_FILE_BYTES + 1), { ok: false, why: "size", report: [{ line: 0, column: "file", reason: "The file is larger than 500 KB. Split it, or keep the emails' text only." }] });
is(
  "no subject or body column, or no rows: refused, saying why",
  [readSequenceCsv("title\nx"), readSequenceCsv("subject,body\n")].map((r) => (r.ok ? "read" : [r.why, r.report.map((x) => x.column)])),
  [["columns", ["body"]], ["empty", ["file"]]],
);
is("a spreadsheet's semicolons are read too", (() => { const r = readSequenceCsv("subject;body\nHello;World"); return r.ok ? r.steps : r; })(), [{ delayHours: 0, subject: "Hello", body: "World" }]);

part("Nothing is sent or switched on");
const source = readFileSync("lib/sequence-import.ts", "utf8");
is("this file only reads: no email, store, Redis or network", /from "@\/lib\/(email|store|redis|flows)"|fetch\(/.test(source), false);

done();
