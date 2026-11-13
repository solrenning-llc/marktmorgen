/**
 * CONTRACT_ADMISSION_COVERAGE.resourceAllocations, part 2: the 15 cost
 * primitives outside the monthly figures (part 1 is
 * tests/contract-resource-allocation-inventory.test.ts). Each is either
 * gated in its own file (its body, or a helper of its file it calls, holds
 * reservePaidResourceWindow), gated through a part-1 site it calls, or
 * inventoried call site by call site. It fails while the key is true with a
 * site still pending, when a site appears unclassified, or when a gate
 * claimed here is no longer written. Text proof only, as in part 1.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CONTRACT_ADMISSION_COVERAGE } from "@/lib/contract-funding-rules";
import { done, is, part } from "./check";

const root = process.cwd();
const GATE = "reservePaidResourceWindow(";

type SiteEntry =
  | { state: "gated"; calls: number; note?: string }
  /** Every call of the site's own function follows `guard`, a self-gated primitive of this inventory, in the caller's function. */
  | { state: "gated-by-callers"; calls: number; guard: string }
  | { state: "pending"; calls: number; why: string };
type PrimitiveEntry =
  /** The primitive's body, or the helper `via` of its own file that the body calls, holds the gate. */
  | { state: "self-gated"; via: string }
  /** The primitive's body calls `via` ("file#function"), whose own body holds the gate. */
  | { state: "via-gated"; via: string }
  /** A right that is never refused for the cohort; its cost stays inside the plan's own figure. Needs the reviewer's acceptance. */
  | { state: "kept-right"; why: string }
  /** Each call site, by file and top-level function. */
  | { state: "sites"; sites: Record<string, SiteEntry> };

/** Keyed "defining file#primitive". Read on origin/main e5aaa11c80 with part 1b, 13 November 2026. */
const PRIMITIVE_INVENTORY: Record<string, PrimitiveEntry> = {
  "lib/upload-budget.ts#reserveStoreUpload": { state: "self-gated", via: "reserveStoreUpload" },
  "lib/mail.ts#reserve": { state: "self-gated", via: "reserve" },
  "lib/mail.ts#takeFromMonth": { state: "self-gated", via: "monthToTake" },
  "lib/mail.ts#takeFromMonthExact": { state: "self-gated", via: "monthToTake" },
  "lib/traffic.ts#takePublicRequest": { state: "self-gated", via: "takePublic" },
  "lib/traffic.ts#holdPublicRequests": { state: "self-gated", via: "takePublic" },
  "lib/list-download.ts#holdListDownload": { state: "kept-right", why: "Downloading the store's lists is taking its own data away, never refused for the cohort (lib/studio-route.ts, studioAccess); its cost stays in the studio figure. Needs the reviewer's acceptance." },
  "lib/ai-spend.ts#reserveAiSpend": { state: "sites", sites: { "lib/ai.ts#askModel": { state: "gated", calls: 1 } } },
  "lib/imports.ts#reserveMoved": { state: "sites", sites: {
    "lib/api-write.ts#giveAccess": { state: "gated", calls: 1 },
    "lib/imports.ts#mailStep": { state: "gated", calls: 1 },
    "lib/imports.ts#sendMoveReminders": { state: "gated", calls: 1 },
  } },
  "lib/answers.ts#takeAnswer": { state: "self-gated", via: "takeAnswer" },
  "lib/quiz-usage.ts#reserveQuizSubmission": { state: "sites", sites: { "lib/quiz.ts#submitQuiz": { state: "pending", calls: 1, why: "A quiz submission is reserved without the cohort proof. Not gated on 13 November 2026: lib/quiz.ts is reserved to Claude 3 (claude3/mcp-tools-unknown-sweep-2)." } } },
  "lib/resend-fallback-budget.ts#reserveResendFallback": { state: "sites", sites: { "lib/resend-fallback-transport.ts#guardedResendPost": { state: "pending", calls: 1, why: "The fallback sender's budget is reserved per send; the store meter's proof before it (lib/email.ts) is not shown here. Not gated on 13 November 2026: lib/resend-fallback-transport.ts is reserved to Codex (codex/a3-c121-not-posted-integration)." } } },
  "lib/store-readings.ts#takeStoreReading": { state: "sites", sites: { "lib/store-readings.ts#keptReading": { state: "gated", calls: 1, note: "Refused as a day with no reading left: the last one kept is shown, stale." } } },
  "lib/storage-reservations.ts#reserveStorage": { state: "sites", sites: { "lib/vault-storage.ts#openReservedVault": { state: "gated-by-callers", calls: 1, guard: "reserveStoreUpload" } } },
  "lib/imports.ts#takeImportRows": { state: "self-gated", via: "takeImportRows" },
};

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
/** A top-level function's text, from its declaration to the next one; null when it is not declared there. */
function body(sources: Map<string, string>, file: string, name: string): string | null {
  const lines = (sources.get(file) ?? "").split("\n");
  const decls = declarations(lines);
  const own = decls.find((d) => d.name === name);
  if (!own) return null;
  const next = decls.find((d) => d.line > own.line);
  return lines.slice(own.line, next?.line ?? lines.length).join("\n");
}

