/**
 * The AI proposals' buttons say which proposal they act on (Claude 5's cross
 * review of #1856, CX72, AX274 2.4.6): each Confirm, Decline and Undo is
 * described by its own item's title, and Decline says when it is busy, as its
 * siblings do. A failure is announced as an alert, a partial answer as a
 * status, and focus goes to what answered instead of falling to the page.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentProposals } from "@/components/agent-proposals";
import { done, is } from "./check";

const html = renderToStaticMarkup(
  createElement(AgentProposals, {
    waiting: [
      { id: "p1", label: "New description for Guide", asked: "an AI key", at: "today", before: "", after: "New words." },
      { id: "p2", label: "New description for Course", asked: "an AI key", at: "today", before: "Old", after: "New." },
    ],
    history: [{ id: "d1", label: "Description of Guide changed", confirmed: "today", undo: true, undone: null }],
  }),
);
const buttons = [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map((m) => ({ attrs: m[1], name: m[2].trim() }));
const describedBy = (name: string) => buttons.filter((b) => b.name === name).map((b) => /aria-describedby="([^"]+)"/.exec(b.attrs)?.[1] ?? null);

is("each Confirm is described by its own proposal's title", describedBy("Confirm"), ["proposal-p1", "proposal-p2"]);
is("each Decline too", describedBy("Decline"), ["proposal-p1", "proposal-p2"]);
is("Undo by its history row", describedBy("Undo"), ["done-d1"]);
is("the titles carry those ids", ["proposal-p1", "proposal-p2", "done-d1"].every((id) => html.includes(`id="${id}"`)), true);
is("Decline says when it is busy, as its siblings do", buttons.filter((b) => b.name === "Decline").every((b) => /aria-busy="false"/.test(b.attrs)), true);
is("the section's heading can take focus when a toast answers", /<h2 id="waiting-title" tabindex="-1"/.test(html), true);

const source = readFileSync("components/agent-proposals.tsx", "utf8");
is("a failure is an alert, a partial answer a status", source.includes('role={message.failed ? "alert" : "status"}'), true);
is("focus goes to what answered", source.includes("(said.current ?? heading.current)?.focus()"), true);
done();
