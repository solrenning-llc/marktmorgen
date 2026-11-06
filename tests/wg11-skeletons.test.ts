/**
 * 651 [WG11], unit 1: the loading skeletons (components/page-skeletons.tsx,
 * components/loading-skeleton.tsx) and how a page shows one. What fails here:
 *   - a skeleton that is not busy exactly once, or that says anything to a
 *     screen reader other than one "Loading" in one status;
 *   - a pulse that also runs for somebody who asked for less motion;
 *   - anything a keyboard can reach, a picture, or a word of fake content;
 *   - a block a screen reader can see;
 *   - a skeleton laid out on another width than the page it stands in for,
 *     which is the jump the skeleton is there to prevent;
 *   - a skeleton that reads anything (a fallback must draw at once);
 *   - a loading.tsx anywhere under app/. Next prefetches every dynamic route
 *     under one from each link on screen ("a dynamic route is skipped unless
 *     it has a loading.js boundary", node_modules/next/dist/docs/01-app/
 *     02-guides/prefetching.md). On a store's pages that is a read of the
 *     store per product link per visit, and in the studio a request per
 *     link, none with a ceiling (AGENTS.md MR: no spending without one);
 *   - a page whose skeleton is not the fallback of a <Suspense> in the page
 *     itself, around the part that reads;
 *   - a redirect inside that <Suspense>. Once the page has started to
 *     stream, Next can only write <meta http-equiv="refresh"
 *     content="1;url=…"> with a 200 (node_modules/next/dist/server/app-render/
 *     make-get-server-inserted-html.js), a refresh on a timer (WCAG F41,
 *     2.2.1, 3.2.5). So the page reads who is signed in and redirects first.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InboxSkeleton, LibrarySkeleton, StudioTodaySkeleton } from "@/components/page-skeletons";
import { done, is, part } from "./check";

type Case = {
  name: string;
  draw: () => ReactElement;
  /** The skeleton's name in components/page-skeletons.tsx. */
  skeleton: string;
  page: string;
  /** The function the page's <Suspense> draws: everything that reads after the sign-in. */
  body: string;
  /** What the exported page may wait for before its <Suspense>: the request, and who is signed in. */
  before: RegExp[];
  /** The real page's container: these class names stand together on one element of each. */
  outline: string[];
};

const SIGNED_IN = [/^searchParams\b/, /^cookies\(\)/, /^studioView\(/];

const CASES: Case[] = [
  {
    name: "studio home",
    draw: StudioTodaySkeleton,
    skeleton: "StudioTodaySkeleton",
    page: "app/studio/page.tsx",
    body: "StudioToday",
    before: SIGNED_IN,
    outline: ["container-page", "pb-20", "pt-10", "sm:pt-14"],
  },
  {
    name: "studio inbox",
    draw: InboxSkeleton,
    skeleton: "InboxSkeleton",
    page: "app/studio/inbox/page.tsx",
    body: "StudioInbox",
    before: SIGNED_IN,
    outline: ["container-page", "pb-20", "pt-10", "sm:pt-14"],
  },
  {
    name: "library",
    draw: LibrarySkeleton,
    skeleton: "LibrarySkeleton",
    page: "app/library/page.tsx",
    body: "LibraryShelves",
    before: [/^searchParams\b/],
    outline: ["container-page", "py-14", "sm:py-20"],
  },
];

const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

/** Every opening tag, with its class names. */
function tags(html: string): { tag: string; attrs: string; classes: string[] }[] {
  return [...html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)].map((m) => ({
    tag: m[1],
    attrs: m[2],
    classes: (/\bclass="([^"]*)"/.exec(m[2])?.[1] ?? "").split(/\s+/).filter(Boolean),
  }));
}

/** A line of the source on which every one of the class names stands as a word. */
function lineWithAll(source: string, names: string[]): boolean {
  const word = (name: string) => new RegExp(`(?:^|[\\s"'\`])${name.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&")}(?=$|[\\s"'\`$])`);
  return source.split("\n").some((line) => names.every((name) => word(name).test(line)));
}

/** A top-level function of a file, from its first line to the closing brace at the start of a line; "" when there is none. */
function topLevel(source: string, start: RegExp): string {
  const at = source.search(start);
  if (at < 0) return "";
  const end = source.indexOf("\n}\n", at);
  return end < 0 ? "" : source.slice(at, end + 2);
}

/** Every file named loading.* under a folder. */
function loadingFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return loadingFiles(path);
    return /^loading\.(?:tsx|ts|jsx|js|mdx)$/.test(entry.name) ? [path] : [];
  });
}

