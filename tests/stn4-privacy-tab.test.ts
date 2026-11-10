/**
 * 757 [STN4], unit 4: one "Privacy" page in the studio for the person's own account (app/studio/privacy).
 *
 * It gathers what already works today, and adds no new data handling: the store's data file
 * (/api/store/export), logging out of other devices (/studio/devices) or of all of them
 * (/api/auth/signout-all), passkeys and two-step login (the studio home's #account), deleting an
 * extra store (the same #account card), and asking for the account to be deleted by email, as the
 * Privacy Policy's section 8 says. The test checks:
 * - the rules: each choice follows the role's own permission and the plan's standing, exactly as the
 *   studio home decides it, so the page never offers a button the home would not draw;
 * - the markup (AX274, WCAG 2.2 AAA): one h1, an h2 per group in order, 44px targets, real links and
 *   forms only, no timer, the person's own address and nobody else's;
 * - the wiring: every link goes to a page, route or anchor that exists, the page counts as one studio
 *   page like any other, the studio home links to it, and lib/studio-modules.ts gives it its line.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { privacyChoices } from "@/lib/studio-privacy";
import { StudioPrivacy } from "@/components/studio-privacy";
import { NOT_MODULES } from "@/lib/studio-modules";
import { ENDED_STORE_EXPORTS } from "@/lib/plan-closing-rules";
import { sectionId } from "@/components/legal-page";
import type { Role } from "@/lib/team-roles";
import type { Standing } from "@/lib/plan-standing";
import { done, is, part } from "./check";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

part("rules: the data file follows the role and the plan, as on the studio home");
const roles: Role[] = ["owner", "admin", "editor", "support"];
const standings: Standing[] = ["paid", "trial", "ended", "none"];
for (const role of roles) {
  for (const standing of standings) {
    const mayExport = role === "owner" || role === "admin";
    const want = !mayExport ? "role" : standing === "paid" || standing === "trial" ? "file" : "after-plan";
    is(`${role}, ${standing}: data ${want}`, privacyChoices({ role, standing, extra: true }).data, want);
  }
}

part("rules: deleting a store follows the role and whether it is an extra store");
is("owner, extra store: delete here", privacyChoices({ role: "owner", standing: "paid", extra: true }).deleteStore, "here");
is("owner, first store: no button", privacyChoices({ role: "owner", standing: "paid", extra: false }).deleteStore, "first");
for (const role of ["admin", "editor", "support"] as Role[]) {
  is(`${role}: only the owner deletes`, privacyChoices({ role, standing: "paid", extra: true }).deleteStore, "role");
}

const render = (role: Role, standing: Standing, extra: boolean, email = "maria@example.test") =>
  renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: { push() {}, refresh() {}, prefetch() {} } as never },
      createElement(StudioPrivacy, {
        email,
        sid: "s1",
        studioHref: "/studio?store=s1",
        devicesHref: "/studio/devices?store=s1",
        choices: privacyChoices({ role, standing, extra }),
      }),
    ),
  );

const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
const forms = (html: string) => [...html.matchAll(/<form [^>]*>/g)].map((m) => m[0]);
/**
 * The text a piece of server-rendered markup shows: every character outside a tag, read in one pass. It reads the
 * markup (as a browser's text content would), it does not clean it, so nothing it returns is ever put back into a page.
 */
const textOf = (markup: string) => {
  let text = "";
  let inTag = false;
  for (const char of markup) {
    if (inTag) inTag = char !== ">";
    else if (char === "<") inTag = true;
    else text += char;
  }
  return text;
};
const headings = (html: string, level: number) =>
  [...html.matchAll(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, "g"))].map((m) => textOf(m[1]));

part("markup: owner of a paid extra store sees every choice");
const owner = render("owner", "paid", true);
is("one h1, Privacy", headings(owner, 1), ["Privacy"]);
is("the groups, in order", headings(owner, 2), ["A copy of your data", "Where you are logged in", "Deleting", "What we keep and why"]);
is("each group is a section named by its heading", (owner.match(/<section aria-labelledby="privacy-[a-z-]+"/g) ?? []).length, 4);
is("the data file is a GET form to the export route", forms(owner).some((f) => f.includes('action="/api/store/export"') && f.includes('method="get"')), true);
is("the file is this store's, the whole store", owner.includes('name="store" value="s1"') && owner.includes('name="what" value="store"'), true);
is("log out of all devices is the existing POST form", forms(owner).some((f) => f.includes('action="/api/auth/signout-all"') && f.includes('method="post"')), true);
is("log out of other devices links to the page that asks first", hrefs(owner).includes("/studio/devices?store=s1"), true);
is("passkeys and two-step open the studio home's account card", hrefs(owner).includes("/studio?store=s1#account"), true);
is("deleting this store is named", owner.includes("Delete this store"), true);
is("deleting this store opens its own place on the studio home", hrefs(owner).includes("/studio?store=s1#delete-store"), true);
is("the account is asked for by email", hrefs(owner).includes("mailto:support@marktmorgen.com"), true);
is("section 8 of the Privacy Policy is linked", hrefs(owner).includes(`/privacy#${sectionId("8. Your rights, including under the GDPR")}`), true);
is("the Privacy Policy is linked", hrefs(owner).includes("/privacy"), true);
is("logging in, in the policy", hrefs(owner).includes("/privacy#signing-in"), true);
is("closing stores, in the policy", hrefs(owner).includes("/privacy#closed-stores"), true);
is("the person's own address is shown", owner.includes("maria@example.test"), true);
const addresses = new Set(owner.match(/[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]+/gi) ?? []);
is("no address but the person's own and support's", [...addresses].sort(), ["maria@example.test", "support@marktmorgen.com"]);
is("an address that looks like markup is escaped", render("owner", "paid", true, "a<b@example.test").includes("a<b@"), false);

