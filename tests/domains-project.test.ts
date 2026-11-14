/**
 * Which Vercel project a creator's domain is added to (lib/domains.ts).
 *
 * The project was renamed from nimbus-labs to marktmorgen on 12 October 2026,
 * and every call by the old name has answered "not found" since. The project's
 * id survives a rename, so it is what the calls name whenever the host gives
 * it. What is checked:
 *
 *   - with VERCEL_PROJECT_ID set, every call names that id;
 *   - VERCEL_DOMAINS_PROJECT, when set, still wins;
 *   - with neither, the calls name the project's current name, never the old one;
 *   - checking a domain's status (which keeps its own local named project) runs.
 */
import { domainStatus, verifyDomain } from "@/lib/domains";
import { done, is, part } from "./check";

type Seen = { method: string; url: string };

async function pathsWith(env: Record<string, string | undefined>): Promise<Seen[]> {
  const before = { ...process.env };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  process.env.VERCEL_API_TOKEN = "test-token";
  const seen: Seen[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ method: init?.method ?? "GET", url: String(input) });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await verifyDomain("shop.example.com");
    await domainStatus("shop.example.com", { sid: "s_test", handle: "shop", previousHandles: [] });
  } finally {
    globalThis.fetch = realFetch;
    for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name];
    Object.assign(process.env, before);
  }
  return seen;
}

async function main() {
  part("The project's id, when the host gives it");
  const byId = await pathsWith({ VERCEL_PROJECT_ID: "prj_test123", VERCEL_DOMAINS_PROJECT: undefined });
  is("the verify call names the id", byId.map((s) => new URL(s.url).pathname), ["/v9/projects/prj_test123/domains/shop.example.com/verify", "/v9/projects/prj_test123/domains/shop.example.com", "/v6/domains/shop.example.com/config"]);
  is("the status check names the id in its query too", byId.some((s) => new URL(s.url).searchParams.get("projectIdOrName") === "prj_test123"), true);

  part("An explicit setting still wins");
  const explicit = await pathsWith({ VERCEL_PROJECT_ID: "prj_test123", VERCEL_DOMAINS_PROJECT: "chosen" });
  is("the verify call names the setting", explicit.map((s) => new URL(s.url).pathname), ["/v9/projects/chosen/domains/shop.example.com/verify", "/v9/projects/chosen/domains/shop.example.com", "/v6/domains/shop.example.com/config"]);

  part("With neither, the current name");
  const byName = await pathsWith({ VERCEL_PROJECT_ID: undefined, VERCEL_DOMAINS_PROJECT: undefined });
  is("the verify call names marktmorgen", byName.map((s) => new URL(s.url).pathname), ["/v9/projects/marktmorgen/domains/shop.example.com/verify", "/v9/projects/marktmorgen/domains/shop.example.com", "/v6/domains/shop.example.com/config"]);
  is("no call names the old project", [...byId, ...explicit, ...byName].some((s) => s.url.includes("nimbus-labs")), false);

  done();
}

void main();
