/** Independent SSR probes for the three changed controls absent from the author's render test. */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiOn } from "@/components/ai-assist";
import { BlockRewrite } from "@/components/block-rewrite";
import { PageCoach } from "@/components/page-coach";
import { TranslatePage } from "@/components/translate-page";
import type { SalesPage } from "@/lib/sales-page";
import { done, is, part } from "./check";

const unknown = "We could not check your AI allowance just now. Reload the page in a minute to try again.";
const page = { blocks: [{ id: "text0001", kind: "text", body: "A simple practice lesson." }], seoDescription: "", test: null } as SalesPage;
const noop = () => {};
const view = (child: ReactNode, left: number | null, on = true) => renderToStaticMarkup(createElement(AiOn.Provider, { value: left === null ? { on, left: 0, known: false } as never : { on, left } }, child));
const renderers = {
  rewrite: (left: number | null, on = true) => view(createElement(BlockRewrite, { productId: "sample", block: page.blocks[0], page: () => page, onChange: noop }), left, on),
  coach: (left: number | null, on = true) => view(createElement(PageCoach, { productId: "sample", page, productTitle: "Practice", free: true, picture: false, pictureAlt: "", facts: {}, reach: null, onAdd: noop, onHeadline: noop, onTest: noop, onFit: noop, onQuestions: noop }), left, on),
  translate: (left: number | null, on = true) => view(createElement(TranslatePage, { productId: "sample", storeLanguage: "pt", page: () => page, onResult: () => true }), left, on),
};
function buttons(html: string) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter((m) => /Shorter|Warmer|Clearer|Review my page|Translate|More|Formal|Rewrite|Write it/.test(m[2].replace(/<[^>]*>/g, "")));
}
for (const [name, render] of Object.entries(renderers)) {
  part(name);
  const unread = render(null);
  const gated = buttons(unread);
  is(`${name}: unknown sentence and no zero/null balance`, [unread.includes(unknown), /(?:0|null|NaN|undefined) left this month/.test(unread)], [true, false]);
  is(`${name}: real job buttons are present and disabled`, [gated.length > 0, gated.every((m) => m[1].includes('disabled=""'))], [true, true]);
  is(`${name}: every job button describes the actual unknown sentence`, gated.length > 0 && gated.every((m) => {
    const id = m[1].match(/aria-describedby="([^"]+)"/)?.[1];
    return !!id && unread.includes(`id="${id}"`) && unread.slice(unread.indexOf(`id="${id}"`)).split(/<\/(?:p|span)>/)[0].includes(unknown);
  }), true);
  const known = render(99);
  is(`${name}: known balance and enabled controls`, [known.includes("99 left this month"), known.includes(unknown), buttons(known).some((m) => !m[1].includes('disabled=""'))], [true, false, true]);
  const spent = render(0);
  is(`${name}: spent is still zero with disabled controls`, [spent.includes("0 left this month"), spent.includes(unknown), buttons(spent).every((m) => m[1].includes('disabled=""'))], [true, false, true]);
  is(`${name}: unavailable feature hides the job controls`, buttons(render(null, false)).length, 0);
}
done();
