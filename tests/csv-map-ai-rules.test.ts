/**
 * Which column is which, suggested by AI from the column names only
 * (lib/csv-map-ai-rules.ts). Pure; the real import fields (lib/imports.ts),
 * the real name guess (lib/csv.ts) and the real price table. Checked:
 *
 *   - the fields are the imports' own, kind by kind;
 *   - no cell of any row ever reaches the request, and a name that looks like
 *     someone's data goes as "Column N";
 *   - the model is asked only when the guess left a field open and a column
 *     is free;
 *   - the call's most is worked out before it, at the widest request, from the
 *     price table; an unknown model refuses, never zero;
 *   - an answer in any other shape is set aside whole;
 *   - the guess from the names wins, the model only fills the rest, and
 *     nothing is confirmed.
 */
import {
  MAP_FIELDS, MAP_MODEL, MAP_OUTPUT_TOKENS, MAX_COLUMNS, NAME_MAX, type MapRequest, clearHeader, labelLike, looksLikeData, mapHoldMicroUsd, mapRequest,
  needsModel, readMapAnswer, requestOf, requestShape, safeHeader, suggestedMapping,
} from "@/lib/csv-map-ai-rules";
import { COLUMNS } from "@/lib/imports";
import { guessColumn, parseCsv } from "@/lib/csv";
import { ANSWER_MICRO_USD, aiRequestHoldMicroUsd } from "@/lib/spend-cost-table";
import { done, is, part } from "./check";

part("The fields are the imports' own");
is("each import, each field, in order", Object.fromEntries(Object.entries(MAP_FIELDS).map(([k, v]) => [k, Object.keys(v)])), COLUMNS);

part("Only the names go, never a cell");
const file = "Correo,Nombre completo,Opt-in status\nana.example@mail.test,Ana Pérez,yes\n";
const read = parseCsv(file);
const req = mapRequest("contacts", read.header) as MapRequest;
is("a clear header: a request", req !== null, true);
is("the names are in the request", ["Correo", "Nombre completo", "Opt-in status"].every((n) => req.prompt.includes(n)), true);
is("no cell of the row below is", ["ana.example", "Ana Pérez", "mail.test"].some((c) => req.prompt.includes(c) || req.system.includes(c)), false);
is("a header that is someone's data (a file with no header) goes as Column N", safeHeader(["ana.example@mail.test", "Row 88213377", "https://shop.test/p/1", "Name", ""]), { names: ["Column 1", "Column 2", "Column 3", "Name", "Column 5"], hidden: [0, 1, 2] });
is("and such a first row sends nothing at all", mapRequest("contacts", ["ana.example@mail.test", "Name"]), null);

part("A file with no header: its first row is a person, and nothing is sent (review of #3555)");
const person = parseCsv("Ana Pérez,Fortaleza,1990-04-12,49.00,yes\nBen Ortiz,Recife,1988-01-30,19.00,no\n");
is("a fictitious person's row as the header: not a header, no request", [clearHeader(person.header), mapRequest("contacts", person.header)], [false, null]);
is(
  "each cell of it alone already stops it: a name, a city, a date, an amount, a yes",
  ["Ana Pérez", "Fortaleza", "1990-04-12", "49.00", "yes", "Maria da Silva", "Rua das Flores", "$49", "John"].map((cell) => clearHeader(["Email", cell])),
  [false, false, false, false, false, false, false, false, false],
);
is("one data cell among real labels: nothing sent", mapRequest("contacts", ["Email", "Name", "ana.example@mail.test"]), null);
is(
  "real headers, in the languages files come in, and identifiers, are clear",
  [["Email", "First name", "Tags"], ["Correo", "Nombre completo", "Opt-in status"], ["e_mail", "firstName", "opt_in"], ["Courriel", "Prénom"], ["E-Mail-Adresse", "Vorname"], ["Nome", "Telefone", "Cidade"], ["Email", ""]].map(clearHeader),
  [true, true, true, true, true, true, true],
);
is("nothing named at all: not a header", [clearHeader([]), clearHeader(["", " "])], [false, false]);
is("label-like, one by one", ["Subscriber", "Opt-in status", "Order date", "Ana", "Fortaleza", "Column 2", "Address 2"].map(labelLike), [true, true, true, false, false, true, true]);
is("what looks like data", ["a@b", "www.x.test", "12345678", "Order 123456", "Email", "Phone", "Zip 60"].map(looksLikeData), [true, true, true, true, false, false, false]);
is("control characters out, names cut, at most the columns sent", [safeHeader(["E\u0000mail\n"]).names[0], Array.from(safeHeader(["x".repeat(200)]).names[0]).length, safeHeader(Array.from({ length: 90 }, (_, i) => `c${String.fromCharCode(97 + (i % 26))}`)).names.length], ["E mail", NAME_MAX, MAX_COLUMNS]);

