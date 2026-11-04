/**
 * 631 [AA1] step (a): every studio action has an agent tool or a reason why
 * not (lib/agent-coverage.ts). Reads the route files themselves, so a new
 * studio route or method fails here until its row says how the agent reaches it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { AGENT_COVERAGE, MONEY_PREFIXES, type AgentAction, coverageCounts } from "@/lib/agent-coverage";
import { done, is, part } from "./check";

const root = process.cwd();
const api = join(root, "app/api");

/** The studio's own guards (lib/store-request.ts, lib/studio-route.ts): a route that calls one is a studio action. */
const STUDIO_GUARD = /\b(guardStoreWrite|jsonAccess|creatorFrom|studioAccess|resolveAccess|countStudio)\(/;
const METHOD = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\b/g;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "route.ts" ? [path] : [];
  });
}

/** "METHOD path" for every method of every studio route. */
export function studioActions(files: string[]): string[] {
  const keys: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!STUDIO_GUARD.test(text)) continue;
    const path = relative(api, file).split(sep).slice(0, -1).join("/");
    for (const match of text.matchAll(METHOD)) keys.push(`${match[1] ?? match[2]} ${path}`);
  }
  return keys.sort();
}

const found = studioActions(routeFiles(api));
const listed = Object.keys(AGENT_COVERAGE).sort();

part("Every studio action is in the table, and nothing else");
is("the scan finds the studio's routes (not an empty or broken scan)", found.length >= 150, true);
is("studio actions with no row (add one to lib/agent-coverage.ts)", found.filter((k) => !Object.hasOwn(AGENT_COVERAGE, k)), []);
is("rows for actions that are gone", listed.filter((k) => !found.includes(k)), []);

part("Each row is complete");
const AREAS = new Set(["products", "pages", "courses", "calls", "files", "email", "community", "podcast", "affiliates", "offers", "numbers", "buyers", "settings", "connections", "access", "money"]);
const rows = Object.entries(AGENT_COVERAGE) as [string, AgentAction][];
is("every row has a known area", rows.filter(([, a]) => !AREAS.has(a.area)).map(([k]) => k), []);
is("every refusal says why", rows.filter(([, a]) => a.reach.kind === "never" && a.reach.why.trim().length < 40).map(([k]) => k), []);
is("every note says something", rows.filter(([, a]) => a.note !== undefined && a.note.trim().length < 10).map(([k]) => k), []);

part("Tools named here are served by the MCP server");
const mcp = readFileSync(join(api, "mcp/route.ts"), "utf8");
const named = [...new Set(rows.flatMap(([, a]) => (a.reach.kind === "tool" ? a.reach.tools : [])))];
is("at least one tool is named", named.length > 0, true);
is("tools that the MCP server does not serve", named.filter((name) => !mcp.includes(`"${name}"`)), []);

part("Money is never moved by the agent (631 (c))");
const money = rows.filter(([k]) => MONEY_PREFIXES.some((p) => k.split(" ")[1].startsWith(p)));
is("money routes are found", money.length >= 15, true);
is("money routes that are not \"never\"", money.filter(([, a]) => a.reach.kind !== "never").map(([k]) => k), []);
is("money routes are filed under money", money.filter(([, a]) => a.area !== "money").map(([k]) => k), []);

part("The measure");
const counts = coverageCounts();
is("counts add up to the table", Object.values(counts).reduce((a, b) => a + b, 0), listed.length);
is("the scanner reads both declaration styles", studioActionsOf("export const GET = handler; guardStoreWrite(x)"), ["GET x"]);
console.log(`  ${listed.length} studio actions: ${counts.tool} tool, ${counts.read} read, ${counts.draft} draft, ${counts.execute} execute, ${counts.never} never`);

function studioActionsOf(text: string): string[] {
  if (!STUDIO_GUARD.test(text)) return [];
  return [...text.matchAll(METHOD)].map((m) => `${m[1] ?? m[2]} x`);
}

done();
