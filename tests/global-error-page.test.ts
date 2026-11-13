/**
 * AX274: when the root layout itself fails, Next.js drew its own default page, which this site did not control:
 * no language, no title of ours, no heading, no way back (WCAG 3.1.1, 2.4.2, 1.3.1, 2.4.10, 3.2.6 help). The
 * site now has app/global-error.tsx, a whole document of its own that leans on nothing from the layout that
 * failed: lang, a title, one h1, plain words, a "Try again" button (this Next.js version's retry()) and a plain
 * link home; its own CSS with 7:1 text in light and dark, a visible focus outline, 44px targets, and no motion.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GlobalError from "@/app/global-error";
import { done, is, part } from "./check";

const source = readFileSync("app/global-error.tsx", "utf8");
const html = renderToStaticMarkup(createElement(GlobalError, { error: new Error("x"), retry: () => {} }));

part("A whole document of its own");
is("a client error boundary", /^(\/\*[^]*?\*\/\s*)?"use client";/.test(source), true);
is("its own html with a language", html.startsWith('<html lang="en-US">'), true);
is("a title", html.includes("<title>This page did not load — Marktmorgen</title>"), true);
is("one main region", (html.match(/<main\b/g) ?? []).length, 1);
is("one h1", (html.match(/<h1\b/g) ?? []).length, 1);
is("a button to try again", /<button type="button"[^>]*>Try again<\/button>/.test(html), true);
is("a plain link home, not the app's router", /<a href="\/"[^>]*>Go to the home page<\/a>/.test(html) && !source.includes("next/link"), true);
is("nothing from the failed layout or the site's components", !/from "@\/(components|app)\//.test(source) && !source.includes("globals.css"), true);

part("Its own CSS keeps the site's floor");
is("dark text on white: #1c1917", source.includes("#1c1917") && source.includes("#ffffff"), true);
is("a dark scheme of its own", source.includes("prefers-color-scheme: dark"), true);
is("a visible focus outline", /:focus-visible\s*\{[^}]*outline:\s*3px solid/.test(source), true);
is("44px targets", (source.match(/min-height:\s*44px/g) ?? []).length >= 2, true);
is("no animation or transition", /animation|transition/.test(source), false);

done();
