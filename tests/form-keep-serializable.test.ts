/**
 * VR (owner, 25/10/2026, Part A item 2), found by Claude 4 on 11/11/2026 and
 * reproduced on a synthetic store: a store page with a form of four questions
 * or more (or one long answer) answered 500 to every visitor. The form block
 * (components/sales-blocks.tsx) handed the client component FormKeep the
 * whole form words, functions included (notYet, hearFrom, doneBody), and a
 * server page cannot pass a function to a client component. The e2e form had
 * three questions, under the line where FormKeep is offered (offersKeep), and
 * renderToStaticMarkup never crosses that boundary. This walks the block the
 * way the server does and fails on anything React could not send.
 */
import { isValidElement, type ReactNode } from "react";
import { FormKeep } from "@/components/form-keep";
import { FormBranching } from "@/components/form-branching";
import { BlockView, type BlockContext } from "@/components/sales-blocks";
import { parseForm, offersKeep, type FormDef } from "@/lib/forms";
import { FORM_WORDS } from "@/lib/buyer-words/form";
import { done, is, part } from "./check";

const CLIENT = new Set<unknown>([FormKeep, FormBranching]);

/** The props each client component gets, found by drawing the server components around it as the server does. */
function clientProps(node: ReactNode, found: { type: unknown; props: Record<string, unknown> }[] = []): typeof found {
  if (Array.isArray(node)) {
    for (const child of node) clientProps(child, found);
    return found;
  }
  if (!isValidElement(node)) return found;
  const { type, props } = node as { type: unknown; props: Record<string, unknown> };
  if (CLIENT.has(type)) {
    found.push({ type, props });
    return found;
  }
  if (typeof type === "function") {
    let drawn: ReactNode;
    try {
      drawn = (type as (p: unknown) => ReactNode)(props);
    } catch {
      // A component with hooks is a client one this test does not look into.
      return found;
    }
    return clientProps(drawn, found);
  }
  return clientProps(props.children as ReactNode, found);
}

/** Every path in a value that React could not send from the server to a client component. */
function notSendable(value: unknown, path = "props"): string[] {
  if (typeof value === "function" || typeof value === "symbol") return [path];
  if (Array.isArray(value)) return value.flatMap((item, i) => notSendable(item, `${path}[${i}]`));
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return [`${path} (${proto?.constructor?.name ?? "class"})`];
    return Object.entries(value).flatMap(([key, item]) => notSendable(item, `${path}.${key}`));
  }
  return [];
}

const field = (id: string, type = "short") => ({ id, type, label: `Question ${id}`, required: false, options: [] });
const base = { id: "frm0000001", name: "Synthetic application", button: "", doneHeading: "", doneBody: "", outcomes: [], offerList: true, updatedAt: 1 };
const draw = (form: FormDef, lang: string) => {
  const ctx: BlockContext = { storeName: "Synthetic Shop", productTitle: "", picture: null, photo: null, action: { kind: "none" } as never, defaultLabel: "", now: 1_790_000_000, lang, forms: { [form.id]: form }, formTarget: { handle: "syntheticshop", page: "p1", funnel: "", listOpen: true } };
  return clientProps(BlockView({ block: { id: "blk001", kind: "form", heading: "Apply", form: form.id } as never, ctx, reviews: null }));
};

for (const [label, form] of [
  ["four questions", parseForm({ ...base, fields: [field("aaaaaa"), field("bbbbbb"), field("cccccc"), field("dddddd")] }) as FormDef],
  ["one long answer", parseForm({ ...base, fields: [field("aaaaaa", "long")] }) as FormDef],
] as const) {
  part(`A form with ${label}, as a visitor opens it`);
  is("it offers to keep the answers", offersKeep(form), true);
  for (const lang of Object.keys(FORM_WORDS)) {
    const found = draw(form, lang);
    const keep = found.find((c) => c.type === FormKeep);
    is(`${lang}: the box to keep the answers is handed to the browser`, Boolean(keep), true);
    is(`${lang}: nothing it gets is a function (the page answered 500)`, found.flatMap((c) => notSendable(c.props)), []);
    const words = keep?.props.words as Record<string, unknown> | undefined;
    is(`${lang}: its three sentences, in the store's language`, [words?.keepLabel, words?.keepHelp, words?.keepBack], [FORM_WORDS[lang as keyof typeof FORM_WORDS].keepLabel, FORM_WORDS[lang as keyof typeof FORM_WORDS].keepHelp, FORM_WORDS[lang as keyof typeof FORM_WORDS].keepBack]);
  }
}

done();