function main(): void {
  part("no loading file anywhere under app/");
  is("app/ has no loading.tsx, loading.ts, loading.jsx or loading.js", loadingFiles("app"), []);
  is("in particular none under app/[handle]/, a store's own pages", loadingFiles("app/[handle]"), []);

  const skeletons = readFileSync("components/page-skeletons.tsx", "utf8");
  for (const c of CASES) {
    part(`${c.name} (${c.skeleton}, ${c.page})`);
    const html = renderToStaticMarkup(c.draw());
    const all = tags(html);

    is("exactly one element is busy", count(html, /aria-busy="true"/g), 1);
    // "Loading" is English on a store in any language: marked as a part in English (AX274, 3.1.2).
    is("the Loading status is marked lang=\"en\"", /<p role="status" lang="en"/.test(html), true);
    const statuses = [...html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\brole="status"[^>]*)>([\s\S]*?)<\/\1>/g)];
    is("exactly one status", count(html, /role="status"/g), 1);
    is("the status says Loading", statuses.map((m) => m[3]), ["Loading"]);
    is("the status is hidden from sight with the site's sr-only class, never from a screen reader", statuses.map((m) => [/\bclass="[^"]*\bsr-only\b/.test(m[2]), /aria-hidden/.test(m[2])]), [[true, false]]);
    is("the word Loading appears once in the whole markup", count(html, /Loading/g), 1);
    is("no text but Loading", html.split(/<[^>]*>/).join("").trim(), "Loading"); // text between tags, read only (not a sanitizer)

    const pulses = all.flatMap((t) => t.classes.filter((name) => name.includes("animate-")));
    is("it pulses (Tailwind's animate-pulse)", pulses.length > 0, true);
    is("every pulse is motion-safe only", pulses.filter((name) => name !== "motion-safe:animate-pulse"), []);
    is("every pulsing block is hidden from a screen reader", all.filter((t) => t.classes.some((name) => name.includes("animate-pulse")) && !/\baria-hidden="true"/.test(t.attrs)).length, 0);

    is("nothing a keyboard can reach", [/<a\b/, /<button\b/, /<input\b/, /<select\b/, /<textarea\b/, /<summary\b/, /tabindex/i, /contenteditable/i].filter((p) => p.test(html)).map(String), []);
    is("no picture", [/<img\b/, /<picture\b/, /<svg\b/, /<video\b/, /<iframe\b/].filter((p) => p.test(html)).map(String), []);

    const page = readFileSync(c.page, "utf8");
    is(`the real page lays out on ${c.outline.join(" ")}`, lineWithAll(page, c.outline), true);
    is(`the skeleton lays out on the same ${c.outline.join(" ")}`, all.some((t) => c.outline.every((name) => t.classes.includes(name))), true);

    // How the page shows it.
    const exported = topLevel(page, /^export default (?:async )?function /m);
    const body = topLevel(page, new RegExp(`^async function ${c.body}\\(`, "m"));
    is("the exported page is found", exported.length > 0, true);
    is(`the part that reads is its own function, ${c.body}`, body.length > 0, true);
    is(`the exported page draws ${c.body} inside <Suspense fallback={<${c.skeleton} />}>`, new RegExp(`<Suspense fallback=\\{<${c.skeleton} />\\}>\\s*<${c.body}\\b[^>]*/>\\s*</Suspense>`).test(exported), true);
    is(`${c.skeleton} comes from components/page-skeletons`, new RegExp(`import \\{[^}]*\\b${c.skeleton}\\b[^}]*\\} from "@/components/page-skeletons";`).test(page), true);
    is("Suspense comes from react", /import \{[^}]*\bSuspense\b[^}]*\} from "react";/.test(page), true);
    is(`no redirect inside ${c.body}`, [/\bredirect\(/, /\bpermanentRedirect\(/, /\bnotFound\(/].filter((p) => p.test(body)).map(String), []);
    const suspenseAt = exported.indexOf("<Suspense");
    is("every redirect of the page comes before its <Suspense>", [...exported.matchAll(/\bredirect\(/g)].filter((m) => (m.index ?? 0) > suspenseAt).length, 0);
    const waits = [...exported.matchAll(/\bawait\s+([^;]+)/g)].map((m) => m[1].trim());
    is("before its <Suspense> the page waits only for the request and who is signed in", waits.filter((w) => !c.before.some((p) => p.test(w))), []);
    is("the skeleton is exported by name", new RegExp(`^export function ${c.skeleton}\\(\\)`, "m").test(skeletons), true);
  }

  part("the skeletons and their pieces read nothing");
  // Only a constant of the code may come in (lib/opening.ts: whether the site's "still being built" line stands above the menu); nothing that reads.
  is("components/page-skeletons.tsx reads nothing", [/\basync\b/, /\bawait\b/, /@\/lib\/(?!opening")/, /next\/headers/, /\bfetch\(/].filter((p) => p.test(skeletons)).map(String), []);
  const shared = readFileSync("components/loading-skeleton.tsx", "utf8");
  is("no bare animate-pulse anywhere in the pieces", shared.replace(/motion-safe:animate-pulse/g, "").includes("animate-pulse"), false);
  is("no client code: they draw on the server at once", [shared, skeletons].filter((s) => /^["']use client["']/m.test(s)).length, 0);
  done();
}

main();
