import { existsSync, readFileSync } from "node:fs";
import { done, is, part } from "./check";

const pagePath = "app/help/trust-and-safety/page.tsx";
const source = existsSync(pagePath) ? readFileSync(pagePath, "utf8") : "";
part("A public safety guide points to working help without promising unfinished protections");
is("the guide is a public page", /export default function/.test(source), true);
is("it has a clear page title", source.includes('title="Trust and safety"'), true);
is("it does not present guidance as new contract terms", source.includes("effective={null}"), true);
for (const path of ["/report", "/copyright", "/terms", "/help/buyers"]) {
  is(`the guide links to ${path}`, source.includes(`href="${path}"`), true);
  is(`the ${path} destination exists`, existsSync(`app${path}/page.tsx`), true);
}
is("a report link says what it does", source.includes("Report copyright infringement or illegal content"), true);
is("publication checks are scoped to their implemented fields", source.includes("Product titles, summaries, descriptions and sales-page text"), true);
is("the guide states detection limits", source.includes("may miss misleading wording"), true);
is("review ownership stays with the buyer", source.includes("cannot rewrite a buyer"), true);
is("safety guidance does not promise unfinished automatic protections", /(?:automatically (?:refund|block|pause)|within 7 days|guaranteed (?:safe|refund)|registered DMCA agent)/i.test(source), false);
is("the new guide does not add a provider call", /\b(?:fetch|redis|sendEmail)\s*\(/.test(source), false);
done();
