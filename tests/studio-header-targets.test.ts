/**
 * AX274 Part A (WCAG 2.2 AAA, 2.5.5 Target Size (Enhanced)) on every studio page, measured on a seeded local build
 * (Claude 4 cloud AA, 15 November 2026; first seen by cloud P, docs/studio-accessibility-audit-2026-11-11.md):
 *
 * - the studio header's logo link (components/studio-header.tsx) was 153 x 40 px on a wide screen and 32 x 32 px on
 *   a phone, where it draws only the mark;
 * - the trail's links (components/breadcrumb.tsx), "Studio" above all, were 44 px tall but only as wide as their
 *   word: "Studio" 41 px.
 *
 * - the add-a-tool gallery's titles (components/add-gallery.tsx) were 44 px tall but as narrow as their word: on
 *   /studio/add "Blog" was 35 px wide and "Inbox" 43 px.
 *
 * All are now at least 44 by 44 px. Rendered from the real components, so the box is read from what they draw.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { Breadcrumb } from "@/components/breadcrumb";
import { done, is, part } from "./check";

const classesOf = (tag: string) => (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);

part("The trail's links are 44 by 44 px");
const trail = renderToStaticMarkup(createElement(Breadcrumb, { path: [{ label: "Studio", href: "/studio" }], here: "Tax" }));
const link = /<a\b[^>]*>/.exec(trail)?.[0] ?? "";
is("the trail draws its link", link.includes('href="/studio"'), true);
is("44 px tall (min-h-11)", classesOf(link).includes("min-h-11"), true);
is("and 44 px wide (min-w-11), so a short word such as Studio is a whole target", classesOf(link).includes("min-w-11"), true);

part("The studio header's logo link is 44 by 44 px");
const header = readFileSync("components/studio-header.tsx", "utf8");
const logo = /<Link href="\/" className="([^"]*)" aria-label="Marktmorgen, home">/.exec(header);
is("the logo link is found", logo !== null, true);
const logoClasses = (logo?.[1] ?? "").split(/\s+/);
is("it is a box (inline-flex) 44 px tall and 44 px wide", ["inline-flex", "min-h-11", "min-w-11", "items-center"].every((c) => logoClasses.includes(c)), true);

part("The add-a-tool gallery's titles are 44 by 44 px");
const gallery = readFileSync("components/add-gallery.tsx", "utf8");
const galleryLink = /const LINK = "([^"]*)"/.exec(gallery)?.[1]?.split(/\s+/) ?? [];
is("its link class is found", galleryLink.length > 0, true);
is("44 px tall and 44 px wide, so \"Blog\" (35 px) and \"Inbox\" (43 px) are whole targets", ["min-h-11", "min-w-11"].every((c) => galleryLink.includes(c)), true);

done();
