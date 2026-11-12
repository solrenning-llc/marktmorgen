/**
 * The studio's page editor (app/studio/pages/page.tsx) never takes a note after paying it could not read for no note
 * (CX-123 rule 24; C4-20261106-2610-C6-153, unit B; lib/thanks-note-store.ts throws UnknownReplyError since #2838).
 *
 * Before, readThanksNote(...).catch(() => null) handed the note editor an empty note: it showed "None", empty fields,
 * and "Save the note" sent what the creator typed over the note that is kept, unseen. Now the page says the note could
 * not be read, and mounts no note editor, so nothing can be saved over it; the page editor itself is unchanged.
 *
 * The real page and a real store over the memory Redis stub; only Redis's answer to the note's GET changes (no reply,
 * a text that is not a note, a number). An answer Redis gives as "none kept" (null) is still no note. The page's
 * client editors need Next's app router to render to HTML, so what the page returns is read instead (as
 * tests/page-show-unknown.test.ts does in #2832): the editors it would mount and the words it would say.
 * Synthetic data only.
 */
import StudioPagesPage from "@/app/studio/pages/page";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductNote, storeForEmail } from "@/lib/store";
import { writeThanksNote } from "@/lib/thanks-note-store";
import { ThanksNoteEditor } from "@/components/thanks-note-editor";
import { PageEditor } from "@/components/page-editor";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "note-unread@example.com";
/** The words the page says (lib/thanks-note.ts NOTE_UNREAD), written out so a change to them is a change here too. */
const NOTE_UNREAD = "Your note after paying could not be read just now, so it is not shown and nothing was changed. Reload, then try again.";
const ORIGIN = "https://marktmorgen.com";
type Mode = "no reply" | "not a note" | "not a text" | "confirmed none";

/** Every element of this component in a page's element tree, with its props. */
function found(node: unknown, component: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) found(child, component, out);
    return out;
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (element.type === component && element.props) out.push(element.props);
  for (const value of Object.values(element.props ?? {})) if (value && typeof value === "object") found(value, component, out);
  return out;
}

/** Whether a page's element tree says this text. */
function says(node: unknown, text: string): boolean {
  if (typeof node === "string") return node.includes(text);
  if (node === null || node === undefined || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((child) => says(child, text));
  return Object.values((node as { props?: Record<string, unknown> }).props ?? {}).some((value) => says(value, text));
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "noteunread", "Note unread", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Guide", "A guide.", "19", null);
  if (!made.ok) throw new Error("setup");
  const product = made.product.id;
  const shop = (await storeForEmail(OWNER))!;
  const note = { heading: "Start here", body: "Fictional welcome instructions.", video: null, button: null };
  await writeThanksNote(shop.statsId!, product, note, shop);
  if (!(await setProductNote(OWNER, product, true)).ok) throw new Error("setup: note mark");
  const session = await openSession(OWNER);
  const noteKey = `nl:product:note:${shop.statsId}:${product}`;

  const open = async (mode: Mode | null) => {
    answering(new Request(`${ORIGIN}/studio/pages?product=${product}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
    const original = redis.pipeline.bind(redis);
    let hits = 0;
    if (mode) {
      redis.pipeline = async (commands) => {
        const reply = await original(commands);
        if (commands.length !== 1 || commands[0][0] !== "GET" || commands[0][1] !== noteKey) return reply;
        hits += 1;
        if (mode === "no reply") return [];
        if (mode === "not a note") return ["{"];
        if (mode === "not a text") return [7];
        return [null];
      };
    }
    try {
      const page = await StudioPagesPage({ searchParams: Promise.resolve({ product }) });
      return { page, hits };
    } finally {
      redis.pipeline = original;
    }
  };

  for (const mode of ["no reply", "not a note", "not a text"] as const) {
    part(`The note's read answers ${mode}`);
    const { page, hits } = await open(mode);
    is("the note was asked for", hits, 1);
    is("the page says the note could not be read", says(page, NOTE_UNREAD), true);
    is("and mounts no note editor that could save over it", found(page, ThanksNoteEditor).length, 0);
    is("the page editor itself is still there", found(page, PageEditor).length, 1);
  }

  part("An answer Redis gives as none kept is still no note");
  const none = await open("confirmed none");
  is("the note editor starts empty, and nothing says it could not be read", [found(none.page, ThanksNoteEditor).map((props) => props.initial), says(none.page, NOTE_UNREAD)], [[null], false]);

  part("A note read as it is opens in its editor");
  const known = await open(null);
  is("the note editor starts from the kept note", [found(known.page, ThanksNoteEditor).map((props) => props.initial), says(known.page, NOTE_UNREAD)], [[note], false]);

  done();
}

void main();
