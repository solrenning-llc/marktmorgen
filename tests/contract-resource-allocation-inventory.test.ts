/**
 * CONTRACT_ADMISSION_COVERAGE.resourceAllocations, part 1: every take from a
 * store's monthly figures (lib/store-allowance.ts) is inventoried here, call
 * site by call site, with what it does about the paid contract cohort
 * (lib/contract-resource-window.ts, reservePaidResourceWindow) before the take.
 *
 * Why this exists (AV1 step 3, docs/opening-readiness-status-2026-11-11.md,
 * group B item 2): resourceAllocations cannot start off at opening, because
 * the published allowances are the plan itself (docs/opening-lifecycle-
 * requirements.md). So it must be built, and "built" needs a definition that
 * cannot drift: this file. It never makes the key true by itself. It only
 * fails when the key is true while a site is still pending, while other cost
 * primitives are still uninventoried, when a new call site appears without a
 * classification, or when a site claimed gated has lost its gate.
 *
 * The checks read the source text: they prove the gate is written before the
 * take, not that a real paid cohort exists. Real behaviour of each gate stays
 * with its own tests (tests/contract-resource-window.test.ts and the rest).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CONTRACT_ADMISSION_COVERAGE } from "@/lib/contract-funding-rules";
import { done, is, part } from "./check";

const root = process.cwd();
const SELF = "tests/contract-resource-allocation-inventory.test.ts";
const PRIMITIVES = ["takeAllowance", "holdAllowanceAt", "forceAllowance"] as const;
const GATE = "reservePaidResourceWindow(";

type CallerEntry = { state: "gated"; calls: number; note?: string } | { state: "kept-right"; calls: number; why: string } | { state: "pending"; calls: number; why: string };
type Entry =
  /** reservePaidResourceWindow( is written in the same top-level function before every take. */
  | { state: "gated"; calls: number; note?: string }
  /** The function is not exported, and every call of it in its own file follows `guard`, a function there that holds the gate. */
  | { state: "gated-by-callers"; calls: number; guard: string }
  /** takeAllowance itself proves the cohort for this kind (lib/store-allowance.ts). */
  | { state: "gated-in-primitive"; calls: number; kind: "webhook" }
  /** A generic door that also serves removal, leaving, paying and downloads: not gated itself; every caller is classified in `callers` instead. */
  | { state: "door"; calls: number; callers: Record<string, CallerEntry> }
  /** Only settles what `after` (an inventoried, gated site) admitted earlier in the same function: never a new admission. */
  | { state: "settles"; calls: number; after: string }
  /** A right that is never refused for the cohort; its cost stays inside the plan's own figure. Needs the reviewer's acceptance. */
  | { state: "kept-right"; calls: number; why: string }
  /** No cohort proof before the take yet: keeps resourceAllocations false. */
  | { state: "pending"; calls: number; why: string };

