/**
 * "The order of your page" on the studio's start page
 * (components/page-order-editor.tsx; AX274 Part A; WCAG 2.2 2.4.3 Focus
 * Order, 4.1.3 Status Messages, 1.3.1). Seen in Chromium on 11 November 2026,
 * keyboard only: "Move <part> up" turned itself off once the part reached the
 * top (and "down" at the bottom), dropping the focus to the page's body; and
 * no move was said at all, since the place number beside each part is hidden
 * from screen readers, so a person could not tell where the part went.
 *
 * Now a button at the end of the list stays focusable (aria-disabled) and,
 * pressed, says the part is already first or last; and every move is said in
 * a polite status line: "Moved <part> to place N of M."
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PageOrderEditor } from "@/components/page-order-editor";
import { USUAL_ORDER, type PagePart } from "@/lib/store-order";
import { done, is, part } from "./check";

const src = readFileSync("components/page-order-editor.tsx", "utf8");
const up = src.slice(src.lastIndexOf("<button", src.indexOf("aria-label={`Move ${about?.label} up`}")), src.indexOf("</button>", src.indexOf("aria-label={`Move ${about?.label} up`}")));
const down = src.slice(src.lastIndexOf("<button", src.indexOf("aria-label={`Move ${about?.label} down`}")), src.indexOf("</button>", src.indexOf("aria-label={`Move ${about?.label} down`}")));

is("Move up is never turned off for being first: it says so instead", /(?<![-\w])disabled=\{[^}]*i === 0/.test(up), false);
is("it is marked as unavailable there, and still takes the focus", /aria-disabled=\{i === 0 \|\| undefined\}/.test(up), true);
is("Move down likewise at the end", !/(?<![-\w])disabled=\{[^}]*i === list\.length - 1/.test(down) && /aria-disabled=\{i === list\.length - 1 \|\| undefined\}/.test(down), true);
is("both still look unavailable there", [up, down].every((b) => /aria-disabled:opacity-40/.test(b)), true);
is("a polite status line says what happened", /<p role="status" className="sr-only">\{said\}<\/p>/.test(src), true);
is("a move says where the part went", src.includes("`Moved ${name} to place ${to + 1} of ${list.length}.`"), true);
is("a press at the end says it is already there", src.includes("`${name} is already ${by < 0 ? \"first\" : \"last\"}.`"), true);
is("the same words said twice are said again", /setSaid\(""\);\s*requestAnimationFrame\(\(\) => setSaid\(words\)\);/.test(src), true);

part("The component as drawn (Claude 3 cloud M's LOW: not only the source)");
const order = [...USUAL_ORDER] as PagePart[];
const on = Object.fromEntries(order.map((p) => [p, true])) as Record<PagePart, boolean>;
const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {} } as never }, createElement(PageOrderEditor, { order, on })));
const moves = [...html.matchAll(/<button\b([^>]*aria-label="Move [^"]*"[^>]*)>/g)].map((m) => m[1]);
is("an up and a down for each part", moves.length, order.length * 2);
is("only the first up and the last down are marked unavailable", moves.map((a) => /aria-disabled="true"/.test(a)), moves.map((_, i) => i === 0 || i === moves.length - 1));
is("the status line is drawn, empty until a move", /<p role="status" class="sr-only"><\/p>/.test(html), true);

done();
