/**
 * Focus in the studio's submission panels (review of #3571, Claude 3, MEDIUM 2;
 * WCAG 2.4.3, AX274): when the control that holds focus goes away, focus moves
 * to the next thing that stays, never to the page's body.
 *
 *   - components/submission-review.tsx (ReviewEntry): "Check the reply" moves to
 *     the confirm group; "Change it" and a send that failed move back to the
 *     reply's text; a sent reply moves to the "Your reply" block. While it sends,
 *     "Send the reply" stays focusable (aria-disabled, not disabled).
 *   - components/submission-settings.tsx: Cancel, "Stop asking for files" and
 *     Undo move to the panel's main button; its buttons stay focusable while busy.
 *
 * The components' real code runs under tests/client-hooks.ts, with every ref a
 * host element is given set to a stand-in that records focus(), as React sets
 * refs before effects; fetch answers synthetically. Nothing real is sent.
 */
import { ReviewEntry } from "@/components/submission-review";
import { SubmissionSettings } from "@/components/submission-settings";
import type { SubmissionSetup } from "@/lib/submission-rules";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

const MiB = 1024 * 1024;
const SETUP: SubmissionSetup = { instruction: "Film one set from the side.", kinds: ["video"], maxBytes: 100 * MiB, keepDays: 30 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** What was focused, in order, named by the element: its type and its own words (or its label). */
let focused: string[] = [];
const nameOf = (node: Node) => `${String(node.type)}:${String(node.props?.["aria-label"] ?? texts(node.props?.children).join("").trim())}`;
/** The tree on screen now, so a stand-in names its element as it reads when focused (its words can change). */
let onScreen: () => unknown = () => null;
const attach = (node: Node) => ({
  focus: () => focused.push(nameOf(find(onScreen(), (n) => n.props?.ref === node.props?.ref)[0] ?? node)),
});
const lastFocus = () => focused[focused.length - 1] ?? "body";

const button = (tree: unknown, label: string) => find(tree, (n) => n.type === "button" && texts(n.props?.children).join("").includes(label))[0] as Node | undefined;
const click = (node: Node | undefined) => (node?.props?.onClick as (() => unknown) | undefined)?.();
const submit = (tree: unknown) => (find(tree, (n) => n.type === "form")[0]?.props?.onSubmit as ((event: { preventDefault: () => void }) => unknown) | undefined)?.({ preventDefault: () => undefined });
const type = (tree: unknown, value: string) =>
  (find(tree, (n) => n.type === "textarea")[0]?.props?.onChange as ((event: { target: { value: string } }) => unknown) | undefined)?.({ target: { value } });
const stays = (node: Node | undefined) => [node?.props?.disabled ?? false, node?.props?.["aria-disabled"]];

// A frame comes after React has put the new elements in place (and set their refs), as in a browser: about 16 ms later.
globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => Number(setTimeout(() => callback(0), 16))) as unknown as typeof requestAnimationFrame;

const item = {
  id: "f".repeat(32),
  lessonId: "lesson0001ab",
  lessonTitle: "Lesson 1",
  buyer: "ana@example.com",
  file: { name: "set.mp4", bytes: 5 * MiB, type: "video/mp4" },
  note: "My first try.",
  at: 1_800_000_000,
  keepUntil: 1_802_592_000,
  state: "submitted" as const,
  reply: null,
};

async function review(): Promise<void> {
  let answer: () => Promise<Response> = async () => json({ ok: false, error: "gone" }, 404);
  globalThis.fetch = (async () => answer()) as typeof fetch;
  const entry = await mount(ReviewEntry as (props: { productId: string; item: typeof item }) => unknown, { productId: "prod1", item }, { attach });
  onScreen = entry.tree;
  const check = async () => {
    type(entry.tree(), "Keep your knees out.");
    await entry.settle();
    submit(entry.tree());
    await entry.settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await entry.settle();
  };

  part("A reply: focus follows what stays");
  focused = [];
  await check();
  is("control: checking it moves to what to confirm", lastFocus().startsWith("div:Send this reply?"), true);
  click(button(entry.tree(), "Change it"));
  await entry.settle();
  is("Change it moves back to the reply's text", lastFocus(), "textarea:");

  await check();
  click(button(entry.tree(), "Send the reply"));
  await entry.settle();
  is("a send that failed says so", find(entry.tree(), (n) => n.props?.role === "alert").length, 1);
  is("and moves back to the reply's text, never to the page", lastFocus(), "textarea:");

  await check();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  answer = async () => {
    await held;
    return json({ ok: true, state: "reviewed", reply: { text: "Keep your knees out.", at: 1_800_000_100 } });
  };
  click(button(entry.tree(), "Send the reply"));
  await entry.settle();
  is("while it sends, Send stays focusable (aria-disabled, not disabled)", stays(button(entry.tree(), "Sending")), [false, true]);
  release();
  await entry.settle();
  await entry.settle();
  is("a sent reply moves to the reply as kept", lastFocus().startsWith("div:Your reply"), true);
  entry.unmount();
}

async function settings(): Promise<void> {
  let answers: Response[] = [];
  globalThis.fetch = (async () => answers.shift() ?? json({ ok: false, error: "unavailable" }, 503)) as typeof fetch;
  const panel = await mount(SubmissionSettings as (props: { productId: string; lessonId: string }) => unknown, { productId: "prod1", lessonId: "lesson0001ab" }, { attach });
  onScreen = panel.tree;

  part("Settings: focus follows what stays");
  focused = [];
  answers = [json({ ok: true, setup: SETUP })];
  click(button(panel.tree(), "Open these settings"));
  await panel.settle();
  click(button(panel.tree(), "Cancel"));
  await panel.settle();
  is("Cancel moves to the panel's main button", lastFocus(), "button:Change what you ask for");

  click(button(panel.tree(), "Change what you ask for"));
  await panel.settle();
  answers = [json({ ok: true, setup: null, was: SETUP })];
  click(button(panel.tree(), "Stop asking for files"));
  await panel.settle();
  is("Stop asking for files moves to the panel's main button", lastFocus(), "button:Ask for a submission");

  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  globalThis.fetch = (async () => {
    await held;
    return json({ ok: true, setup: SETUP });
  }) as typeof fetch;
  click(button(panel.tree(), "Undo"));
  await panel.settle();
  is("while it saves, Undo stays focusable (aria-disabled, not disabled)", stays(button(panel.tree(), "Undo")), [false, true]);
  release();
  await panel.settle();
  await panel.settle();
  is("Undo moves to the panel's main button once it is gone", lastFocus(), "button:Change what you ask for");
  panel.unmount();
}

async function main(): Promise<void> {
  await review();
  await settings();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
