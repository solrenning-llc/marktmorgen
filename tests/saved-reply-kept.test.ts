/**
 * AX274, WCAG 3.3.7 Redundant Entry and 3.3.6 Error Prevention at AAA: what the
 * creator typed is never thrown away by a save that did not happen. Chromium on
 * 13 November 2026, /studio/inbox: "Save the reply" emptied the Name and The reply
 * fields at once, before the server answered; when the save failed ("That did not
 * work. Check your connection and try again.") the reply was gone and had to be
 * typed again from memory.
 *
 * What must hold: the fields are emptied only once the save is confirmed; a failed
 * save leaves both exactly as typed. Exercised on the real component with the
 * repository's hook runner (tests/client-hooks.ts).
 */
import * as inbox from "@/components/inbox-studio";
import type { SavedReply } from "@/lib/inbox-rules";
import { find, mount } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> };
type Props = { saved: SavedReply[]; busy: boolean; onSave: (saved: SavedReply[], done: string) => Promise<boolean> };
const SavedReplies = (inbox as unknown as { SavedReplies?: (props: Props) => unknown }).SavedReplies;

async function typeAndSave(answer: boolean) {
  const calls: SavedReply[][] = [];
  const box = await mount(SavedReplies as (props: Props) => unknown, {
    saved: [],
    busy: false,
    onSave: async (saved) => {
      calls.push(saved);
      return answer;
    },
  });
  const field = (tag: string) => find(box.tree(), (n) => (n as Node).type === tag)[0] as Node;
  (field("input").props!.onChange as (e: unknown) => void)({ target: { value: "Where is my download?" } });
  await box.settle();
  (field("textarea").props!.onChange as (e: unknown) => void)({ target: { value: "It is in the email we sent after you paid." } });
  await box.settle();
  const form = find(box.tree(), (n) => (n as Node).type === "form")[0] as Node;
  await (form.props!.onSubmit as (e: unknown) => unknown)({ preventDefault() {} });
  await box.settle();
  return { calls, title: field("input").props!.value, text: field("textarea").props!.value };
}

async function main() {
  part("The saved-reply form is the real component");
  is("SavedReplies is exported for this test", typeof SavedReplies, "function");

  part("A failed save keeps what was typed");
  const failed = await typeAndSave(false);
  is("the save was asked once, with the words typed", failed.calls.map((c) => c.map((r) => [r.title, r.text])), [[["Where is my download?", "It is in the email we sent after you paid."]]]);
  is("both fields still hold what was typed", [failed.title, failed.text], ["Where is my download?", "It is in the email we sent after you paid."]);

  part("A confirmed save empties the form for the next one");
  const saved = await typeAndSave(true);
  is("both fields are empty after the save is confirmed", [saved.title, saved.text], ["", ""]);

  done();
}

void main();
