/**
 * Dark mode, stage 2 (complement WG (a) of 274 [AX1]): the switch ("Light", "Dark", "Match my device"), the script in
 * <head> that applies the choice before the first paint, and the proof that every color pair the covered pages draw
 * is AAA with the dark tokens on. Each part fails on the wrong behavior it names:
 *   - the script touching the page for someone who chose nothing, or chose light, or whose storage is broken;
 *   - the script not applying a dark or "Match my device" choice, or not following the device;
 *   - the script's hash out of step with the policy, so it would be refused;
 *   - the layout writing anything else new, or a default other than light;
 *   - the switch without a name, a state or keyboard operation, or keeping anything but one value in this browser;
 *   - a cookie, or anything sent anywhere;
 *   - any pair on a covered page under 7:1 (4.5:1 for large text), or a color the proof cannot read;
 *   - dark colors reaching a page the proof has not read.
 * What it cannot see: colors set by a script at run time, images, and a person using the page with a screen reader.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COLOR_SCHEME_HASH, COLOR_SCHEME_KEY, COLOR_SCHEME_SCRIPT, isDark, toChoice } from "@/lib/color-scheme";
import { DARK_OVERRIDES, DARK_OVERRIDE_PREFIX, DARK_READY, DARK_SELECTOR, DARK_BLOCK_START, DARK_BLOCK_END, LEGACY_TOKENS } from "@/lib/dark-tokens";
import { dynamicPolicy } from "@/lib/csp";
import { ColorSchemeSwitch, chooseColorScheme, followStoredChoice } from "@/components/color-scheme-switch";
import AccessibilityPage from "@/app/accessibility/page";
import { closure, pagePairs, pagesUsing } from "./dark-pairs";
import { done, is, part } from "./check";

const read = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------- a stand-in browser for the script

type Call = string;
function browser(first: string | null | "throws", deviceDark = false, startDark = false) {
  const calls: Call[] = [];
  // What the key holds now: the switch, or another tab, may change it while the page is open.
  const box = { stored: first };
  const attrs = new Map<string, string>(startDark ? [["data-color-scheme", "dark"]] : []);
  const listeners: (() => void)[] = [];
  const media = {
    matches: deviceDark,
    addEventListener: (type: string, f: () => void) => {
      calls.push(`listen ${type}`);
      listeners.push(f);
    },
  };
  const root = {
    setAttribute: (k: string, v: string) => {
      calls.push(`set ${k}=${v}`);
      attrs.set(k, v);
    },
    removeAttribute: (k: string) => {
      calls.push(`remove ${k}`);
      attrs.delete(k);
    },
    hasAttribute: (k: string) => attrs.has(k),
  };
  const localStorage = {
    getItem: (k: string) => {
      calls.push(`read ${k}`);
      if (box.stored === "throws") throw new Error("storage refused");
      return box.stored;
    },
  };
  const window = { matchMedia: (q: string) => (calls.push(`media ${q}`), media) };
  const document = { documentElement: root };
  return { calls, attrs, media, listeners, box, sandbox: { window, document, localStorage } };
}
const run = (b: ReturnType<typeof browser>) => runInNewContext(COLOR_SCHEME_SCRIPT, b.sandbox);
const writes = (b: ReturnType<typeof browser>) => b.calls.filter((c) => /^(set|remove|listen)/.test(c));

part("With nothing chosen, the script touches nothing: the page is drawn exactly as before");
for (const [what, value] of [["nothing stored", null], ["light", "light"], ["an unknown value", "sepia"], ["a different case", "Dark"], ["a padded value", " dark"], ["an empty value", ""]] as const) {
  const b = browser(value);
  run(b);
  is(`${what}: one read of its own key, no attribute, no listener`, [b.calls, [...b.attrs]], [[`read ${COLOR_SCHEME_KEY}`], []]);
}
const broken = browser("throws");
let threw = false;
try {
  run(broken);
} catch {
  threw = true;
}
is("storage that refuses (a private window): no error and nothing written", [threw, writes(broken)], [false, []]);
is("\"Match my device\" on a light device: nothing written but the listener", writes((() => { const b = browser("system", false); run(b); return b; })()), ["listen change"]);

part("A choice of dark, or of the device's dark, is applied before the first paint");
const dark = browser("dark");
run(dark);
is("dark: the one attribute, and nothing else", [writes(dark), [...dark.attrs]], [["set data-color-scheme=dark"], [["data-color-scheme", "dark"]]]);
const sys = browser("system", true);
run(sys);
is("\"Match my device\" on a dark device: dark, and it follows the device", writes(sys), ["set data-color-scheme=dark", "listen change"]);
sys.media.matches = false;
sys.listeners.forEach((f) => f());
is("the device turning light turns the page light", [...sys.attrs], []);
sys.media.matches = true;
sys.listeners.forEach((f) => f());
is("and dark again", [...sys.attrs], [["data-color-scheme", "dark"]]);
is("it asks the device only through the standard query", sys.calls.filter((c) => c.startsWith("media")), ["media (prefers-color-scheme: dark)"]);
// Claude 1's review 6799166638: the head script's device listener outlived the reader's choice.
for (const [picked, device, after] of [["light", true, []], ["dark", false, [["data-color-scheme", "dark"]]]] as const) {
  const b = browser("system", !device);
  run(b);
  // The reader picks in the switch, which keeps the choice and draws it (components/color-scheme-switch.tsx).
  b.box.stored = picked === "light" ? null : picked;
  if (picked === "dark") b.attrs.set("data-color-scheme", "dark");
  else b.attrs.delete("data-color-scheme");
  b.media.matches = device;
  b.listeners.forEach((f) => f());
  is(`loaded on "Match my device", then ${picked} picked: the device turning ${device ? "dark" : "light"} changes nothing`, [...b.attrs], after);
}
const noMedia = browser("system", true);
(noMedia.sandbox.window as { matchMedia?: unknown }).matchMedia = undefined;
run(noMedia);
is("a browser that cannot tell: light, nothing written", writes(noMedia), []);

part("The choice is read the same way everywhere");
is("only dark and system are kept choices; anything else is light", ["dark", "system", "light", "x", null, undefined].map((v) => toChoice(v as string | null)), ["dark", "system", "light", "light", "light", "light"]);
is("dark draws dark; system follows the device; light never does", [isDark("dark", false), isDark("system", true), isDark("system", false), isDark("light", true)], [true, true, false, false]);
is("the script's key is the module's", COLOR_SCHEME_SCRIPT.includes(`localStorage.getItem("${COLOR_SCHEME_KEY}")`), true);

part("No cookie and nothing sent: the choice stays in this browser");
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const switchSource = code("components/color-scheme-switch.tsx");
const moduleSource = code("lib/color-scheme.ts");
is("no cookie, no request, no beacon in the script, the module or the switch", [COLOR_SCHEME_SCRIPT, moduleSource, switchSource].map((s) => /cookie|fetch\(|XMLHttpRequest|sendBeacon|new Image|navigator\./.test(s)), [false, false, false]);
is("so the privacy policy needs no new sentence: it describes cookies, and none is set", /mm-color-scheme/.test(read("app/privacy/page.tsx")), false);

part("The policy allows the script by its own hash");
is("the hash is the script's", COLOR_SCHEME_HASH, `'sha256-${createHash("sha256").update(COLOR_SCHEME_SCRIPT, "utf8").digest("base64")}'`);
const scripts = dynamicPolicy("abc", { store: false }).split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
is("a page rendered per visit allows it beside its nonce", [scripts.includes(COLOR_SCHEME_HASH), scripts.includes("'nonce-abc'")], [true, true]);

part("The layout adds the script in <head> and nothing else");
const layout = read("app/layout.tsx");
is("one <head>, holding exactly the module's script", [layout.split("<head>").length - 1, /<head>\s*<script\s+dangerouslySetInnerHTML=\{\{\s*__html: COLOR_SCHEME_SCRIPT,\s*\}\}\s*\/>\s*<\/head>/.test(layout)], [1, true]);
const html = /<html\s([\s\S]*?)>/.exec(layout)?.[1] ?? "";
is("<html> still starts light: no color attribute or class of its own, and React told to expect the script's", [/color-scheme|dark/.test(html), /suppressHydrationWarning/.test(html)], [false, true]);
const importers: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name).replace(/\\/g, "/");
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(name) && p !== "components/color-scheme-switch.tsx" && read(p).includes("@/components/color-scheme-switch")) importers.push(p);
  }
};
["app", "components", "lib"].forEach(walk);
is("the switch is on one page only, so no other page's markup changes", importers, ["app/accessibility/page.tsx"]);

part("The switch: named, its state announced, operated by keyboard");
const markup = renderToStaticMarkup(createElement(ColorSchemeSwitch));
const radios = [...markup.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);
is("a fieldset named by its legend", [/<fieldset/.test(markup), /<legend[^>]*>Page colors<\/legend>/.test(markup)], [true, true]);
is("three native radio buttons, one group: the browser announces the checked one and the arrow keys move it", [radios.length, new Set(radios.map((r) => /name="([^"]+)"/.exec(r)?.[1])).size], [3, 1]);
is("each named by the label around it", [...markup.matchAll(/<label[^>]*><input[^>]*>([^<]+)<\/label>/g)].map((m) => m[1]), ["Light", "Dark", "Match my device"]);
is("before the browser has read the choice: none checked, none pressable (no wrong state is announced)", [radios.some((r) => /checked/.test(r)), radios.every((r) => /disabled/.test(r))], [false, true]);
const note = /aria-describedby="([^"]+)"/.exec(markup)?.[1];
is("the group points to its note, which says light is the default and where the choice is kept", [Boolean(note) && markup.includes(`id="${note}"`), /Light is the default/.test(markup), /kept in this browser only/.test(markup)], [true, true, true]);
is("each choice is a target at least 44 pixels tall (2.5.5)", (markup.match(/<label class="[^"]*min-h-11/g) ?? []).length, 3);
is("the accessibility page shows it, in its own section", [/Light or dark/.test(renderToStaticMarkup(AccessibilityPage())), renderToStaticMarkup(AccessibilityPage()).includes("Match my device")], [true, true]);

part("Choosing keeps one value in this browser and applies it at once");
type Fake = { store: Map<string, string>; attrs: Map<string, string>; dark: boolean; refuse: boolean };
const fake: Fake = { store: new Map(), attrs: new Map(), dark: false, refuse: false };
const g = globalThis as unknown as { window: unknown; document: unknown };
g.window = {
  localStorage: {
    setItem: (k: string, v: string) => {
      if (fake.refuse) throw new Error("full");
      fake.store.set(k, v);
    },
    removeItem: (k: string) => fake.store.delete(k),
    getItem: (k: string) => fake.store.get(k) ?? null,
  },
  matchMedia: () => ({ matches: fake.dark }),
};
g.document = { documentElement: { setAttribute: (k: string, v: string) => fake.attrs.set(k, v), removeAttribute: (k: string) => fake.attrs.delete(k) } };
chooseColorScheme("dark");
is("dark: kept under its key, and the page turns dark now", [[...fake.store], [...fake.attrs]], [[[COLOR_SCHEME_KEY, "dark"]], [["data-color-scheme", "dark"]]]);
chooseColorScheme("light");
is("light: nothing kept at all, and the page is the default again", [[...fake.store], [...fake.attrs]], [[], []]);
fake.dark = true;
chooseColorScheme("system");
is("match my device on a dark device: kept, and dark", [[...fake.store], [...fake.attrs]], [[[COLOR_SCHEME_KEY, "system"]], [["data-color-scheme", "dark"]]]);
fake.refuse = true;
fake.store.clear();
chooseColorScheme("dark");
is("storage refused: the choice still holds on this page, no error", [[...fake.store], [...fake.attrs]], [[], [["data-color-scheme", "dark"]]]);
fake.refuse = false;
// Claude 1's review 6799166638 (LOW): another tab's choice is drawn here too, not only checked in the switch.
fake.store.set(COLOR_SCHEME_KEY, "dark");
fake.attrs.clear();
followStoredChoice();
is("another tab picks dark: this page turns dark as its switch shows", [...fake.attrs], [["data-color-scheme", "dark"]]);
fake.store.delete(COLOR_SCHEME_KEY);
followStoredChoice();
is("and back to light", [...fake.attrs], []);
delete (g as { window?: unknown }).window;
delete (g as { document?: unknown }).document;

part("Every color pair the covered pages draw is AAA with the dark tokens on");
const css = read("app/globals.css");
const pages = pagesUsing("@/components/legal-page");
const files = closure([...pages, "app/layout.tsx"]);
const proof = pagePairs(css, DARK_SELECTOR, files);
is("the covered pages include the accessibility, privacy and terms pages", ["app/accessibility/page.tsx", "app/privacy/page.tsx", "app/terms/page.tsx"].every((p) => pages.includes(p)), true);
is("their components are read too: the menu, the footer, the toast", ["components/site-nav.tsx", "components/site-footer.tsx", "components/toast.tsx", "components/color-scheme-switch.tsx"].every((f) => files.includes(f)), true);
is("every color is one the proof can read; none is guessed", [...new Set(proof.unread)], []);
const failing = proof.pairs.filter((p) => p.ratio < p.min).map((p) => `${p.where}: ${p.fg} on ${p.bg} = ${p.ratio.toFixed(2)} (needs ${p.min})`);
is("no pair under 7:1, or 4.5:1 for a heading", [...new Set(failing)], []);
is("the proof read hundreds of pairs, not a handful", proof.pairs.length > 600, true);
const weakest = Math.min(...proof.pairs.filter((p) => p.min === 7).map((p) => p.ratio));
is("the weakest text pair, recorded so a change is seen", Math.round(weakest * 100) / 100, 7.25);

part("The proof fails when the dark rules are missing");
const start = css.indexOf(DARK_BLOCK_START);
const end = css.indexOf(DARK_BLOCK_END);
const tokensOnly = css.slice(0, start) + css.slice(start, end).split("\n").filter((l) => !l.startsWith(DARK_OVERRIDE_PREFIX) && !Object.keys(LEGACY_TOKENS).some((t) => l.startsWith(`  --${t}:`))).join("\n") + css.slice(end);
const bare = pagePairs(tokensOnly, DARK_SELECTOR, files);
is("with the stage 1 tokens alone, the same pages fail (white boxes, black text, dark indigo links)", bare.pairs.filter((p) => p.ratio < p.min).length > 50, true);
for (const o of DARK_OVERRIDES.filter((x) => [".text-black", ".card-flat", ".btn-primary"].includes(x.selector))) {
  const without = css.split("\n").filter((l) => l !== `${DARK_OVERRIDE_PREFIX}${o.selector} { ${Object.entries(o.set).map(([k, v]) => `${k}: ${v};`).join(" ")} }`).join("\n");
  is(`taking out ${o.selector} alone makes it fail`, pagePairs(without, DARK_SELECTOR, files).pairs.some((p) => p.ratio < p.min), true);
}

part("Dark colors reach only the pages the proof read");
is("the gate is the class only the policy pages' frame draws", [DARK_READY, DARK_SELECTOR], [".legal-body", ':root[data-color-scheme="dark"]:has(.legal-body)']);
const carriers: string[] = [];
const scan = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name).replace(/\\/g, "/");
    if (statSync(p).isDirectory()) scan(p);
    else if (/\.tsx$/.test(name) && /["'`\s]legal-body["'`\s]/.test(read(p))) carriers.push(p);
  }
};
["app", "components"].forEach(scan);
is("only components/legal-page.tsx draws it, and every page drawn with it is in the proof", [carriers, pages.every((p) => files.includes(p))], [["components/legal-page.tsx"], true]);
is("a field's edge is drawn with the off-control token, proved at 3:1 on the page (1.4.11)", DARK_OVERRIDES.find((o) => o.selector === ".field")?.set["border-color"], "var(--line-off)");

done();