/** Keyed "file#top-level function". Read on origin/main e5aaa11c80, 13 November 2026. */
const ALLOWANCE_TAKE_INVENTORY: Record<string, Entry> = {
  "lib/api-guard.ts#apiKeyed": { state: "gated", calls: 1, note: "Skipped for purpose \"write\" by design: each write in lib/api-write.ts proves it, and removals stay open." },
  "lib/api-guard.ts#takeMoreApi": { state: "gated", calls: 1, note: "Skipped only for a removal its caller names (DELETE /api/v1/codes switches a code off)." },
  "lib/api-guard.ts#holdMoreApi": { state: "gated", calls: 1 },
  "lib/api-write.ts#addLead": { state: "gated", calls: 1 },
  "lib/api-write.ts#giveAccess": { state: "gated", calls: 1 },
  "lib/broadcasts.ts#createBroadcast": { state: "gated", calls: 1 },
  "lib/broadcasts.ts#readNarrowing": { state: "gated", calls: 1, note: "Refused, the broadcast waits and is read again later, as when its window is unknown." },
  "lib/broadcasts.ts#countTest": { state: "gated", calls: 1, note: "Refused, the test is decided without its sales, as when they cannot be counted." },
  "lib/buyer-actions.ts#takeBuyerAction": { state: "gated", calls: 2 },
  "lib/cart-link-products.ts#cartLinkProducts": { state: "gated", calls: 1, note: "Gated before its countStudio reading, which it then settles." },
  "lib/dispute-preorder-review.ts#readRetainedPreorderReview": { state: "gated", calls: 1 },
  "lib/dispute-purchase-review.ts#readDisputePurchaseReview": { state: "gated", calls: 2 },
  "lib/email.ts#takeMeteredAllowance": { state: "gated-by-callers", calls: 1, guard: "meterCohortReady" },
  "lib/inbox.ts#open": { state: "gated", calls: 1 },
  "lib/inbox.ts#visitorSend": { state: "gated", calls: 1 },
  "lib/inbox.ts#writeToAffiliate": { state: "gated", calls: 1 },
  "lib/metered-limits.ts#withinServiceWhy": { state: "gated", calls: 1, note: "Removals skip it at their callers (host-calendar removing, email-sync disconnect)." },
  "lib/person-erasure.ts#erasePerson": { state: "kept-right", calls: 2, why: "Erasing a person is their right and the store's legal duty; never refused because a period's cash proof is missing." },
  "lib/store-copy.ts#charge": { state: "gated", calls: 1 },
  // The generic studio door also serves removal and disconnection: gating it here refused Discord role removal and
  // disconnect (tests/discord.test.ts, 13 November 2026). Each caller that starts new work proves the cohort itself.
  "lib/studio-route.ts#countStudio": { state: "door", calls: 1, callers: {
    "lib/studio-route.ts#studioAccess": { state: "kept-right", calls: 1, why: "The door of every studio request: removing, leaving, paying, disconnecting and downloading pass here. The new work behind it proves the cohort where it takes or spends (the takes above, the primitives of part 2, the Discord, calendar and meeting routes)." },
    "lib/studio-route.ts#studioView": { state: "kept-right", calls: 1, why: "Drawing a studio page is how the owner reaches paying, leaving, removing and downloading; refusing it would shut them out." },
    "lib/cart-link-products.ts#cartLinkProducts": { state: "gated", calls: 1 },
    "lib/deal-stage-trigger.ts#dealEnteredStage": { state: "gated", calls: 1 },
    "lib/path.ts#chargeStudio": { state: "gated", calls: 1 },
    "lib/person-agenda-read.ts#countUnits": { state: "gated", calls: 1 },
    "app/api/store/discount/route.ts#POST": { state: "gated", calls: 1 },
    "app/api/store/funnel-explain/route.ts#POST": { state: "gated", calls: 1 },
    "app/api/store/funnel-share/route.ts#otherOwnStore": { state: "gated", calls: 1 },
    "app/api/store/path/route.ts#POST": { state: "gated", calls: 1, note: "Joining the board only; leaving it never counts." },
    "app/api/store/person-tasks/route.ts#GET": { state: "gated", calls: 1 },
    "app/api/store/person-tasks/route.ts#POST": { state: "gated", calls: 1, note: "Skipped for removing a task and marking it done." },
    "app/api/store/store-copy/route.ts#POST": { state: "gated", calls: 1 },
    "app/studio/totals/page.tsx#readStore": { state: "gated", calls: 1 },
    "app/api/store/receipt-pdf/route.ts#GET": { state: "kept-right", calls: 1, why: "A receipt for a payment already made is owed to whoever paid; it is a record, not new work." },
    "app/studio/invoices/page.tsx#StudioInvoicesPage": { state: "kept-right", calls: 1, why: "The owner's own invoices from us: paying and its records are never refused." },
    "app/studio/path/privacy/page.tsx#PathBoardPrivacyPage": { state: "kept-right", calls: 1, why: "Counted under the \"delete\" need, which leaving and deleting use; never refused for the cohort." },
  } },
  "lib/studio-route.ts#holdStudio": { state: "door", calls: 2, callers: {
    "lib/list-download.ts#holdListDownload": { state: "kept-right", calls: 2, why: "Downloading the store's lists is taking its own data away (studioAccess keeps that open)." },
    "app/api/store/affiliates/route.ts#POST": { state: "gated", calls: 1, note: "Skipped for removing, declining, restoring and undoing." },
  } },
  "lib/webhooks.ts#attempt": { state: "gated-in-primitive", calls: 1, kind: "webhook" },
  "lib/webhooks.ts#resendDelivery": { state: "gated", calls: 1 },
  "lib/webhooks.ts#sendTest": { state: "gated", calls: 1 },
  "app/api/store/export/route.ts#GET": { state: "kept-right", calls: 1, why: "A store's export of its own data stays available when costly work pauses (docs/cross-product-handoff.md)." },
};

