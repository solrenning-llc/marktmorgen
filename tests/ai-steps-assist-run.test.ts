/**
 * The writing help's box for a page drafted step by step, run as the
 * creator uses it (758 [STN5] unit 1; components/ai-steps-assist.tsx). The
 * component's real code runs under tests/client-hooks.ts, with `fetch`
 * replaced by a stand-in whose lines arrive one at a time, in the order a
 * check gives them. Nothing real is sent. What is checked:
 *   - a draft that comes back after the creator pressed Stop (writing had
 *     already started) never replaces the page on its own: the box says it
 *     finished and counts toward the month, and asks "Use this draft" or
 *     "Keep my page";
 *   - without a Stop, the draft is used as before;
 *   - Stop stays where it is once writing starts, unavailable and saying
 *     why, so focus on it is never dropped mid-run;
 *   - a draft that comes back with a step not run says that step was not
 *     charged and how many writing jobs were given back;
 *   - a PDF with nothing to write from says so, not "try again";
 *   - what is said about a late Stop is true in either order (the Stop can
 *     reach the server after the step that reads it), never "when you
 *     pressed Stop";
 *   - a stop request that fails after the run ended says nothing about a
 *     Stop button that is no longer there.
 */
import { AiStepsAssist, AiStepsProgress } from "@/components/ai-steps-assist";
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