part("markup: AX274 targets, link purpose, no timer");
const targets = [...owner.matchAll(/<(a|button)\s[^>]*class="([^"]*)"/g)];
is("every link and button is drawn", targets.length >= 9, true);
for (const [, tag, cls] of targets) {
  // .btn is inline-flex, centered, with a 48px minimum (app/globals.css), so tests/tap-targets.test.ts wants no min-h-11 beside it.
  is(`${tag} ${cls.slice(0, 40)}: at least 44px tall`, /\bmin-h-11\b/.test(cls) || /(^|\s)btn(\s|$)/.test(cls), true);
}
const names = [...owner.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((m) => textOf(m[1]).trim());
is("no link named by a bare word", names.filter((n) => /^(here|more|click here|link|this)$/i.test(n)), []);
is("link names are unique", new Set(names).size, names.length);
const component = read("components/studio-privacy.tsx");
const pageSource = read("app/studio/privacy/page.tsx");
for (const [name, source] of [["component", component], ["page", pageSource]] as const) {
  is(`${name}: no timer or refresh`, /setTimeout|setInterval|http-equiv="refresh"|httpEquiv/.test(source), false);
  is(`${name}: no client code`, source.includes('"use client"'), false);
}
is("only existing color tokens", /#[0-9a-f]{3,6}\b|rgb\(/i.test(component), false);

part("markup: an ended store gets no button, and is told where the file is");
const ended = render("owner", "ended", true);
is("no export form", forms(ended).some((f) => f.includes("/api/store/export")), false);
is("says when the file can be had", ended.includes("while your store has a plan or a free trial"), true);
is("says how often after a plan ends", ended.includes(ENDED_STORE_EXPORTS === 1 ? "once more" : `${ENDED_STORE_EXPORTS} more times`), true);
const none = render("owner", "none", false);
is("a store with no plan: no export form", forms(none).some((f) => f.includes("/api/store/export")), false);

part("markup: a team member sees only their own login choices");
const editor = render("editor", "paid", true);
is("editor: no export form", forms(editor).some((f) => f.includes("/api/store/export")), false);
is("editor: told who can download it", editor.includes("The store’s owner and its admins can download it."), true);
is("editor: no delete of the store", editor.includes("Delete this store"), false);
is("editor: told how to leave", editor.includes("Leaving this store"), true);
is("editor: still logs out of other devices", hrefs(editor).includes("/studio/devices?store=s1"), true);
is("editor: still asks for the account by email", hrefs(editor).includes("mailto:support@marktmorgen.com"), true);
const admin = render("admin", "trial", true);
is("admin in a trial: the export form", forms(admin).some((f) => f.includes("/api/store/export")), true);
is("admin: no delete of the store", admin.includes("Delete this store"), false);
const first = render("owner", "paid", false);
is("first store: no delete link", first.includes("Delete this store"), false);
is("first store: says so", first.includes("Your first store has no delete button in the studio."), true);

part("wiring: every place linked exists");
is("the export route", existsSync(join(root, "app/api/store/export/route.ts")), true);
is("the log out of all devices route", existsSync(join(root, "app/api/auth/signout-all/route.ts")), true);
is("the devices page", existsSync(join(root, "app/studio/devices/page.tsx")), true);
const policy = read("app/privacy/page.tsx");
is("the policy has #signing-in", policy.includes('id="signing-in"'), true);
is("the policy has #closed-stores", policy.includes('id="closed-stores"'), true);
is("the policy has section 8", policy.includes('title="8. Your rights, including under the GDPR"'), true);
is("section 8 names support's address", policy.includes("mailto:support@marktmorgen.com"), true);
const home = read("app/studio/page.tsx");
is("the studio home has #account", home.includes('id="account"'), true);
is("#account holds Delete this store", home.slice(home.indexOf('id="account"')).includes("Delete this store"), true);
is("Delete this store is the anchor #delete-store, drawn on the same condition", /store\.extra && may\("delete"\) \? \(\s*<details id="delete-store"[^>]*>\s*<summary[^>]*>\s*Delete this store/.test(home), true);
is("#account holds Leaving this store", home.slice(home.indexOf('id="account"')).includes("Leaving this store"), true);
is("#account holds the passkeys and two-step login", /id="account"[\s\S]*<PasskeyManager[\s\S]*<TwoStepManager/.test(home), true);

part("wiring: the page, the studio home and the module list");
is("the page reads the person's own view, for any role", /studioView\(\s*await cookies\(\),[^;]*,\s*null\s*\)/.test(pageSource), true);
is("the page counts as one studio page, like any other", pageSource.includes("count: false"), false);
is("a signed-out visitor goes to the login page", pageSource.includes('redirect("/signin")'), true);
is("the page draws StudioPrivacy with the view's own email", /<StudioPrivacy[\s\S]*email=\{view\.email\}/.test(pageSource), true);
is("the page is not indexed", pageSource.includes("index: false"), true);
is("the studio home links to it", home.includes('studioPath(store, "", "privacy")'), true);
is("lib/studio-modules.ts gives it a line", typeof NOT_MODULES.privacy === "string" && NOT_MODULES.privacy.length > 10, true);

done();
