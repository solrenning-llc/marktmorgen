/**
 * The request guard in proxy.ts is the only check another site's request meets on most routes that change something
 * (the security audit of 14 November 2026 counted 156 of 271 with no guard of their own), so it is held here, route
 * by route: every POST, PUT, PATCH and DELETE under app/api is refused from another site, by Origin or, without one,
 * by Sec-Fetch-Site, whatever its path; the one exception is the one-click unsubscribe (RFC 8058); the same site
 * passes on to the route; and the proxy's matcher still sends every /api/ path through it. A change that narrows the
 * matcher or the guard fails here instead of opening the routes quietly.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";
import { config, proxy } from "@/proxy";
import { done, is, part } from "./check";

const CHANGING = ["POST", "PUT", "PATCH", "DELETE"] as const;
const ALLOWED_CROSS_SITE = new Set(["/api/mail/unsubscribe"]);

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routes(path);
    return name === "route.ts" ? [path] : [];
  });
}

/** The path a request would name for a route file: each [segment] filled with a stand-in. */
function pathOf(file: string): string {
  const parts = relative("app", file).split("/").slice(0, -1);
  return "/" + parts.filter((p) => !/^\(.*\)$/.test(p)).map((p) => (p.startsWith("[[...") ? "x" : p.startsWith("[...") ? "x/y" : p.startsWith("[") ? "x" : p)).join("/");
}

const call = (method: string, path: string, headers: Record<string, string>) =>
  proxy(new NextRequest(`https://marktmorgen.com${path}`, { method, headers: { host: "marktmorgen.com", "content-length": "2", ...headers }, ...(method === "GET" ? {} : { body: "{}" }) }));

async function main(): Promise<void> {
  part("The proxy runs on every /api/ path");
  is("its matcher names /api/:path*", config.matcher.includes("/api/:path*"), true);

  const changing = routes("app/api").flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return CHANGING.filter((m) => new RegExp(`export (async )?function ${m}\\b|export const ${m}\\b|export \\{[^}]*\\b${m}\\b`).test(text)).map((method) => ({ method, path: pathOf(file) }));
  });
  is("routes that change something were found", changing.length > 200, true);

  part("Another site is refused on each of them, before the route runs");
  const byOrigin: string[] = [];
  const byFetchSite: string[] = [];
  const sameSite: string[] = [];
  const nullOrigin: string[] = [];
  for (const { method, path } of changing) {
    if (ALLOWED_CROSS_SITE.has(path)) continue;
    if ((await call(method, path, { origin: "https://elsewhere.example" })).status !== 403) byOrigin.push(`${method} ${path}`);
    if ((await call(method, path, { "sec-fetch-site": "cross-site" })).status !== 403) byFetchSite.push(`${method} ${path}`);
    if ((await call(method, path, { "sec-fetch-site": "same-site" })).status !== 403) sameSite.push(`${method} ${path}`);
    if ((await call(method, path, { origin: "null" })).status !== 403) nullOrigin.push(`${method} ${path}`);
  }
  is("by Origin: none let through", byOrigin, []);
  is("by Sec-Fetch-Site cross-site, with no Origin: none let through", byFetchSite, []);
  is("a sibling site (same-site) is another site too: none let through", sameSite, []);
  is("an Origin of null: none let through", nullOrigin, []);
  is("a subdomain of ours is another origin", (await call("POST", "/api/store/links", { origin: "https://shop.marktmorgen.com" })).status, 403);

  part("The same site passes on to the route");
  const passed = await call("POST", "/api/store/links", { origin: "https://marktmorgen.com", "sec-fetch-site": "same-origin" });
  is("handed on, not answered by the proxy", [passed.status, passed.headers.get("x-middleware-next")], [200, "1"]);
  const read = await call("GET", "/api/store/links", { origin: "https://elsewhere.example" });
  is("a read from another site is not the guard's to refuse", read.headers.get("x-middleware-next"), "1");

  part("The one exception: the one-click unsubscribe");
  is("it is a route that exists", changing.some((r) => r.path === "/api/mail/unsubscribe" && r.method === "POST"), true);
  const unsub = await call("POST", "/api/mail/unsubscribe", { origin: "https://mail.example" });
  is("a mail app's page may press it", unsub.headers.get("x-middleware-next"), "1");
  is("and nothing else is exempt", [...ALLOWED_CROSS_SITE], ["/api/mail/unsubscribe"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
