/**
 * Claude 5 icEJ's LEVE on #5407 @f94c99fadd: the notes route answers a note refused because its store went away with
 * 410 "gone" and a message for the creator ("This store is closed or moved, so your note was not saved."), but the
 * notes box (components/numbers-notes.tsx) said "Check the day and the words" for every answer that was not ok, so the
 * creator was told to fix words that were fine. Now the box says the route's own message when the answer carries one,
 * through the same toast (whose live region announces it), and keeps its own sentence for an answer without one.
 * The box's real code runs under tests/client-hooks.ts; fetch is a stand-in. Synthetic only.
 */
import { NumbersNotes } from "@/components/numbers-notes";
import { NoteStoreGoneError } from "@/lib/stats-notes";
import { find, mount } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const said: string[] = [];
(globalThis as Record<string, unknown>).window = {
  dispatchEvent: (event: { detail?: unknown }) => {
    said.push(String(event.detail));
    return true;
  },
};

let reply: { status: number; body: unknown } = { status: 200, body: {} };
(globalThis as Record<string, unknown>).fetch = async () => new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });

async function submitOnce(): Promise<string | undefined> {
  said.length = 0;
  const box = await mount(NumbersNotes as (p: Record<string, unknown>) => unknown, {
    notes: [],
    onChange: () => {},
    from: "2026-11-01",
    to: "2026-11-30",
    today: "2026-11-22",
  });
  const form = find(box.tree(), (n: Node) => n.type === "form")[0] as Node;
  await (form.props?.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} });
  await box.settle();
  box.unmount();
  return said.at(-1);
}

async function main(): Promise<void> {
  part("A note refused because the store went away says why");
  reply = { status: 410, body: { ok: false, error: "gone", message: new NoteStoreGoneError().message } };
  is("RED: the route's own message is said, not 'Check the day and the words'", await submitOnce(), "This store is closed or moved, so your note was not saved.");

  part("Other refusals keep the box's own sentence");
  reply = { status: 400, body: { ok: false, error: "invalid" } };
  is("400 without a message", await submitOnce(), "That did not save. Check the day and the words, and try again.");
  reply = { status: 500, body: { ok: false, error: "server_error" } };
  is("500 without a message", await submitOnce(), "That did not save. Check the day and the words, and try again.");
  reply = { status: 410, body: { ok: false, error: "gone", message: "   " } };
  is("a blank message is never said", await submitOnce(), "That did not save. Check the day and the words, and try again.");
  reply = { status: 410, body: { ok: false, error: "gone", message: 7 } };
  is("a message that is not words is never said", await submitOnce(), "That did not save. Check the day and the words, and try again.");

  part("A kept note still confirms");
  reply = { status: 200, body: { ok: true, notes: [{ id: "n1", day: "2026-11-22", text: "Posted the reel" }] } };
  is("Note added.", await submitOnce(), "Note added.");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
