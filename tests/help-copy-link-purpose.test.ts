/**
 * AX274 (WCAG 2.2 2.4.9 Link Purpose (Link Only), AAA): every answer in the help center ends with the same link,
 * "Copy a link to this answer", so a list of the page's links read dozens of identical names with no way to tell
 * which answer each one leads to. The link now also carries its question, hidden on screen, after the visible
 * words, so the visible label still starts the name (2.5.3).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyLink } from "@/components/copy-link";
import { done, is, part } from "./check";

part("Each answer's link names its question");
const html = renderToStaticMarkup(createElement(CopyLink, { id: "refunds", about: "How do refunds work?" }));
is("the visible words stay first", /Copy a link to this answer<\/span><span class="sr-only">: How do refunds work\?<\/span>/.test(html), true);
is("without a question it is unchanged", renderToStaticMarkup(createElement(CopyLink, { id: "x" })).includes("sr-only"), false);
const help = readFileSync("app/help/page.tsx", "utf8");
is("the help center passes each answer's question", help.includes("<CopyLink id={answerId(item.q)} about={item.q} />"), true);

done();
