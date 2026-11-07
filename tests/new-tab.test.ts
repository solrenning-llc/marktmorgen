/**
 * A link that opens a new tab says so, in the store's language (WCAG G201).
 *
 * The words are written twice: in lib/new-tab-words.ts, for a link drawn with
 * its store's language in hand, and in app/globals.css, as generated content
 * for a link drawn without it. These hold the two copies to each other, and
 * hold every link in the code that opens a new tab to carrying the note.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { newTabWords } from "@/lib/new-tab-words";
import { LANGUAGE_CODES } from "@/lib/store-language";

const root = process.cwd();
const css = readFileSync(join(root, "app/globals.css"), "utf8");

test("the stylesheet says the same words as lib/new-tab-words.ts, in every language", () => {
  for (const code of LANGUAGE_CODES) {
    const rule = code === "en" ? ".new-tab-note:empty::after" : `:lang(${code}) .new-tab-note:empty::after`;
    const found = css.match(new RegExp(`${rule.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&")} \\{ content: " ([^"]+)"; \\}`));
    assert.ok(found, `${code}: no rule`);
    assert.equal(found[1], newTabWords(code), code);
  }
});

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (path.endsWith(".tsx")) yield path;
  }
}

test("every link that opens a new tab carries the note", () => {
  const missing: string[] = [];
  for (const dir of ["app", "components"]) {
    for (const path of files(join(root, dir))) {
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(/<(a|Link)\b[^>]*?target="_blank"/g)) {
        const close = text.indexOf(`</${m[1]}>`, m.index);
        const body = text.slice(m.index, close);
        if (!/<NewTab\b/.test(body) && !/newTab|new tab/i.test(body)) missing.push(`${path.slice(root.length + 1)}:${text.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

/*
 * The test above reads only target="_blank" written on the tag. A new tab
 * also comes from a spread ({...aside}, where aside holds target: "_blank",
 * or an inline {...(x ? {} : { target: "_blank" })}), from a form's target,
 * and from window.open in a button's click; and an aria-label on the link
 * replaces its contents, so a note inside it is never read. These hold all
 * of them to the same rule (WCAG 3.2.5, technique G201).
 */

/**
 * Left out, with its reason: the full-size picture of a sales page
 * (data-picture-group). With script it opens on the page itself
 * (components/picture-viewer.tsx), so its aria-label rightly says nothing
 * of a new tab.
 */
const ON_THE_PAGE = /data-picture-group=/;

type Source = { path: string; text: string; spreads: Set<string>; notes: Set<string> };

function sources(): Source[] {
  const out: Source[] = [];
  for (const dir of ["app", "components"]) {
    for (const path of files(join(root, dir))) {
      const text = readFileSync(path, "utf8");
      const name = path.slice(root.length + 1);
      // A name that holds a new tab (const aside = ... { target: "_blank" ... }) and a name that holds the note (const away = ... <NewTab ...).
      const spreads = new Set([...text.matchAll(/const (\w+) = [^\n]*target: "_blank"/g)].map((m) => m[1]));
      const notes = new Set([...text.matchAll(/const (\w+) = [^\n]*<NewTab\b/g)].map((m) => m[1]));
      out.push({ path: name, text, spreads, notes });
    }
  }
  return out;
}

const line = (text: string, index: number) => text.slice(0, index).split("\n").length;
const says = (body: string, notes: Set<string>) =>
  /<NewTab\b/.test(body) || /newTab|new tab/i.test(body) || [...notes].some((n) => body.includes(`{${n}}`));

test("a link whose new tab is spread in carries the note too", () => {
  const missing: string[] = [];
  for (const { path, text, spreads, notes } of sources()) {
    for (const m of text.matchAll(/<(a|Link)\b[^>]*>/g)) {
      const tag = m[0];
      const opens = /target: "_blank"/.test(tag) || [...spreads].some((s) => tag.includes(`{...${s}}`));
      if (!opens) continue;
      const close = text.indexOf(`</${m[1]}>`, m.index);
      if (!says(text.slice(m.index, close), notes)) missing.push(`${path}:${line(text, m.index)}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("a link that opens a new tab and is named by aria-label says so in that label", () => {
  const hidden: string[] = [];
  for (const { path, text, spreads } of sources()) {
    for (const m of text.matchAll(/<(a|Link)\b[^>]*>/g)) {
      const tag = m[0];
      const opens = /target="_blank"|target: "_blank"/.test(tag) || [...spreads].some((s) => tag.includes(`{...${s}}`));
      if (!opens || ON_THE_PAGE.test(tag)) continue;
      const label = tag.match(/aria-label=(\{[^\n]*\}|"[^"]*")/);
      if (label && !/newTab|new tab/i.test(label[1])) hidden.push(`${path}:${line(text, m.index)}`);
    }
  }
  assert.deepEqual(hidden, []);
});

test("a button that opens a new tab with window.open says so", () => {
  const missing: string[] = [];
  for (const { path, text } of sources()) {
    for (const m of text.matchAll(/window\.open\([^)]*"_blank"/g)) {
      const start = text.lastIndexOf("<button", m.index);
      const end = text.indexOf("</button>", m.index);
      if (start < 0 || end < 0 || !/<NewTab\b/.test(text.slice(start, end))) missing.push(`${path}:${line(text, m.index)}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("a form that opens a new tab says so in its button", () => {
  const missing: string[] = [];
  for (const { path, text, notes } of sources()) {
    for (const m of text.matchAll(/<form\b[^>]*target="_blank"[^>]*>/g)) {
      const close = text.indexOf("</form>", m.index);
      const body = text.slice(m.index, close);
      // The fields may be drawn by a name of the same file ({inside}): read where it is made, up to the form.
      const made = [...body.matchAll(/\{(\w+)\}/g)].map((n) => {
        const at = text.lastIndexOf(`const ${n[1]} =`, m.index);
        return at < 0 ? "" : text.slice(at, m.index);
      });
      if (!says(body, notes) && !made.some((def) => says(def, notes))) missing.push(`${path}:${line(text, m.index)}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the embed card says nothing of a new tab where it stays in the tab", () => {
  // As a page of its own (?mm=page) every way out stays in the tab (aside is
  // target: "_top"), so no note may be written there unconditionally.
  const card = readFileSync(join(root, "app/embed/[handle]/[product]/page.tsx"), "utf8");
  assert.equal((card.match(/<NewTab\b/g) ?? []).length, 1, "one note, made once for the frame");
  // The store may be missing on this line (the card of a product no longer on sale), hence store?.language.
  assert.match(card, /const away = open\?\.mode === "page" \? null : <NewTab language=\{store\?\.language\} \/>;/);
});