part("The model is asked only when needed");
const names = (h: string[]) => ({ email: guessColumn(h, ["email", "e-mail"]), name: guessColumn(h, ["name"]), tags: guessColumn(h, ["tags"]), consent: guessColumn(h, ["consent"]) });
is("a file the names read whole: not asked", needsModel("contacts", names(["Email", "Name", "Tags", "Consent"]), 4), false);
is("a field left open, a column free: asked", needsModel("contacts", names(read.header), read.header.length), true);
is("a field open but every column used: not asked", needsModel("contacts", { email: 0, name: 1, tags: -1, consent: -1 }, 2), false);

part("The most, before the call");
const shape = requestShape();
is("the widest request: every column at the longest name, 4 bytes a character", shape.inputBytes > MAX_COLUMNS * NAME_MAX * 4, true);
const fits = (h: string[]) => (["contacts", "products", "purchases", "members"] as const).every((k) => { const r = requestOf(k, h); return new TextEncoder().encode(r.system + r.prompt).length <= shape.inputBytes; });
is(
  "names JSON writes longer (lone surrogate halves, quotes, backslashes) still fit, at the most columns",
  [fits(Array(MAX_COLUMNS).fill("\uD800".repeat(NAME_MAX))), fits(Array(MAX_COLUMNS).fill("\uDC00".repeat(NAME_MAX))), fits(Array(MAX_COLUMNS).fill('"\\'.repeat(NAME_MAX)))],
  [true, true, true],
);
is("and every real request fits in it",["contacts", "products", "purchases", "members"].every((k) => { const r = mapRequest(k as "contacts", read.header) as MapRequest; return new TextEncoder().encode(r.system + r.prompt).length <= shape.inputBytes; }), true);
const hold = mapHoldMicroUsd();
is("held at that shape, from the price table, on the answering model", [hold, MAP_MODEL, shape.maxTokens], [aiRequestHoldMicroUsd(MAP_MODEL, shape), "claude-haiku-5-5", MAP_OUTPUT_TOKENS]);
is("no more than a few answers' worth", (hold as number) < ANSWER_MICRO_USD * 5 && (hold as number) > 0, true);
is("a model with no price: null, never zero", mapHoldMicroUsd("gpt-x"), null);

part("The answer, in one exact shape or set aside");
is("a good answer", readMapAnswer("contacts", 3, '{"email":0,"name":1,"tags":null,"consent":2}'), { email: 0, name: 1, tags: -1, consent: 2 });
is(
  "anything else is set aside whole",
  [
    "not json", "[0,1]", '{"email":0}', '{"email":0,"name":1,"tags":null,"consent":2,"password":3}', '{"email":0,"name":0,"tags":null,"consent":null}',
    '{"email":3,"name":null,"tags":null,"consent":null}', '{"email":-1,"name":null,"tags":null,"consent":null}', '{"email":"0","name":null,"tags":null,"consent":null}', '{"email":0.5,"name":null,"tags":null,"consent":null}',
    'Sure! {"email":0,"name":1,"tags":null,"consent":2}',
  ].map((t) => readMapAnswer("contacts", 3, t)),
  Array(10).fill(null),
);

part("The names win; the model fills the rest; nothing is confirmed");
const guess = names(read.header);
const answer = readMapAnswer("contacts", 3, '{"email":0,"name":1,"tags":null,"consent":2}');
const mapped = suggestedMapping("contacts", { ...guess, name: 1 }, { ...(answer as Record<string, number>), name: 2 });
is(
  "name from the names, email and consent from the model, tags none, not confirmed",
  mapped,
  { columns: { email: { column: 0, from: "ai" }, name: { column: 1, from: "name" }, tags: { column: -1, from: "none" }, consent: { column: 2, from: "ai" } }, confirmed: false },
);
is("a set-aside answer leaves only the names' guess", suggestedMapping("contacts", { email: 0, name: -1, tags: -1, consent: -1 }, null).columns, { email: { column: 0, from: "name" }, name: { column: -1, from: "none" }, tags: { column: -1, from: "none" }, consent: { column: -1, from: "none" } });
is("the model never takes a column the names already gave", suggestedMapping("contacts", { email: 0, name: -1, tags: -1, consent: -1 }, { email: -1, name: 0, tags: -1, consent: -1 }).columns.name, { column: -1, from: "none" });

done();
