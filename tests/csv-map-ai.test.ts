/**
 * An AI suggestion of which column is which, wired (unit 2; lib/csv-map-ai.ts,
 * app/api/store/import-columns, components/import-column-suggest.tsx).
 * Synthetic store, model replaced; the real rules, request bounds and price
 * table. Checked:
 *
 *   - nothing is asked when the names already matched, or the writing help
 *     is off, and the model is never called then;
 *   - the request is the rules' own, names only, and the money askModel
 *     reserves for it (from its real request bounds) is never more than the
 *     ceiling the rules priced, even at the widest file;
 *   - the live call is askModel, which reserves before the provider is asked
 *     (tests/ai-spend-provider.test.ts holds that path);
 *   - a failed, thrown or malformed answer suggests nothing; a good one only
 *     fills what the names left open;
 *   - the route takes the import permission, stops while a renewal is unpaid,
 *     is rate-limited, and reads only names and the guess;
 *   - the screen applies nothing by itself: each column is used only by the
 *     creator's own press, and a field they set meanwhile is not suggested over.
 */
import { readFileSync } from "node:fs";
import { isMapKind, readGuess, readHeader, suggestColumns, type SuggestDeps } from "@/lib/csv-map-ai";
import { MAP_MODEL, MAX_COLUMNS, NAME_MAX, type MapRequest, mapHoldMicroUsd, mapRequest, requestOf } from "@/lib/csv-map-ai-rules";
import { boundedAiRequest } from "@/lib/ai-request-rules";
import { aiRequestHoldMicroUsd } from "@/lib/spend-cost-table";
import { AGENT_COVERAGE } from "@/lib/agent-coverage";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

const store = { statsId: "s1", sid: "s1", tier: "pro" } as unknown as Store;
type Call = { system: string; prompt: string; maxTokens: number; model: string };
function deps(answer: string | null | Error, available = true): SuggestDeps & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    available: () => available,
    ask: async (_s, system, prompt, maxTokens, model) => {
      calls.push({ system, prompt, maxTokens, model });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}
const header = ["Correo", "Nombre completo", "Opt-in status"];
const open = { email: -1, name: -1, tags: -1, consent: -1 };

