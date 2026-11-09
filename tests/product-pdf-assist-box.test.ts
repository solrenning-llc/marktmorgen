/**
 * "Suggest a title and benefits from your PDF" in the product form, run as
 * the creator uses it (758 [STN5] unit 4; components/product-pdf-assist.tsx).
 * The box's real code runs under tests/client-hooks.ts; the step-by-step box
 * inside it is not drawn by that runner, so its result is handed to the box
 * as the step-by-step box would hand it. Nothing real is sent. What is
 * checked:
 *   - while the full description is still being read, or could not be read,
 *     the box is not offered: what it would put in front of the description
 *     could replace a description the form never had;
 *   - a second suggestion replaces the benefits the box put in, never adds a
 *     second "What you get:" list;
 *   - "Put back what was there" restores the three boxes, and the focus goes
 *     to what was said, never to the top of the page.
 */
import { ProductPdfAssist } from "@/components/product-pdf-assist";
import { AiStepsAssist } from "@/components/ai-steps-assist";
import { BENEFITS_HEADING, PDF_ASSIST_COPY, type PdfProposal } from "@/lib/product-pdf-assist-rules";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
type Fields = { title: string; summary: string; about: string };

const label = (n: Node) => texts(n.props?.children).join("");
const button = (tree: unknown, text: string) => find(tree, (n) => n.type === "button" && label(n) === text)[0] as Node | undefined;
const click = (node: Node | undefined) => (node?.props?.onClick as (() => unknown) | undefined)?.();
const stepsBox = (tree: unknown) => find(tree, (n) => n.type === AiStepsAssist)[0]?.props as { onResult?: (value: PdfProposal) => void } | undefined;
const status = (tree: unknown) => find(tree, (n) => n.type === "p" && n.props?.role === "status")[0] as Node | undefined;

const ORIGINAL: Fields = { title: "Recipe Pack", summary: "Forty dinners.", about: "My own long description." };
const FIRST: PdfProposal = { title: "Weeknight Recipe Pack", summary: "Forty dinners on one page each.", benefits: ["One recipe per page", "A shopping list each week", "Dinners in thirty minutes"] };
const SECOND: PdfProposal = { title: "Weeknight Dinners", summary: "Forty dinners for busy parents.", benefits: ["Pantry basics first", "One-pan dinners", "Kid-tested recipes"] };

/** The box with the form's three boxes as a real form keeps them: what it sets is what it reads next. */
async function box(about: "ready" | "loading" | "unread") {
  const fields: Fields = { ...ORIGINAL };
  const changes: Fields[] = [];
  const mounted = await mount(ProductPdfAssist, {
    productId: "p1",
    fields,
    aboutState: about,
    onChange: (next: Fields) => {
      changes.push({ ...next });
      Object.assign(fields, next);
    },
  } as Parameters<typeof ProductPdfAssist>[0]);
  return { mounted, fields, changes };
}

async function main(): Promise<void> {
  part("While the full description is not in the form, the box is not offered");
  for (const state of ["loading", "unread"] as const) {
    const b = await box(state);
    is(`${state}: no suggestion box`, stepsBox(b.mounted.tree()), undefined);
    is(`${state}: it says why`, texts(b.mounted.tree()).join(" ").length > 0 && !texts(b.mounted.tree()).join(" ").includes(PDF_ASSIST_COPY.title), true);
    is(`${state}: nothing in the form changed`, b.changes, []);
    b.mounted.unmount();
  }

  part("Two suggestions in a row: one list of benefits, the creator's description whole");
  {
    const b = await box("ready");
    const fill = stepsBox(b.mounted.tree())?.onResult;
    is("the box is offered once the description is in the form", typeof fill, "function");
    fill?.(FIRST);
    await b.mounted.settle();
    stepsBox(b.mounted.tree())?.onResult?.(SECOND);
    await b.mounted.settle();
    const about = b.fields.about;
    is("one heading only", about.split(BENEFITS_HEADING).length - 1, 1);
    is("the second list replaces the first", [about.includes("Pantry basics first"), about.includes("One recipe per page")], [true, false]);
    is("the creator's own description stays whole, after it", about.endsWith(`\n\n${ORIGINAL.about}`), true);

    part("Put back what was there");
    const said = status(b.mounted.tree());
    let focused = 0;
    (said?.props as { ref?: { current: unknown } } | undefined)?.ref && ((said!.props as { ref: { current: unknown } }).ref.current = { focus: () => (focused += 1) });
    click(button(b.mounted.tree(), PDF_ASSIST_COPY.undo));
    await b.mounted.settle();
    is("the three boxes are as they were before the first suggestion", b.fields, ORIGINAL);
    is("the focus goes to what was said, not to the top of the page", [focused, (status(b.mounted.tree())?.props as { tabIndex?: number } | undefined)?.tabIndex], [1, -1]);
    b.mounted.unmount();
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