/**
 * Cost primitives outside the monthly figures: all 15 found on 13 November
 * 2026 are inventoried in part 2, tests/contract-resource-primitive-inventory.test.ts,
 * which keeps the key false while any of their call sites is pending. None is left
 * uninventoried here; a new primitive is added there, not here.
 */
const UNINVENTORIED_COST_PRIMITIVES: readonly string[] = [];
const PART_2 = "tests/contract-resource-primitive-inventory.test.ts";

type Decl = { name: string; exported: boolean; line: number };
const DECL = /^(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^(export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z0-9_$]+\s*=>)/;
const COMMENT = /^\s*(\/\/|\*|\/\*)/;

function declarations(lines: string[]): Decl[] {
  const out: Decl[] = [];
  lines.forEach((text, line) => {
    const m = text.match(DECL);
    if (m) out.push({ name: m[2] ?? m[4], exported: Boolean(m[1] ?? m[3]), line });
  });
  return out;
}
const enclosing = (decls: Decl[], line: number): Decl | null => decls.filter((d) => d.line <= line).at(-1) ?? null;

type Site = { key: string; file: string; fn: string; line: number; text: string; before: string };

/** Every take from the monthly figures in the given sources, by top-level function. */
function allowanceSites(sources: Map<string, string>): Site[] {
  const sites: Site[] = [];
  for (const [file, source] of sources) {
    if (file === "lib/store-allowance.ts") continue;
    const lines = source.split("\n");
    const decls = declarations(lines);
    lines.forEach((text, line) => {
      if (COMMENT.test(text)) return;
      for (const name of PRIMITIVES) {
        for (const m of text.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
          if (/function\s+$/.test(text.slice(0, m.index))) continue;
          const decl = enclosing(decls, line);
          const fn = decl?.name ?? "(top)";
          const before = lines.slice(decl?.line ?? 0, line).join("\n") + "\n" + text.slice(0, m.index);
          sites.push({ key: `${file}#${fn}`, file, fn, line: line + 1, text, before });
        }
      }
    });
  }
  return sites;
}

