/**
 * 651 [WG11], unit 1: the loading skeletons (app/**\/loading.tsx,
 * components/loading-skeleton.tsx). What fails here:
 *   - a skeleton that is not busy exactly once, or that says anything to a
 *     screen reader other than one "Loading" in one status;
 *   - a pulse that also runs for somebody who asked for less motion;
 *   - anything a keyboard can reach, a picture, or a word of fake content;
 *   - a block a screen reader can see;
 *   - a skeleton laid out on another width than the page it stands in for,
 *     which is the jump the skeleton is there to prevent;
 *   - a loading file that reads anything (a fallback must draw at once).
 */
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StudioLoading from "@/app/studio/loading";
import InboxLoading from "@/app/studio/inbox/loading";
import LibraryLoading from "@/app/library/loading";
import CourseLoading from "@/app/[handle]/course/[product]/loading";
import ProductLoading from "@/app/[handle]/p/[product]/loading";
import { done, is, part } from "./check";

type Case = {
  name: string;
  draw: () => ReactElement;
  source: string;
  page: string;
  /** The real page's container: these class names stand together on one element of each. */
  outline: string[];
};

const CASES: Case[] = [
  { name: "studio home", draw: StudioLoading, source: "app/studio/loading.tsx", page: "app/studio/page.tsx", outline: ["container-page", "pb-20", "pt-10", "sm:pt-14"] },
  { name: "studio inbox", draw: InboxLoading, source: "app/studio/inbox/loading.tsx", page: "app/studio/inbox/page.tsx", outline: ["container-page", "pb-20", "pt-10", "sm:pt-14"] },
  { name: "library", draw: LibraryLoading, source: "app/library/loading.tsx", page: "app/library/page.tsx", outline: ["container-page", "py-14", "sm:py-20"] },
  {
    name: "course page",
    draw: CourseLoading,
    source: "app/[handle]/course/[product]/loading.tsx",
    page: "app/[handle]/course/[product]/page.tsx",
    outline: ["relative", "mx-auto", "max-w-2xl", "px-4", "py-12", "sm:py-16"],
  },
  {
    name: "product page",
    draw: ProductLoading,
    source: "app/[handle]/p/[product]/loading.tsx",
    page: "app/[handle]/p/[product]/page.tsx",
    outline: ["relative", "mx-auto", "max-w-2xl", "px-4", "pb-16", "pt-10", "sm:pt-14"],
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

function main(): void {
  for (const c of CASES) {
    part(`${c.name} (${c.source})`);
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
    const source = readFileSync(c.source, "utf8");
    is(`the real page lays out on ${c.outline.join(" ")}`, lineWithAll(page, c.outline), true);
    is(`the skeleton lays out on the same ${c.outline.join(" ")}`, all.some((t) => c.outline.every((name) => t.classes.includes(name))), true);
    // Only a constant of the code may come in (lib/opening.ts: whether the site's "still being built" line stands above the menu); nothing that reads.
    is("the loading file reads nothing", [/\basync\b/, /\bawait\b/, /@\/lib\/(?!opening")/, /next\/headers/, /\bfetch\(/].filter((p) => p.test(source)).map(String), []);
  }

  part("the shared pieces (components/loading-skeleton.tsx)");
  const shared = readFileSync("components/loading-skeleton.tsx", "utf8");
  is("no bare animate-pulse anywhere in it", shared.replace(/motion-safe:animate-pulse/g, "").includes("animate-pulse"), false);
  is("no client code: it draws on the server at once", /^["']use client["']/m.test(shared), false);

  part("a loading file wraps the nested routes too, and the studio's says so");
  is("app/studio/loading.tsx explains that it stands in for every studio screen below it", /nested|below it|every studio/i.test(readFileSync("app/studio/loading.tsx", "utf8")), true);
  done();
}

main();
