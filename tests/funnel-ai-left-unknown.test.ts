/**
 * Rule 24 on the funnels page (VR item 2): the guided setup's AI draft panel, when the month's AI allowance could not
 * be read. The page hands it aiOnValue(true, null) = { known: false } (lib/ai-on-value.ts); the panel says so in
 * words, never "0 left this month", and both AI buttons stay off until the page is reloaded. A known count and a
 * spent allowance are unchanged (controls). Real component, rendered to HTML.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FunnelAiDraftPanel } from "@/components/funnel-ai-draft";
import { FUNNEL_TYPES } from "@/lib/funnel-types";
import { done, is } from "./check";

const UNKNOWN = /We could not check your AI allowance just now\. Reload the page in a minute to try again\./;
const type = FUNNEL_TYPES[0];
const panel = (ai: { on: boolean; left: number; known?: false }) =>
  renderToStaticMarkup(createElement(FunnelAiDraftPanel, { type, picked: {}, sid: "s1", ai: ai as never, emailsPossible: false, onDraft: () => {} }));
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>/g)].map((m) => m[1]).filter((tag) => /btn-(primary|secondary) btn-sm/.test(tag) && !/Use as/.test(tag));

const unread = panel({ on: true, left: 0, known: false });
is("an unread allowance is said in words", UNKNOWN.test(unread), true);
is("never as a count", /\b0 left this month/.test(unread), false);
is("both AI buttons are off", buttons(unread).map((tag) => /disabled=""/.test(tag)), [true, true]);

const known = panel({ on: true, left: 9 });
is("control: a known count is shown", /9 left this month/.test(known), true);
is("control: and does not say it could not be checked", UNKNOWN.test(known), false);
is("control: both AI buttons are on", buttons(known).map((tag) => /disabled=""/.test(tag)), [false, false]);
is("control: a spent allowance is still 0 left", /\b0 left this month/.test(panel({ on: true, left: 0 })), true);

const page = readFileSync("app/studio/funnels/page.tsx", "utf8");
is("the funnels page catches an unread allowance as null, never 0", /aiLeft\(store\)\.catch\(\(\) => null\)/.test(page) && !/aiLeft\(store\)\.catch\(\(\) => 0\)/.test(page), true);

done();