/** Everything wrong between the sources, the inventory and the key; empty when they agree. */
function audit(sources: Map<string, string>, inventory: Record<string, Entry>, uninventoried: readonly string[], keyTrue: boolean): string[] {
  const problems: string[] = [];
  const sites = allowanceSites(sources);
  const byKey = new Map<string, Site[]>();
  for (const site of sites) byKey.set(site.key, [...(byKey.get(site.key) ?? []), site]);
  for (const [key, found] of byKey) {
    const entry = inventory[key];
    if (!entry) {
      problems.push(`unclassified take: ${key} (line ${found[0].line}); add it to ALLOWANCE_TAKE_INVENTORY`);
      continue;
    }
    if (entry.calls !== found.length) problems.push(`${key}: ${found.length} takes found, ${entry.calls} inventoried`);
    if (entry.state === "gated") {
      for (const site of found) if (!site.before.includes(GATE)) problems.push(`${key}: claimed gated, but no ${GATE} before line ${site.line}`);
    }
    if (entry.state === "gated-in-primitive") {
      const primitive = sources.get("lib/store-allowance.ts") ?? "";
      const held = primitive.split("\n").some((l) => l.includes(`kind === "${entry.kind}" && store.period?.funded === true`) && l.includes(GATE));
      if (!held) problems.push(`${key}: takeAllowance no longer proves the cohort for kind "${entry.kind}"`);
      for (const site of found) if (!site.text.includes(`"${entry.kind}"`)) problems.push(`${key}: line ${site.line} does not take kind "${entry.kind}"`);
    }
    if (entry.state === "gated-by-callers") {
      const [file, fn] = key.split("#");
      const lines = (sources.get(file) ?? "").split("\n");
      const decls = declarations(lines);
      const own = decls.find((d) => d.name === fn);
      const guard = decls.find((d) => d.name === entry.guard);
      if (!own || own.exported) problems.push(`${key}: must be a function of its own file, not exported`);
      if (!guard) problems.push(`${key}: guard ${entry.guard} not found in ${file}`);
      else {
        const next = decls.find((d) => d.line > guard.line);
        if (!lines.slice(guard.line, next?.line ?? lines.length).join("\n").includes(GATE)) problems.push(`${key}: guard ${entry.guard} does not hold ${GATE}`);
      }
      lines.forEach((text, line) => {
        if (COMMENT.test(text) || line === own?.line) return;
        for (const m of text.matchAll(new RegExp(`\\b${fn}\\(`, "g"))) {
          const decl = enclosing(decls, line);
          const before = lines.slice(decl?.line ?? 0, line).join("\n") + "\n" + text.slice(0, m.index);
          if (!before.includes(`${entry.guard}(`)) problems.push(`${key}: called at line ${line + 1} without ${entry.guard} before it`);
        }
      });
      for (const [other, source] of sources) if (other !== file && new RegExp(`\\b${fn}\\b`).test(source) && source.includes(`from "@/${file.replace(/\.ts$/, "")}"`)) problems.push(`${key}: used outside its file in ${other}`);
    }
    if (entry.state === "door") {
      const [file, fn] = key.split("#");
      const modulePath = file.replace(/\.tsx?$/, "");
      const callers = new Map<string, { line: number; before: string }[]>();
      for (const [other, source] of sources) {
        if (other !== file && !source.includes(`"@/${modulePath}"`)) continue;
        const lines = source.split("\n");
        const decls = declarations(lines);
        lines.forEach((text, line) => {
          if (COMMENT.test(text)) return;
          for (const m of text.matchAll(new RegExp(`(?<![.\\w$])${fn}\\(`, "g"))) {
            if (/function\s+$/.test(text.slice(0, m.index))) continue;
            const decl = enclosing(decls, line);
            const at = `${other}#${decl?.name ?? "(top)"}`;
            const before = lines.slice(decl?.line ?? 0, line).join("\n") + "\n" + text.slice(0, m.index);
            callers.set(at, [...(callers.get(at) ?? []), { line: line + 1, before }]);
          }
        });
      }
      for (const [at, calls] of callers) {
        const caller = entry.callers[at];
        if (!caller) {
          problems.push(`${key}: unclassified caller ${at} (line ${calls[0].line})`);
          continue;
        }
        if (caller.calls !== calls.length) problems.push(`${key}: ${at} has ${calls.length} calls, ${caller.calls} inventoried`);
        if (caller.state === "gated") for (const call of calls) if (!call.before.includes(GATE)) problems.push(`${key}: ${at} claimed gated, but no ${GATE} before line ${call.line}`);
        if (caller.state !== "gated" && !caller.why.trim()) problems.push(`${key}: ${at} needs its reason`);
      }
      for (const at of Object.keys(entry.callers)) if (!callers.has(at)) problems.push(`${key}: stale caller ${at}`);
    }
    if (entry.state === "settles") {
      const admitted = inventory[entry.after];
      const fn = entry.after.split("#")[1];
      if (!admitted || !["gated", "gated-by-callers", "gated-in-primitive"].includes(admitted.state)) problems.push(`${key}: settles after ${entry.after}, which is not a gated site`);
      for (const site of found) if (!site.before.includes(`${fn}(`)) problems.push(`${key}: line ${site.line} settles without ${fn} before it`);
    }
    if ((entry.state === "pending" || entry.state === "kept-right") && !entry.why.trim()) problems.push(`${key}: needs its reason`);
  }
  for (const key of Object.keys(inventory)) if (!byKey.has(key)) problems.push(`stale inventory entry: ${key} has no take any more`);
  const pending = Object.entries(inventory).flatMap(([k, e]) => e.state === "pending" ? [k] : e.state === "door" ? Object.entries(e.callers).filter(([, c]) => c.state === "pending").map(([at]) => `${k} <- ${at}`) : []);
  if (keyTrue && pending.length) problems.push(`resourceAllocations is true with ${pending.length} pending takes: ${pending.join(", ")}`);
  if (keyTrue && uninventoried.length) problems.push(`resourceAllocations is true with ${uninventoried.length} cost primitives not inventoried`);
  return problems;
}

