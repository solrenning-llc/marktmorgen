/**
 * AX274 (WCAG 2.2 4.1.2 Name, Role, Value and 2.1.1): each proposal on the studio's AI agent screen shows what is
 * there now and what it would become in boxes that scroll on their own and take keyboard focus. They were named
 * with aria-label on a plain div, a name ARIA does not allow on an element with no role (axe: aria-prohibited-attr),
 * so a screen reader reaching one by keyboard said nothing of what it was. Each box is now a named group, as the
 * lesson's code blocks are (components/lesson-text.tsx), and says which proposal it belongs to.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentProposals } from "@/components/agent-proposals";
import { done, is, part } from "./check";

const html = renderToStaticMarkup(
  createElement(AgentProposals, {
    waiting: [{ id: "p1", label: "New description for Guide", asked: "an AI key", at: "today", before: "Old", after: "New." }],
    history: [],
  }),
);
const boxes = [...html.matchAll(/<div\b([^>]*tabindex="0"[^>]*)>/g)].map((m) => m[1]);

part("The before and after boxes are named groups");
is("two scrolling boxes", boxes.length, 2);
is("each is a group", boxes.every((attrs) => /role="group"/.test(attrs)), true);
is("named for what it holds, the visible words inside the name", boxes.map((attrs) => /aria-label="([^"]+)"/.exec(attrs)?.[1]), ["What is there now", "What it would become"]);
is("each says which proposal it belongs to", boxes.every((attrs) => /aria-describedby="proposal-p1"/.test(attrs)), true);
is("no named div without a role is left", /<div(?![^>]*role=)[^>]*aria-label=/.test(html), false);

done();
