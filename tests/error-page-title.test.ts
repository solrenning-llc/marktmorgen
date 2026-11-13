/**
 * AX274 (WCAG 2.2 2.4.2 Page Titled): when a page fails to draw, app/error.tsx takes its place, but the browser tab
 * and a screen reader's page title still named the page that failed, as if it had loaded. An error boundary cannot
 * export metadata (it is a client component), so it now draws React's <title>, as the Next.js documentation of
 * this version advises (node_modules/next/dist/docs, error.md), with the same words as its heading.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PageError from "@/app/error";
import { done, is, part } from "./check";

part("A failed page says so in its title");
const html = renderToStaticMarkup(createElement(PageError, { error: Object.assign(new Error("x"), { digest: "d1" }), reset: () => {} }));
is("the title says the page did not load", html.includes("<title>This page did not load — Marktmorgen</title>"), true);
is("the heading is unchanged", html.includes(">This page did not load</h1>"), true);

done();