function readSources(): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) sources.set(relative(root, join(root, path)).split("\\").join("/"), readFileSync(join(root, path), "utf8"));
    }
  };
  walk("lib");
  walk("app");
  return sources;
}

const sources = readSources();

part("The real sources agree with the inventory, and the key with both");
const problems = audit(sources, ALLOWANCE_TAKE_INVENTORY, UNINVENTORIED_COST_PRIMITIVES, CONTRACT_ADMISSION_COVERAGE.resourceAllocations);
for (const problem of problems) console.log(`        ${problem}`);
is("no problem between sources, inventory and key", problems, []);
is("the scan finds every take (29 on 13 November 2026)", allowanceSites(sources).length, Object.values(ALLOWANCE_TAKE_INVENTORY).reduce((n, e) => n + e.calls, 0));
const pendingCalls = Object.values(ALLOWANCE_TAKE_INVENTORY).reduce((n, e) => n + (e.state === "pending" ? e.calls : e.state === "door" ? Object.values(e.callers).filter((c) => c.state === "pending").reduce((m, c) => m + c.calls, 0) : 0), 0);
is("pending takes and door callers, down from 11 (part 1) to 0", pendingCalls, 0);
is("pending takes keep resourceAllocations false", pendingCalls > 0 && CONTRACT_ADMISSION_COVERAGE.resourceAllocations, false);
is("part 2 exists, so no primitive outside the figures is left uninventoried", readFileSync(join(root, PART_2), "utf8").includes("PRIMITIVE_INVENTORY"), true);
is("the other two core keys are untouched", [CONTRACT_ADMISSION_COVERAGE.renewals, CONTRACT_ADMISSION_COVERAGE.settlementAndReserveReconciliation], [false, false]);

