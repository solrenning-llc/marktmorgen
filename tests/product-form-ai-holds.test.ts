/**
 * Claude 1's MEDIUM on #3441 (cloud C3 focal at dd6012d148): the product form kept ONE set of AI-draft checks
 * (756 [STN3]) for two independent AI sources, the ideas box (name and short description) and "Write the
 * description with AI" (short and long description). Each overwrote the other's checks, and "Put back what you had"
 * restored a snapshot taken before a later description draft, so AI text could be saved with its own review never
 * checked:
 *   A. use an idea, draft the description, put the idea back: the save was not held, with the AI long
 *      description still unchecked;
 *   B. draft the description, use an idea, check only the idea's three boxes: the save was not held.
 * Each source now keeps its own checks, the save is held while any drawn review is incomplete, and putting an idea
 * back clears only the idea's own. The form's real code runs under tests/client-hooks.ts; child components are not
 * rendered, so their onReviewChange props are called as the boxes would. Synthetic only.
 */
import { AiAssist } from "@/components/ai-assist";
import { ProductIdeas } from "@/components/product-ideas";
import { ProductPdfAssist } from "@/components/product-pdf-assist";
import { EMPTY, ProductForm } from "@/components/product-editor";
import { find, mount } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> };
(globalThis as Record<string, unknown>).requestAnimationFrame = () => 0;
(globalThis as Record<string, unknown>).document ??= { getElementById: () => null };

const FRESH = [false, false, false];
const CHECKED = [true, true, true];

/** A product the creator is changing, with a PDF the form offers to read (758 [STN5], unit 4). */
const WITH_PDF = {
  id: "p1",
  title: "Recipe Pack",
  summary: "Forty dinners.",
  priceCents: 1900,
  file: { pathname: "private/p1/recipes.pdf", name: "recipes.pdf", bytes: 1_000, contentType: "application/pdf" },
  options: [],
  bumps: [],
};

async function form(product: unknown = null) {
  let saved = 0;
  const box = await mount(ProductForm as (props: Record<string, unknown>) => unknown, {
    ...(product ? { product } : {}),
    draft: EMPTY,
    setDraft: () => {},
    busy: false,
    error: null,
    submitLabel: "Add it",
    onSubmit: () => {
      saved += 1;
    },
    onCancel: () => {},
  });
  const prop = (type: unknown) => (find(box.tree(), (n: Node) => n.type === type)[0] as Node | undefined)?.props ?? {};
  const ideas = async (checks: boolean[] | null) => {
    (prop(ProductIdeas).onReviewChange as (c: boolean[] | null) => void)(checks);
    await box.settle();
  };
  const assist = async (checked: boolean) => {
    (prop(AiAssist).onReviewChange as (c: boolean) => void)(checked);
    await box.settle();
  };
  const pdf = async (checks: boolean[] | null) => {
    const tell = prop(ProductPdfAssist).onReviewChange as ((c: boolean[] | null) => void) | undefined;
    if (typeof tell !== "function") throw new Error("the PDF box tells the form nothing about its AI draft's checks");
    tell(checks);
    await box.settle();
  };
  const save = async () => {
    const before = saved;
    (prop("form").onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
    await box.settle();
    return saved > before;
  };
  return { box, ideas, assist, pdf, save };
}

const prop0 = (box: { tree: () => unknown }, type: unknown) => (find(box.tree(), (n: Node) => n.type === type)[0] as Node | undefined)?.props ?? {};

async function main(): Promise<void> {
  part("Scenario A: an idea, then a description draft, then the idea put back");
  let f = await form();
  await f.ideas([...FRESH]);
  await f.assist(false);
  await f.ideas(null);
  is("the description's AI draft still holds the save until its own boxes are checked", await f.save(), false);
  await f.assist(true);
  is("once they are, it saves", await f.save(), true);
  f.box.unmount();

  part("Scenario B: a description draft, then an idea whose boxes alone are checked");
  f = await form();
  await f.assist(false);
  await f.ideas([...FRESH]);
  await f.ideas([...CHECKED]);
  is("the description's unchecked draft still holds the save", await f.save(), false);
  f.box.unmount();

  part("The reverse: the description's checks never release an idea's unchecked name");
  f = await form();
  await f.ideas([...FRESH]);
  await f.assist(false);
  await f.assist(true);
  is("the idea's unchecked review still holds the save", await f.save(), false);
  await f.ideas([...CHECKED]);
  is("both reviews checked: it saves", await f.save(), true);
  f.box.unmount();

  part("A draft from the product's PDF holds the save until its own boxes are checked (Codex G's MEDIUM on #3447)");
  f = await form(WITH_PDF);
  is("the PDF box is drawn for a product with a readable PDF", typeof prop0(f.box, ProductPdfAssist).onChange, "function");
  is("the PDF box is told how to tell the form about its checks", typeof prop0(f.box, ProductPdfAssist).onReviewChange, "function");
  await f.pdf([...FRESH]);
  is("the PDF's AI draft, unchecked: held", await f.save().catch(() => "threw"), false);
  await f.assist(false);
  await f.pdf([...CHECKED]);
  is("the PDF's checks never release the description's unchecked draft", await f.save(), false);
  await f.assist(true);
  is("both checked: it saves", await f.save(), true);
  await f.pdf([...FRESH]);
  await f.pdf(null);
  is("the PDF draft put back, nothing else waiting: it saves", await f.save(), true);
  f.box.unmount();

  part("Controls");
  f = await form();
  is("no AI draft: it saves", await f.save(), true);
  await f.ideas([...FRESH]);
  is("an idea alone, unchecked: held", await f.save(), false);
  await f.ideas(null);
  is("the idea put back with nothing else drafted: it saves", await f.save(), true);
  f.box.unmount();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
