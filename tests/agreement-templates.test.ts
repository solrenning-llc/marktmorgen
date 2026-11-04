/**
 * Saved agreement templates (634 [GL2], unit 1; added 2 November 2026): the
 * rules, on synthetic templates only.
 */
import { MAX_TEMPLATES, MAX_TEMPLATE_NAME, TEMPLATE_FIELDS, draftFrom, templateProblem, templateProblemWords, unknownFields } from "@/lib/agreement-template-rules";
import { DRAFT_PROBLEMS, MAX_BODY, MAX_LINES, MAX_LINE_TEXT, MAX_NAME, MAX_TITLE, readDraft } from "@/lib/agreement-rules";
import { done, is, part } from "./check";

const coaching = {
  name: "Coaching, 3 months",
  kind: "agreement" as const,
  title: "Coaching for {client_name}",
  body: "{store_name} will coach {client_name} for three months, one call a week.",
  lines: [{ text: "Three months of coaching for {client_name}", quantity: 1, amount: "900" }],
};
const store = { name: "Bright Coaching" };

part("Saving a template: the same rules as an agreement");
is("a well-made template", templateProblem(coaching, 0, "usd"), null);
is("its name, for the creator", [templateProblem({ ...coaching, name: " " }, 0, "usd"), templateProblem({ ...coaching, name: "x".repeat(MAX_TEMPLATE_NAME + 1) }, 0, "usd")], [{ why: "name" }, { why: "name" }]);
is("at most so many a store keeps", [templateProblem(coaching, MAX_TEMPLATES - 1, "usd"), templateProblem(coaching, MAX_TEMPLATES, "usd")], [null, { why: "too_many" }]);
is("a line an agreement would refuse is never kept", [
  templateProblem({ ...coaching, lines: [{ text: "x", quantity: 0, amount: "1" }] }, 0, "usd"),
  templateProblem({ ...coaching, lines: [{ text: "x", quantity: 1, amount: "abc" }] }, 0, "usd"),
  templateProblem({ ...coaching, lines: [{ text: "x".repeat(MAX_LINE_TEXT + 1), quantity: 1, amount: "1" }] }, 0, "usd"),
], [{ why: "draft", problem: "line", line: 0 }, { why: "draft", problem: "amount", line: 0 }, { why: "draft", problem: "line", line: 0 }]);
is("nor a title, text or number of lines it would refuse", [templateProblem({ ...coaching, title: "x".repeat(MAX_TITLE + 1) }, 0, "usd"), templateProblem({ ...coaching, body: "x".repeat(MAX_BODY + 1) }, 0, "usd"), templateProblem({ ...coaching, lines: Array(MAX_LINES + 1).fill(coaching.lines[0]) }, 0, "usd")].map((p) => p && p.why === "draft" ? p.problem : null), ["title", "body", "lines"]);

part("Placeholders");
is("only the two, written exactly", [unknownFields("Hi {client_name}, from {store_name}"), unknownFields("Hi {name}"), unknownFields("Hi {{client_name}}"), unknownFields("Hi { Client_Name }"), unknownFields("a set {1, 2}")], [[], ["{name}"], ["{{client_name}}"], ["{ Client_Name }"], []]);
is("a brace stuck to one is refused", [unknownFields("Dear {{client_name},"), unknownFields("Dear {client_name}},")], [["{"], ["}"]]);
is("full-width braces are read as plain ones", unknownFields("Hi ｛name｝"), ["{name}"]);
is("refused saying which and where", [templateProblem({ ...coaching, title: "For {first_name}" }, 0, "usd"), templateProblem({ ...coaching, lines: [{ text: "For {client}", quantity: 1, amount: "1" }] }, 0, "usd")], [{ why: "unknown_field", found: "{first_name}", where: { part: "title" } }, { why: "unknown_field", found: "{client}", where: { part: "line", line: 1 } }]);
is("as the studio says it", templateProblemWords({ why: "unknown_field", found: "{client}", where: { part: "line", line: 1 } }), "Only {client_name} and {store_name} are replaced with real names. Check the spelling of “{client}” in line 1, or take it out.");
is("the placeholders as the studio names them", TEMPLATE_FIELDS, ["{client_name}", "{store_name}"]);
const started = Date.now();
unknownFields(`{a${" ".repeat(30)}`.repeat(400));
unknownFields("{".repeat(12_000));
is("a long text is read at once", Date.now() - started < 200, true);

part("Making an agreement from it");
const made = draftFrom(coaching, store, "  Ana   Souza ", "usd");
is("the names put in, and the client's name given back for the agreement's own name", made.ok ? [made.draft.name, made.draft.title, made.draft.body, made.draft.lines[0].text] : null, ["Ana Souza", "Coaching for Ana Souza", "Bright Coaching will coach Ana Souza for three months, one call a week.", "Three months of coaching for Ana Souza"]);
is("no name where one is put in: why, never an empty gap", [draftFrom(coaching, store, " ", "usd"), draftFrom(coaching, { name: " " }, "Ana", "usd")], [{ ok: false, problem: { why: "client_name" } }, { ok: false, problem: { why: "store_name" } }]);
is("a client's name longer than an agreement keeps", draftFrom(coaching, store, "A".repeat(MAX_NAME + 1), "usd"), { ok: false, problem: { why: "client_name_long" } });
is("a template without placeholders needs no name", draftFrom({ ...coaching, title: "Coaching", body: "Weekly calls.", lines: [] }, { name: "" }, "", "usd").ok, true);
is("a name holding a placeholder or a $ stays words, in one pass", [draftFrom(coaching, store, "{store_name}", "usd"), draftFrom(coaching, store, "Ana $& $1", "usd")].map((r) => (r.ok ? r.draft.title : null)), ["Coaching for {store_name}", "Coaching for Ana $& $1"]);
const longTitle = { ...coaching, title: `${"x".repeat(MAX_TITLE - 14)} {client_name}` };
is("a title that fits until filled past the limit: why", [templateProblem(longTitle, 0, "usd"), draftFrom(longTitle, store, "Ana Souza Lima", "usd")], [null, { ok: false, problem: { why: "draft", problem: "title" } }]);
const longLine = { ...coaching, lines: [{ text: `${"x".repeat(MAX_LINE_TEXT - 14)} {client_name}`, quantity: 1, amount: "1" }] };
is("a line filled past the limit: which line", [templateProblem(longLine, 0, "usd"), draftFrom(longLine, store, "Ana Souza Lima", "usd")], [null, { ok: false, problem: { why: "draft", problem: "line", line: 0 } }]);
is("the line said from 1", templateProblemWords({ why: "draft", problem: "line", line: 0 }), `Line 1: ${DRAFT_PROBLEMS.line}`);
const control = draftFrom({ ...coaching, body: `Hi {client${String.fromCharCode(1)}_name}` }, store, "Ana", "usd");
is("a control character inside a placeholder is taken out first, so the name is put in, never the braces", control.ok ? control.draft.body : null, "Hi Ana");
if (made.ok) {
  const read = readDraft({ ...made.draft, email: "ana@example.com", consent: true }, "usd");
  is("the draft still needs the address and the consent box, like one typed by hand", [read.ok, readDraft({ ...made.draft, email: "ana@example.com" }, "usd").ok], [true, false]);
  is("the amount read by those rules", read.ok ? read.draft.lines[0].cents : null, 90_000);
}

done();