part("The audit refuses what it is for (synthetic sources)");
const gatedFile = 'export async function a(store) {\n  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return null;\n  return takeAllowance(store, "studio");\n}\n';
const ungatedFile = 'export async function a(store) {\n  return takeAllowance(store, "studio");\n}\n';
const gatedEntry: Record<string, Entry> = { "lib/x.ts#a": { state: "gated", calls: 1 } };
is("a written gate passes", audit(new Map([["lib/x.ts", gatedFile]]), gatedEntry, [], false), []);
is("a gate claimed but not written fails", audit(new Map([["lib/x.ts", ungatedFile]]), gatedEntry, [], false), ["lib/x.ts#a: claimed gated, but no reservePaidResourceWindow( before line 2"]);
is("a gate written after the take fails", audit(new Map([["lib/x.ts", 'export async function a(store) {\n  const t = await takeAllowance(store, "studio");\n  await reservePaidResourceWindow(store);\n}\n']]), gatedEntry, [], false).length, 1);
is("a new take without a classification fails", audit(new Map([["lib/x.ts", gatedFile], ["lib/y.ts", ungatedFile]]), gatedEntry, [], false), ["unclassified take: lib/y.ts#a (line 2); add it to ALLOWANCE_TAKE_INVENTORY"]);
is("a take removed from the source fails as stale", audit(new Map([["lib/x.ts", "export const n = 1;\n"]]), gatedEntry, [], false), ["stale inventory entry: lib/x.ts#a has no take any more"]);
is("a second take in the same function must be counted", audit(new Map([["lib/x.ts", gatedFile.replace("return takeAllowance", "await takeAllowance(store, \"api\");\n  return takeAllowance")]]), gatedEntry, [], false), ["lib/x.ts#a: 2 takes found, 1 inventoried"]);
const pendingEntry: Record<string, Entry> = { "lib/x.ts#a": { state: "pending", calls: 1, why: "not yet" } };
is("pending is allowed while the key is false", audit(new Map([["lib/x.ts", ungatedFile]]), pendingEntry, [], false), []);
is("the key true with a pending take fails", audit(new Map([["lib/x.ts", ungatedFile]]), pendingEntry, [], true), ["resourceAllocations is true with 1 pending takes: lib/x.ts#a"]);
is("the key true with uninventoried primitives fails", audit(new Map([["lib/x.ts", gatedFile]]), gatedEntry, ["lib/z.ts#reserveZ"], true), ["resourceAllocations is true with 1 cost primitives not inventoried"]);
is("a comment that mentions the take is not a take", allowanceSites(new Map([["lib/x.ts", "// takeAllowance(store) is called elsewhere\n * holdAllowanceAt(store)\n"]])).length, 0);
const callers = 'async function guardIt(m) {\n  return reservePaidResourceWindow(m);\n}\nasync function take(m) {\n  return takeAllowance(m.store, "email");\n}\nexport async function send(m) {\n  if (!(await guardIt(m))) return false;\n  return take(m);\n}\n';
const callersEntry: Record<string, Entry> = { "lib/x.ts#take": { state: "gated-by-callers", calls: 1, guard: "guardIt" } };
is("gated by callers passes when each caller checks the guard first", audit(new Map([["lib/x.ts", callers]]), callersEntry, [], false), []);
is("gated by callers fails when a caller skips the guard", audit(new Map([["lib/x.ts", callers + "export async function skip(m) {\n  return take(m);\n}\n"]]), callersEntry, [], false), ["lib/x.ts#take: called at line 12 without guardIt before it"]);
is("gated by callers fails when the site is exported", audit(new Map([["lib/x.ts", callers.replace("async function take", "export async function take")]]), callersEntry, [], false), ["lib/x.ts#take: must be a function of its own file, not exported"]);
is("gated by callers fails when the guard lost its gate", audit(new Map([["lib/x.ts", callers.replace("reservePaidResourceWindow(m)", "true")]]), callersEntry, [], false), ["lib/x.ts#take: guard guardIt does not hold reservePaidResourceWindow("]);

part("The decision is recorded where the key lives and in the readiness status");
const rules = readFileSync(join(root, "lib/contract-funding-rules.ts"), "utf8");
const coverageAt = rules.indexOf("export const CONTRACT_ADMISSION_COVERAGE=");
const comment = rules.slice(Math.max(0, rules.lastIndexOf("/**", coverageAt)), coverageAt);
is("the key's comment names this inventory", comment.includes(SELF), true);
is("the key's comment says none of the three can start off", ["resourceAllocations", "renewals", "settlementAndReserveReconciliation"].every((key) => comment.includes(key)) && /cannot start off/.test(comment), true);
const status = readFileSync(join(root, "docs/opening-readiness-status-2026-11-11.md"), "utf8");
is("the readiness status has the dated update with this inventory", /Update, 13 November 2026/.test(status) && status.includes(SELF), true);
done();