/** Calls of `name` (defined in `file`) in that file and in files importing from it, by top-level function. */
function callSites(sources: Map<string, string>, file: string, name: string): Map<string, { line: number; before: string }[]> {
  const sites = new Map<string, { line: number; before: string }[]>();
  const modulePath = file.replace(/\.tsx?$/, "");
  for (const [other, source] of sources) {
    if (other !== file && !source.includes(`"@/${modulePath}"`) && !source.includes(`'@/${modulePath}'`)) continue;
    const lines = source.split("\n");
    const decls = declarations(lines);
    lines.forEach((text, line) => {
      if (COMMENT.test(text)) return;
      for (const m of text.matchAll(new RegExp(`(?<![.\\w$])${name}\\(`, "g"))) {
        if (/function\s+$/.test(text.slice(0, m.index))) continue;
        const decl = decls.filter((d) => d.line <= line).at(-1);
        const key = `${other}#${decl?.name ?? "(top)"}`;
        const before = lines.slice(decl?.line ?? 0, line).join("\n") + "\n" + text.slice(0, m.index);
        sites.set(key, [...(sites.get(key) ?? []), { line: line + 1, before }]);
      }
    });
  }
  return sites;
}

function audit(sources: Map<string, string>, inventory: Record<string, PrimitiveEntry>, keyTrue: boolean): string[] {
  const problems: string[] = [];
  let pending = 0;
  for (const [key, entry] of Object.entries(inventory)) {
    const [file, name] = key.split("#");
    const own = body(sources, file, name);
    if (own === null) {
      problems.push(`${key}: the primitive is not declared there any more`);
      continue;
    }
    if (entry.state === "self-gated") {
      const via = entry.via === name ? own : body(sources, file, entry.via);
      if (entry.via !== name && !own.includes(`${entry.via}(`)) problems.push(`${key}: does not call ${entry.via}`);
      if (via === null || !via.includes(GATE)) problems.push(`${key}: ${entry.via} does not hold ${GATE}`);
    }
    if (entry.state === "kept-right" && !entry.why.trim()) problems.push(`${key}: needs its reason`);
    if (entry.state === "via-gated") {
      const [viaFile, viaName] = entry.via.split("#");
      const via = body(sources, viaFile, viaName);
      if (!own.includes(`${viaName}(`)) problems.push(`${key}: does not call ${viaName}`);
      if (via === null || !via.includes(GATE)) problems.push(`${key}: ${entry.via} does not hold ${GATE}`);
    }
    if (entry.state === "sites") {
      const found = callSites(sources, file, name);
      for (const [site, calls] of found) {
        const classified = entry.sites[site];
        if (!classified) {
          problems.push(`${key}: unclassified call in ${site} (line ${calls[0].line})`);
          continue;
        }
        if (classified.calls !== calls.length) problems.push(`${key}: ${site} has ${calls.length} calls, ${classified.calls} inventoried`);
        if (classified.state === "gated") for (const call of calls) if (!call.before.includes(GATE)) problems.push(`${key}: ${site} claimed gated, but no ${GATE} before line ${call.line}`);
        if (classified.state === "gated-by-callers") {
          const [siteFile, siteFn] = site.split("#");
          const guardEntry = Object.entries(inventory).find(([k]) => k.endsWith(`#${classified.guard}`))?.[1];
          if (guardEntry?.state !== "self-gated") problems.push(`${key}: ${site} guard ${classified.guard} is not a self-gated primitive here`);
          const users = callSites(sources, siteFile, siteFn);
          if (users.size === 0) problems.push(`${key}: ${site} has no caller to prove its guard`);
          for (const [user, uses] of users) for (const use of uses) if (!use.before.includes(`${classified.guard}(`)) problems.push(`${key}: ${site} is called in ${user} (line ${use.line}) without ${classified.guard} before it`);
        }
        if (classified.state === "pending") {
          if (!classified.why.trim()) problems.push(`${key}: ${site} needs its reason`);
          pending += classified.calls;
        }
      }
      for (const site of Object.keys(entry.sites)) if (!found.has(site)) problems.push(`${key}: stale site ${site}`);
    }
  }
  if (keyTrue && pending) problems.push(`resourceAllocations is true with ${pending} pending primitive calls`);
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
const pendingCalls = Object.values(PRIMITIVE_INVENTORY).flatMap((e) => (e.state === "sites" ? Object.values(e.sites) : [])).filter((s) => s.state === "pending").reduce((n, s) => n + s.calls, 0);

part("The 15 primitives outside the monthly figures agree with the inventory, and the key with it");
const problems = audit(sources, PRIMITIVE_INVENTORY, CONTRACT_ADMISSION_COVERAGE.resourceAllocations);
for (const problem of problems) console.log(`        ${problem}`);
is("no problem between sources, inventory and key", problems, []);
is("all 15 primitives inventoried", Object.keys(PRIMITIVE_INVENTORY).length, 15);
is("pending primitive calls on 13 November 2026", pendingCalls, 2);
is("pending calls keep resourceAllocations false", pendingCalls > 0 && CONTRACT_ADMISSION_COVERAGE.resourceAllocations, false);

part("The audit refuses what it is for (synthetic sources)");
const def = 'export async function reserveX(store) {\n  return 1;\n}\n';
const gatedUse = 'import { reserveX } from "@/lib/x";\nexport async function use(store) {\n  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return null;\n  return reserveX(store);\n}\n';
const ungatedUse = 'import { reserveX } from "@/lib/x";\nexport async function use(store) {\n  return reserveX(store);\n}\n';
const sitesEntry = (state: "gated" | "pending"): Record<string, PrimitiveEntry> => ({ "lib/x.ts#reserveX": { state: "sites", sites: { "lib/y.ts#use": state === "gated" ? { state, calls: 1 } : { state, calls: 1, why: "not yet" } } } });
is("a gated site passes", audit(new Map([["lib/x.ts", def], ["lib/y.ts", gatedUse]]), sitesEntry("gated"), false), []);
is("a site claimed gated without the gate fails", audit(new Map([["lib/x.ts", def], ["lib/y.ts", ungatedUse]]), sitesEntry("gated"), false), ["lib/x.ts#reserveX: lib/y.ts#use claimed gated, but no reservePaidResourceWindow( before line 3"]);
is("a new caller without a classification fails", audit(new Map([["lib/x.ts", def], ["lib/y.ts", gatedUse], ["lib/z.ts", ungatedUse]]), sitesEntry("gated"), false), ["lib/x.ts#reserveX: unclassified call in lib/z.ts#use (line 3)"]);
is("a pending site with the key true fails", audit(new Map([["lib/x.ts", def], ["lib/y.ts", ungatedUse]]), sitesEntry("pending"), true), ["resourceAllocations is true with 1 pending primitive calls"]);
is("a method of the same name elsewhere is not a call", audit(new Map([["lib/x.ts", def], ["lib/y.ts", gatedUse + "export function other(a) {\n  return a.reserveX(1);\n}\n"]]), sitesEntry("gated"), false), []);
const selfDef = 'export async function reserveY(store) {\n  if (!(await helper(store))) return false;\n  return true;\n}\nasync function helper(store) {\n  return !(store.period?.funded === true && !(await reservePaidResourceWindow(store)));\n}\n';
const selfEntry: Record<string, PrimitiveEntry> = { "lib/x.ts#reserveY": { state: "self-gated", via: "helper" } };
is("a primitive gated by its own helper passes", audit(new Map([["lib/x.ts", selfDef]]), selfEntry, false), []);
is("a helper that lost its gate fails", audit(new Map([["lib/x.ts", selfDef.replace("reservePaidResourceWindow(store)", "true")]]), selfEntry, false), ["lib/x.ts#reserveY: helper does not hold reservePaidResourceWindow("]);
is("a primitive that stopped calling its helper fails", audit(new Map([["lib/x.ts", selfDef.replace("await helper(store)", "true")]]), selfEntry, false), ["lib/x.ts#reserveY: does not call helper"]);
const vault = 'export async function openIt(x) {\n  return reserveX(x);\n}\n';
const route = 'import { openIt } from "@/lib/y";\nimport { reserveZ } from "@/lib/z";\nexport async function POST(s) {\n  if (!(await reserveZ(s))) return null;\n  return openIt(s);\n}\n';
const zDef = 'export async function reserveZ(store) {\n  return !(store.period?.funded === true && !(await reservePaidResourceWindow(store)));\n}\n';
const byCallers: Record<string, PrimitiveEntry> = { "lib/z.ts#reserveZ": { state: "self-gated", via: "reserveZ" }, "lib/x.ts#reserveX": { state: "sites", sites: { "lib/y.ts#openIt": { state: "gated-by-callers", calls: 1, guard: "reserveZ" } } } };
const withVault = (r: string) => new Map([["lib/x.ts", def], ["lib/y.ts", 'import { reserveX } from "@/lib/x";\n' + vault], ["lib/z.ts", zDef], ["app/r.ts", r]]);
is("a site gated by every caller's guard passes", audit(withVault(route), byCallers, false), []);
is("a caller that skips the guard fails", audit(withVault(route.replace("if (!(await reserveZ(s))) return null;\n", "")), byCallers, false), ["lib/x.ts#reserveX: lib/y.ts#openIt is called in app/r.ts#POST (line 4) without reserveZ before it"]);
is("a primitive that is gone fails", audit(new Map([["lib/x.ts", "export const n = 1;\n"]]), selfEntry, false), ["lib/x.ts#reserveY: the primitive is not declared there any more"]);
done();