async function main(): Promise<void> {
  part("Without a Stop, the draft is used as before");
  {
    const b = await box();
    await b.write();
    await b.send({ step: "read", state: "started" }, { step: "read", state: "done" }, { step: "write", state: "started" });
    await b.end({ step: "write", state: "done" }, { done: true, ok: true, value: DRAFT, left: 19 });
    is("the draft goes into the page", b.used, [DRAFT]);
    is("it says it is drafted", said(b.mounted.tree()).includes(DONE), true);
    is("no question is asked", [button(b.mounted.tree(), "Use this draft"), button(b.mounted.tree(), "Keep my page")], [undefined, undefined]);
    b.mounted.unmount();
  }

  part("A Stop that comes after writing started: the page is never replaced on its own");
  {
    const b = await box();
    await b.write();
    await b.send({ step: "read", state: "started" }, { step: "read", state: "done" });
    is("Stop is offered while the writing step has not started", progress(b.mounted.tree())?.canStop, true);
    progress(b.mounted.tree())?.onStop();
    await b.mounted.settle();
    is("the stop is sent", stops.length, 1);
    await b.send({ step: "write", state: "started" });
    is(
      "once writing starts after the Stop, the box says the stop came too late",
      (progress(b.mounted.tree())?.announce ?? "").startsWith("Your Stop arrived after writing had started, so it will finish and count toward this month."),
      true,
    );
    await b.end({ step: "write", state: "done" }, { done: true, ok: true, value: DRAFT, left: 19 });
    is("the draft does not replace the page by itself", b.used, []);
    const words = said(b.mounted.tree()).join(" ");
    is("it says writing had started, finished and counts toward the month", /Your Stop arrived after writing had started, so it finished and counts toward this month/.test(words), true);
    is("it never says when the Stop was pressed", /when you pressed Stop/.test(words), false);
    is("it says the page is unchanged", /Your page is unchanged/.test(words), true);
    is("it asks before replacing the blocks", [Boolean(button(b.mounted.tree(), "Use this draft")), Boolean(button(b.mounted.tree(), "Keep my page"))], [true, true]);
    click(button(b.mounted.tree(), "Keep my page"));
    await b.mounted.settle();
    is("keeping the page uses nothing", b.used, []);
    is("and says so", said(b.mounted.tree()).some((t) => /Your page is as it was/.test(t)), true);
    is("the question is gone", button(b.mounted.tree(), "Use this draft"), undefined);
    b.mounted.unmount();
  }

  part("The same, when the creator chooses the draft");
  {
    const b = await box();
    await b.write();
    await b.send({ step: "read", state: "started" }, { step: "read", state: "done" });
    progress(b.mounted.tree())?.onStop();
    await b.mounted.settle();
    // The writing step's lines and the result arrive together, as a buffering proxy would hand them over.
    await b.end({ step: "write", state: "started" }, { step: "write", state: "done" }, { done: true, ok: true, value: DRAFT, left: 19 });
    is("nothing is used before the answer", b.used, []);
    click(button(b.mounted.tree(), "Use this draft"));
    await b.mounted.settle();
    is("the draft goes into the page once", b.used, [DRAFT]);
    is("it says it is drafted", said(b.mounted.tree()).includes(DONE), true);
    b.mounted.unmount();
  }

  part("A Stop pressed while the PDF is still being read, read by the server too late: what is said is true in that order");
  {
    const b = await box();
    await b.write();
    await b.send({ step: "read", state: "started" });
    progress(b.mounted.tree())?.onStop();
    await b.mounted.settle();
    // The server checked for a stop before this one landed, so writing starts.
    await b.send({ step: "read", state: "done" }, { step: "write", state: "started" });
    const announce = progress(b.mounted.tree())?.announce ?? "";
    is("it says the Stop arrived after writing had started", announce.startsWith("Your Stop arrived after writing had started"), true);
    is("it never claims writing had started when Stop was pressed", /when you pressed Stop/.test(announce), false);
    await b.end({ step: "write", state: "done" }, { done: true, ok: true, value: DRAFT, left: 19 });
    is("the draft still waits for the creator", [b.used, Boolean(button(b.mounted.tree(), "Use this draft"))], [[], true]);
    is("the held draft's words are true in this order too", said(b.mounted.tree()).some((t) => /when you pressed Stop/.test(t)), false);
    b.mounted.unmount();
  }

  part("A stop request that fails after the draft arrived: nothing about a Stop that is gone");
  {
    let answer: (r: Response) => void = () => {};
    stopAnswer = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const b = await box();
    await b.write();
    await b.send({ step: "read", state: "started" }, { step: "read", state: "done" });
    progress(b.mounted.tree())?.onStop();
    await b.mounted.settle();
    await b.end({ step: "write", state: "started" }, { step: "write", state: "done" }, { done: true, ok: true, value: DRAFT, left: 19 });
    is("the draft is held for the creator", [b.used, Boolean(button(b.mounted.tree(), "Use this draft"))], [[], true]);
    answer(new Response(JSON.stringify({ ok: false }), { status: 503, headers: { "content-type": "application/json" } }));
    await b.mounted.settle();
    await b.mounted.settle();
    stopAnswer = null;
    const announce = progress(b.mounted.tree())?.announce ?? "";
    is("it does not ask to press a Stop that is no longer there", /press Stop again/.test(announce), false);
    is("there is no Stop to press", progress(b.mounted.tree())?.stopShown ?? false, false);
    is("the question about the held draft stays", [Boolean(button(b.mounted.tree(), "Use this draft")), Boolean(button(b.mounted.tree(), "Keep my page"))], [true, true]);
    is("and its words stay", said(b.mounted.tree()).some((t) => /Your page is unchanged/.test(t)), true);
    b.mounted.unmount();
  }

  part("Control: a stop request that fails while the run goes on says so, and Stop can be pressed again");
  {
    stopAnswer = Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 503, headers: { "content-type": "application/json" } }));
    const b = await box();
    await b.write();
    await b.send({ step: "read", state: "started" });
    progress(b.mounted.tree())?.onStop();
    await b.mounted.settle();
    await b.mounted.settle();
    stopAnswer = null;
    is("it says the stop did not go through", /press Stop again/.test(progress(b.mounted.tree())?.announce ?? ""), true);
    is("Stop can be pressed again", [progress(b.mounted.tree())?.canStop, progress(b.mounted.tree())?.stopping], [true, false]);
    await b.end({ step: "read", state: "done" }, { step: "write", state: "started" }, { step: "write", state: "done" }, { done: true, ok: true, value: DRAFT, left: 19 });
    is("the draft goes into the page, since no stop went through", b.used, [DRAFT]);
    b.mounted.unmount();
  }

  part("Stop stays in place once writing starts");
  {
    const b = await box();
    await b.write();
    await b.send({ step: "read", state: "started" }, { step: "read", state: "done" }, { step: "write", state: "started" });
    const now = progress(b.mounted.tree());
    is("the button is still drawn, so focus on it is never dropped", now?.stopShown, true);
    is("but it can no longer stop anything", now?.canStop, false);
    await b.end({ step: "write", state: "done" }, { done: true, ok: true, value: DRAFT, left: 19 });
    b.mounted.unmount();
  }

  part("A draft with a step that did not run says it was not charged");
  {
    const b = await box();
    await b.write();
    // The reading's money was refused: it never reached the model, and the creator's words carried the page.
    await b.send({ step: "read", state: "started" }, { step: "write", state: "started" });
    await b.end({ step: "write", state: "done" }, { done: true, ok: true, value: DRAFT, left: 29, returned: READ_PDF_JOBS });
    is("the draft goes into the page", b.used, [DRAFT]);
    is("the reading is shown as not run, not charged", progress(b.mounted.tree())?.states, { read: "skipped", write: "done" });
    is("it says how many writing jobs were given back", said(b.mounted.tree()).some((t) => t.includes(`${READ_PDF_JOBS} writing jobs given back, 29 left this month`)), true);
    b.mounted.unmount();
  }

  part("A PDF with nothing to write from says so");
  {
    const b = await box();
    await b.write();
    await b.send({ step: "read", state: "started" }, { step: "read", state: "done" });
    await b.end({ done: true, ok: false, error: "empty", returned: 1, left: 20 });
    const words = alerts(b.mounted.tree()).join(" ");
    is("it says nothing was found to write from", /found nothing to write from in your PDF's first pages/.test(words), true);
    is("it asks for a few words, not a retry of the same", [/Add a few words/.test(words), /Try again in a moment/.test(words)], [true, false]);
    is("and what came back", words.includes("1 writing job given back, 20 left this month"), true);
    b.mounted.unmount();
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
