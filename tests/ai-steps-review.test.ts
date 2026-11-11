/**
 * MEDIUM 2 of cloud I's review of #3435: the whole sales page drafted step by
 * step (components/ai-steps-assist.tsx, which page-editor uses in place of
 * AiAssist) must still draw the AI-draft review under the draft it filled in,
 * the "AI draft" badge and the three checks (756 [STN3], components/ai-draft-
 * review.tsx), as AiAssist does on main: after a draft that is used, and after
 * "Use this draft" on one that came back after a Stop; never when the creator
 * keeps their page. The component's real code runs under tests/client-hooks.ts
 * with a stand-in fetch; nothing real is sent.
 */
import { AiStepsAssist, AiStepsProgress } from "@/components/ai-steps-assist";
import { AiDraftReview } from "@/components/ai-draft-review";
import { AiOn } from "@/components/ai-assist";
import { pageSteps } from "@/lib/ai-steps";
import { READ_PDF_JOBS } from "@/lib/ai-rules";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

// The few browser objects the box reads; the in-memory hook runner draws nothing.
const page = { activeElement: null as unknown };
(globalThis as Record<string, unknown>).document = page;
(globalThis as Record<string, unknown>).window = globalThis;

/** The answer to the draft's own request: lines the check sends one at a time. */
let push: (line: unknown) => void = () => {};
let close: () => void = () => {};
const stops: unknown[] = [];
/** When set, the stop request waits for this answer instead of a plain yes. */
let stopAnswer: Promise<Response> | null = null;
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { kind?: string };
  if (body.kind === "stop") {
    stops.push(body);
    if (stopAnswer) return stopAnswer;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (line) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      close = () => controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
}) as typeof fetch;

const DONE = "Drafted. Read each block, change anything, then press Save.";
const said = (tree: unknown) => find(tree, (n) => n.props?.role === "status" && n.type === "p").map((n) => texts(n.props?.children).join(""));
const alerts = (tree: unknown) => find(tree, (n) => n.props?.role === "alert").map((n) => texts(n.props?.children).join(""));
const button = (tree: unknown, label: string) => find(tree, (n) => n.type === "button" && texts(n.props?.children).join("") === label)[0] as Node | undefined;
const click = (node: Node | undefined) => (node?.props?.onClick as (() => unknown) | undefined)?.();
const progress = (tree: unknown) => find(tree, (n) => n.type === AiStepsProgress)[0]?.props as Parameters<typeof AiStepsProgress>[0] | undefined;

async function box() {
  const used: unknown[] = [];
  const mounted = await mount(
    AiStepsAssist<{ headline: string }>,
    {
      title: "Write the whole page with AI",
      hint: "A full draft.",
      placeholder: "Who it is for.",
      payload: () => ({ kind: "page", product: "p1", readFile: true }),
      steps: pageSteps(true),
      onResult: (value: { headline: string }) => used.push(value),
      done: DONE,
      allowEmpty: true,
    },
    new Map([[AiOn, { on: true, left: 30 }]]),
  );
  const write = async () => {
    click(button(mounted.tree(), "Write a draft"));
    await mounted.settle();
    push({ pad: " ".repeat(1024) });
  };
  const send = async (...lines: unknown[]) => {
    for (const line of lines) push(line);
    await mounted.settle();
  };
  const end = async (...lines: unknown[]) => {
    for (const line of lines) push(line);
    close();
    await mounted.settle();
    await mounted.settle();
  };
  return { mounted, used, write, send, end };
}

const DRAFT = { headline: "Forty weeknight dinners" };

const review = (tree: unknown) => find(tree, (n) => n.type === AiDraftReview)[0]?.props as { checks?: boolean[] } | undefined;

async function main(): Promise<void> {
  part("A draft that is used is drawn with the AI-draft review, every box unchecked");
  {
    const b = await box();
    await b.write();
    await b.send({ step: "read", state: "started" }, { step: "read", state: "done" }, { step: "write", state: "started" });
    is("no review before a draft", review(b.mounted.tree()), undefined);
    await b.end({ step: "write", state: "done" }, { done: true, ok: true, value: DRAFT, left: 19 });
    is("the draft goes into the page", b.used, [DRAFT]);
    is("the review is drawn under it, its three boxes unchecked", review(b.mounted.tree())?.checks, [false, false, false]);
    b.mounted.unmount();
  }

  part("A draft back after a Stop: the review only once it is used");
  for (const use of [true, false]) {
    const b = await box();
    await b.write();
    await b.send({ step: "read", state: "started" }, { step: "read", state: "done" });
    progress(b.mounted.tree())?.onStop();
    await b.mounted.settle();
    await b.send({ step: "write", state: "started" });
    await b.end({ step: "write", state: "done" }, { done: true, ok: true, value: DRAFT, left: 19 });
    is(`${use ? "use" : "keep"}: no review while the question is asked`, review(b.mounted.tree()), undefined);
    click(button(b.mounted.tree(), use ? "Use this draft" : "Keep my page"));
    await b.mounted.settle();
    is(use ? "Use this draft: the review is drawn" : "Keep my page: no review, the page is as it was", review(b.mounted.tree())?.checks, use ? [false, false, false] : undefined);
    b.mounted.unmount();
  }
  done();
}

void main();