async function main(): Promise<void> {
  part("Asked only when needed, and only when the writing help is on");
  const whole = deps('{"email":0,"name":1,"tags":null,"consent":2}');
  is("the names matched every field: nothing asked", [await suggestColumns(store, "contacts", ["Email", "Name", "Tags", "Consent"], { email: 0, name: 1, tags: 2, consent: 3 }, whole), whole.calls.length], [{ ok: false, why: "not_needed" }, 0]);
  const off = deps('{"email":0,"name":1,"tags":null,"consent":2}', false);
  is("the writing help is off (no paid Studio or Scale, or not funded): nothing asked", [await suggestColumns(store, "contacts", header, open, off), off.calls.length], [{ ok: false, why: "off" }, 0]);

  part("A file with no header: its first row is a person, and nothing is sent (review of #3555)");
  const nobody = deps('{"email":0,"name":1,"tags":null,"consent":2}');
  is(
    "a fictitious person's row as the header: no call at all, and the screen says why",
    [await suggestColumns(store, "contacts", ["ana.example@mail.test", "Ana Pérez", "yes"], open, nobody), await suggestColumns(store, "contacts", ["Ana Pérez", "Fortaleza", "1990-04-12"], open, nobody), nobody.calls.length, readFileSync("components/import-column-suggest.tsx", "utf8").includes("no_header:")],
    [{ ok: false, why: "no_header" }, { ok: false, why: "no_header" }, 0, true],
  );

  part("The request, and the money reserved for it");
  const good = deps('{"email":0,"name":1,"tags":null,"consent":2}');
  const got = await suggestColumns(store, "contacts", header, { ...open, name: 1 }, good);
  const want = mapRequest("contacts", header) as MapRequest;
  is("one call, the rules' own request, on the priced model", [good.calls.length, good.calls[0]], [1, { system: want.system, prompt: want.prompt, maxTokens: want.maxTokens, model: MAP_MODEL }]);
  is(
    "what askModel would reserve for it, from its own request bounds, is within the priced ceiling",
    (() => { const b = boundedAiRequest(want.system, want.prompt, want.maxTokens, MAP_MODEL); return b.ok ? (aiRequestHoldMicroUsd(MAP_MODEL, b.shape) as number) <= (mapHoldMicroUsd() as number) : false; })(),
    true,
  );
  const widest = requestOf("members", Array(MAX_COLUMNS).fill("\u{10FFFF}".repeat(NAME_MAX)));
  is(
    "even for the widest file the names can make",
    (() => { const b = boundedAiRequest(widest.system, widest.prompt, widest.maxTokens, MAP_MODEL); return b.ok ? (aiRequestHoldMicroUsd(MAP_MODEL, b.shape) as number) <= (mapHoldMicroUsd() as number) : false; })(),
    true,
  );
  const lib = readFileSync("lib/csv-map-ai.ts", "utf8");
  is("the live call is askModel (reserved in the store's AI budget before the provider), and the help's own switch", lib.includes("const LIVE: SuggestDeps = { ask: askModel, available: aiAvailableFor };"), true);

  part("What comes back");
  is(
    "a good answer only fills what the names left open (the names gave name: column 1)",
    got,
    { ok: true, columns: { email: { column: 0, from: "ai" }, name: { column: 1, from: "name" }, tags: { column: -1, from: "none" }, consent: { column: 2, from: "ai" } } },
  );
  is("no answer: nothing suggested", await suggestColumns(store, "contacts", header, open, deps(null)), { ok: false, why: "failed" });
  is("a call that throws: nothing suggested, nothing thrown", await suggestColumns(store, "contacts", header, open, deps(new Error("lost"))), { ok: false, why: "failed" });
  is("an answer in another shape: set aside", await suggestColumns(store, "contacts", header, open, deps('Sure: {"email":0}')), { ok: false, why: "unreadable" });
  is("an answer naming a column the file does not have: set aside", await suggestColumns(store, "contacts", header, open, deps('{"email":7,"name":null,"tags":null,"consent":null}')), { ok: false, why: "unreadable" });

  part("What the route takes");
  is("the kinds", [isMapKind("contacts"), isMapKind("members"), isMapKind("constructor"), isMapKind(3)], [true, true, false, false]);
  is("a header is a list of names", [readHeader(header), readHeader([]), readHeader("Email"), readHeader([1]), readHeader(Array(501).fill("x")), readHeader(["x".repeat(1_001)])], [header, null, null, null, null, null]);
  is("a guess has every field, each a column of the file or -1", [readGuess("contacts", open, 3), readGuess("contacts", { email: 0 }, 3), readGuess("contacts", { ...open, email: 3 }, 3), readGuess("contacts", { ...open, email: "0" }, 3), readGuess("contacts", { ...open, password: 1 }, 3)], [open, null, null, null, null]);
  const route = readFileSync("app/api/store/import-columns/route.ts", "utf8");
  is(
    "the import permission, stopped while a renewal is unpaid, rate-limited, names and guess only",
    [route.includes('guardStoreWrite(request, "import", MAX_BODY_BYTES'), route.includes("costPauseCode(store)"), route.includes('withinLimit("import-columns", store.sid, 10, 600)'), /body\.(rows|row|cells|file)\b/.test(route)],
    [true, true, true, false],
  );
  is("the agent coverage names it, never to be an agent's tool", AGENT_COVERAGE["POST store/import-columns"]?.reach.kind, "never");

  part("The screen applies nothing by itself");
  const ui = readFileSync("components/import-column-suggest.tsx", "utf8");
  is("each column is used only by the creator's press on it", [(ui.match(/onUse\(/g) ?? []).length, ui.includes("if (use && s) {\n      onUse(field, s.column);"), ui.includes("Use this column"), ui.includes("Not this one")], [1, true, true, true]);
  is("a field set meanwhile is not suggested over", ui.includes("suggestions.filter((s) => (mapping[s.field] ?? -1) < 0"), true);
  is("it says only names are sent, and that nothing changes until each is chosen", [ui.includes("Only the column names are sent, never what is in the rows."), ui.includes("Nothing changes until you choose")], [true, true]);
  is("it sends names and the guess, nothing else", ui.includes("body: JSON.stringify({ kind, header, guess })"), true);
  is("a status region tells what happened; every suggestion says it is from AI", [ui.includes('role="status"'), ui.includes("suggested by AI, not checked yet")], [true, true]);
  is("buttons are buttons, with names that say what they do", [ui.includes('type="button" onClick={ask}'), ui.includes("aria-label={`Use the column")], [true, true]);
}

main().then(done);
