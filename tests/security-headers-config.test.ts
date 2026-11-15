/**
 * The response headers next.config.ts gives every address, read from the
 * real config object the build uses (withBotId included), not from its text.
 *
 * - No `X-Powered-By: Next.js`: it names the framework to every scanner and
 *   helps no visitor. Next sends it unless poweredByHeader is false.
 * - Every page outside the pasted card keeps a Content-Security-Policy with
 *   frame-ancestors and X-Frame-Options; the API keeps its sandbox; HSTS,
 *   nosniff, Referrer-Policy and Permissions-Policy reach all of them.
 * - An address under /embed/ that is not the card (/embed/x, /embed/a/b/c)
 *   is left out of next.config's page rule, and proxy.ts gives a policy only
 *   to the card; it was sent with neither CSP nor X-Frame-Options, so any
 *   site could frame it. It gets the static page policy and X-Frame-Options
 *   from next.config (not the nonce policy: the proxy puts no nonce on
 *   its request, so its scripts are written without one).
 * - The same address in another case (/Embed/kitchen/abc) escapes the page
 *   rule, as Next matches header sources case-insensitively; the proxy
 *   sends it to the lowercase address.
 */
import nextConfig from "../next.config";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { dynamicPolicy, isDynamicPage, isEmbedPage, staticPolicy } from "@/lib/csp";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { done, is, part } from "./check";

type Header = { key: string; value: string };
type Rule = { source: string; headers: Header[] };

async function main(): Promise<void> {
  part("framework banner");
  is("poweredByHeader is false, so no X-Powered-By is sent", nextConfig.poweredByHeader, false);

  part("headers per address");
  const rules = (await nextConfig.headers!()) as Rule[];
  const names = (source: string) => (rules.find((r) => r.source === source)?.headers ?? []).map((h) => h.key.toLowerCase());
  const pages = names("/((?!embed/).*)");
  for (const name of ["content-security-policy", "x-frame-options", "strict-transport-security", "x-content-type-options", "referrer-policy", "permissions-policy"]) {
    is(`pages carry ${name}`, pages.includes(name), true);
  }
  const embed = names("/embed/:path*");
  is("the pasted card is sent without X-Frame-Options", embed.includes("x-frame-options"), false);
  is("the pasted card still carries HSTS and nosniff", embed.includes("strict-transport-security") && embed.includes("x-content-type-options"), true);
  const api = rules.find((r) => r.source === "/api/:path*")?.headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
  is("the API answers are sandboxed and never framed", /default-src 'none'/.test(api) && /\bsandbox\b/.test(api) && /frame-ancestors 'none'/.test(api), true);

  part("addresses under /embed/ that are not the card");
  // The last rule that names a header decides it, as Next applies them in order.
  const sent = (path: string) => {
    const out = new Map<string, string>();
    for (const rule of rules) {
      // As Next compiles header sources: strict, and case-insensitive.
      if (!getPathMatch(rule.source, { strict: true, removeUnnamedParams: true, sensitive: false })(path)) continue;
      for (const h of rule.headers) out.set(h.key.toLowerCase(), h.value);
    }
    return out;
  };
  for (const path of ["/embed/kitchen", "/embed/a/b/c", "/embed/kitchen/abc/book", "/embed/x.png"]) {
    is(`${path} is not the card and gets no policy from the proxy`, isEmbedPage(path) || isDynamicPage(path), false);
    const headers = sent(path);
    is(`${path} is sent the static page policy`, headers.get("content-security-policy"), staticPolicy());
    is(`${path} is sent X-Frame-Options`, headers.get("x-frame-options"), "SAMEORIGIN");
  }
  for (const path of ["/embed/kitchen/abc", "/embed/kitchen/join"]) {
    const headers = sent(path);
    is(`the card ${path} is sent no X-Frame-Options and no fixed policy`, [headers.has("x-frame-options"), headers.has("content-security-policy")], [false, false]);
    is(`the card ${path} gets its framable nonce policy from the proxy`, isDynamicPage(path) && /frame-ancestors \*/.test(dynamicPolicy("n", { store: false, embed: isEmbedPage(path) })), true);
    const res = await proxy(new NextRequest(`https://marktmorgen.com${path}`, { headers: { host: "marktmorgen.com" } }));
    is(`the proxy serves the card ${path} with its nonce policy`, [res.headers.get("location"), /frame-ancestors \*/.test(res.headers.get("content-security-policy") ?? "")], [null, true]);
  }

  part("the card's address in another case");
  /*
   * Next matches header sources case-insensitively, so /Embed/kitchen/abc
   * escapes the page rule and matches only the common /embed/ rule, while the
   * card route and isEmbedPage are case-sensitive: it answers the not-found
   * page with neither a policy nor X-Frame-Options. The proxy sends any
   * /embed/ address not written in lowercase to the lowercase one, which the
   * rules above cover.
   */
  for (const path of ["/Embed/kitchen/abc", "/EMBED/kitchen/join", "/eMbEd/kitchen/abc/", "/Embed/kitchen"]) {
    if (path.split("/").filter(Boolean).length === 3) is(`${path} gets no policy from next.config's page rules`, sent(path).has("x-frame-options"), false);
    const res = await proxy(new NextRequest(`https://marktmorgen.com${path}?a=1`, { headers: { host: "marktmorgen.com" } }));
    const to = new URL(res.headers.get("location") ?? "https://none.invalid/");
    is(`${path} is sent to its lowercase address`, [res.status, to.host, to.pathname, to.search], [308, "marktmorgen.com", path.replace(/^\/embed\//i, "/embed/"), "?a=1"]);
  }
}

main().then(done);
