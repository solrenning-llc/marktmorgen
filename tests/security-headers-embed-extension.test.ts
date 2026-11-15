/**
 * The MEDIUM on #4093 (Claude 3 cloud G, 13/11/2026), a sibling of the one fixed there: a two-part /embed/ address
 * whose last part has an extension (/Embed/kitchen/abc.html, /embed/kitchen/abc.png) went out with neither a
 * Content-Security-Policy nor X-Frame-Options. proxy.ts's matcher skips every path that ends in an extension, so its
 * 308 to the lowercase address never runs; next.config's page rule leaves /embed/ out (matched case-insensitively);
 * /embed/:one and /embed/:one/:two/:rest+ need one part or three and more; only the common /embed/:path* rule applied.
 * A card's product id has no dot, so such an address is never the card and gets the static page policy.
 */
import nextConfig from "../next.config";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { staticPolicy } from "@/lib/csp";
import { done, is, part } from "./check";

type Header = { key: string; value: string };
type Rule = { source: string; headers: Header[] };

async function main(): Promise<void> {
  const rules = (await nextConfig.headers!()) as Rule[];
  // The last rule that names a header decides it, as Next applies them in order; strict and case-insensitive.
  const sent = (path: string) => {
    const out = new Map<string, string>();
    for (const rule of rules) {
      if (!getPathMatch(rule.source, { strict: true, removeUnnamedParams: true, sensitive: false })(path)) continue;
      for (const h of rule.headers) out.set(h.key.toLowerCase(), h.value);
    }
    return out;
  };
  part("A two-part /embed/ address whose last part has an extension is a page, not the card");
  for (const path of ["/Embed/kitchen/abc.html", "/Embed/kitchen/abc.png", "/EMBED/kitchen/join.js", "/embed/kitchen/abc.html", "/embed/kitchen/abc.png"]) {
    const headers = sent(path);
    is(`${path} is sent the static page policy`, headers.get("content-security-policy"), staticPolicy());
    is(`${path} is sent X-Frame-Options`, headers.get("x-frame-options"), "SAMEORIGIN");
  }
  part("The card itself is unchanged");
  for (const path of ["/embed/kitchen/abc", "/embed/kitchen/join"]) {
    const headers = sent(path);
    is(`the card ${path} is sent no X-Frame-Options and no fixed policy`, [headers.has("x-frame-options"), headers.has("content-security-policy")], [false, false]);
  }
  done();
}

void main();
