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
 *     (tests/ai-spend-provider.test.ts holds that path), inside counted: each
 *     ask takes one of the month's writing jobs before the model is called,
 *     and a month whose jobs are used up asks nothing (out-of-family review
 *     of #3559 at c720cc496a, MEDIUM 1; run here with the real counted);
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
import { aiMonthKey, counted } from "@/lib/ai";
import { AI_MONTHLY } from "@/lib/ai-rules";
import { redisPipeline } from "@/lib/redis";
import type { Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const store = { statsId: "s1", sid: "s1", tier: "pro" } as unknown as Store;
type Call = { system: string; prompt: string; maxTokens: number; model: string };
/** The month's job, as counted takes it: refused ("used", "off") before the run, or the run's text. */
function deps(answer: string | null | Error, available = true, refuse: "used" | "off" | null = null): SuggestDeps & { calls: Call[]; counts: number } {
  const calls: Call[] = [];
  const out = {
    calls,
    counts: 0,
    available: () => available,
    count: async (_s: Store, _n: number, run: () => Promise<string | null>) => {
      out.counts++;
      if (refuse) return { ok: false as const, reason: refuse };
      const value = await run().catch(() => null);
      return value === null ? { ok: false as const, reason: "failed" as const } : { ok: true as const, value, left: 1 };
    },
    ask: async (_s: Store, system: string, prompt: string, maxTokens: number, model: string) => {
      calls.push({ system, prompt, maxTokens, model });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return out;
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
  is(
    "the live call is askModel (reserved in the store's AI budget before the provider), inside counted (one of the month's jobs), and the help's own switch",
    lib.includes("const LIVE: SuggestDeps = { ask: askModel, available: aiAvailableFor, count: counted };"),
    true,
  );

  part("Each ask takes one of the month's writing jobs first (out-of-family review of #3559, MEDIUM 1)");
  const used = deps('{"email":0,"name":1,"tags":null,"consent":2}', true, "used");
  is("the month's jobs used up: refused as used, the model never called", [await suggestColumns(store, "contacts", header, open, used), used.counts, used.calls.length], [{ ok: false, why: "used" }, 1, 0]);
  const unset = deps('{"email":0,"name":1,"tags":null,"consent":2}', true, "off");
  is("the job cannot be taken (no counter, no window): off, the model never called", [await suggestColumns(store, "contacts", header, open, unset), unset.calls.length], [{ ok: false, why: "off" }, 0]);
  const once = deps('{"email":0,"name":1,"tags":null,"consent":2}');
  await suggestColumns(store, "contacts", header, open, once);
  is("one job taken per ask, the model called inside it", [once.counts, once.calls.length], [1, 1]);
  is("nothing is counted when nothing would be asked", [await (async () => { const d = deps("{}"); await suggestColumns(store, "contacts", ["ana@mail.test", "Ana"], open, d); return d.counts; })()], [0]);

  // The real counted, on the in-memory store: the job is taken before the model is asked, and a month at its allowance asks nothing.
  const prior = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-" + "synthetic".repeat(5);
  try {
    const at = Date.UTC(2026, 10, 12, 9);
    const paying = { statsId: "csv-map-jobs", sid: "csv-map-jobs", tier: "pro", period: paidPeriod(at) } as unknown as Store;
    const key = aiMonthKey(paying, new Date(at)) as string;
    const real = (answer: string | null) => ({ ...deps(answer), count: counted });
    await redisPipeline([["SET", key, AI_MONTHLY.pro]]);
    const full = real('{"email":0,"name":1,"tags":null,"consent":2}');
    is("with the real counted: a month at its allowance is refused as used, the model never called, nothing more counted", [await suggestColumns(paying, "contacts", header, open, full, at), full.calls.length, (await redisPipeline([["GET", key]]))[0]], [{ ok: false, why: "used" }, 0, String(AI_MONTHLY.pro)]);
    await redisPipeline([["DEL", key]]);
    const fresh = real('{"email":0,"name":1,"tags":null,"consent":2}');
    const fine = await suggestColumns(paying, "contacts", header, open, fresh, at);
    is("with the real counted: an ask takes exactly one job, then the model is called once", [fine.ok, fresh.calls.length, (await redisPipeline([["GET", key]]))[0]], [true, 1, "1"]);
    const late = real(null);
    is("with the real counted: an ask whose call came back empty suggests nothing", await suggestColumns(paying, "contacts", header, open, late, at), { ok: false, why: "failed" });
  } finally {
    if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prior;
  }

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
  // Review at 15974dfb92, LOW: only the names the model can see are sent (askBody, held in tests/csv-map-ai-lows.test.ts).
  is("it sends names and the guess, nothing else, through askBody", ui.includes("body: JSON.stringify({ kind, ...askBody(header, guess) })"), true);
  // Out-of-family review of #3559 at c720cc496a, LOW 1: the first row is checked in the browser, so a file with no
  // header row sends nothing at all, not even to our server, and "only the column names are sent" is what happens.
  is(
    "a first row that is not clearly a header is never sent: the screen checks it before asking, with the rules' own clearHeader",
    [ui.includes('import { askBody, clearHeader, type Source } from "@/lib/csv-map-ai-rules";'), /if \(!clearHeader\(header\)\) \{\n\s+setNote\(SUGGEST_MESSAGES\.no_header\);\n\s+return;\n\s+\}/.test(ui), ui.indexOf("if (!clearHeader(header))") < ui.indexOf('fetch("/api/store/import-columns"')],
    [true, true, true],
  );
  // Claude 1's review of #3559 at a323e8a3ae, LOW: a refusal a retry cannot help never says "try again".
  const { SUGGEST_MESSAGES, suggestMessage } = await import("@/components/import-column-suggest");
  is(
    "every refusal the route sends has its own words, and only a failed call says to try again",
    [
      ["off", "not_needed", "no_header", "cost_unknown", "used", "failed", "unreadable", "slow", "renewal_unpaid", "plan_disputed", "invalid", "signed_out", "role", "server_error"].every((code) => typeof SUGGEST_MESSAGES[code] === "string"),
      Object.entries(SUGGEST_MESSAGES).filter(([, words]) => /try again in a moment/i.test(words)).map(([code]) => code).sort(),
    ],
    [true, ["failed", "server_error"]],
  );
  is(
    "a code the screen does not know is never called a passing failure, and the route's own message is kept",
    [suggestMessage("two_step_required", undefined), suggestMessage("locked", "This store is locked."), suggestMessage(undefined, undefined), /try again/i.test(suggestMessage("anything_new", undefined))],
    [SUGGEST_MESSAGES.refused, "This store is locked.", SUGGEST_MESSAGES.failed, false],
  );
  is("it says each ask uses one of this month's AI writing jobs (MEDIUM 1)", [ui.includes("Each time you ask, it uses one of this month's AI writing jobs."), /used: "[^"]*writing jobs are used up/.test(ui)], [true, true]);
  is("a status region tells what happened; every suggestion says it is from AI", [ui.includes('role="status"'), ui.includes("suggested by AI, not checked yet")], [true, true]);
  is(
    "each button's name is its visible text (2.5.3), what it acts on its description; no label hides the words",
    [/aria-label=/.test(ui), (ui.match(/aria-describedby=\{lineId\(s\.field\)\}/g) ?? []).length, ui.includes("<p id={lineId(s.field)}"), ui.includes(">\n                    Use this column\n"), ui.includes(">\n                    Not this one\n")],
    [false, 2, true, true, true],
  );
  is(
    "after a choice the focus goes to the next suggestion's button, or to the summary, never to the page (2.4.3)",
    [ui.includes("const next = rest[Math.min(Math.max(at, 0), rest.length - 1)]?.field ?? null;"), ui.includes("requestAnimationFrame(() => (next ? useButtons.current[next] : summary.current)?.focus());"), ui.includes('<p ref={summary} tabIndex={-1} role="status"')],
    [true, true, true],
  );
  is(
    "while asking, the button stays focusable and says so (aria-disabled), and a second press does nothing",
    [ui.includes('type="button" onClick={ask} aria-disabled={busy} aria-busy={busy}'), /[^-]disabled={busy}/.test(ui), ui.includes("async function ask() {\n    if (busy) return;")],
    [true, false, true],
  );
}

main().then(done);
