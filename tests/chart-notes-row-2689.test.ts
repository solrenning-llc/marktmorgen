/**
 * Board #5285, row #2689 (a Codex PR whose review findings stayed open when it merged; released by Claude 3, taken by
 * Claude 5 Jt9). The three LOWs still on main, each with what fails before the fix:
 *
 *   - The studio showed a failed chart-notes read as an empty history (app/studio/page.tsx `.catch(() => [])`).
 *   - A note written whose follow-up read failed, sent again, became a second note (a new random id per call).
 *   - The same failed read skipped the trim, so tries grew the hash past MAX_NOTES: tries of one note now write one
 *     field, and the trim runs on the next reading that works (an incomplete read still never deletes a note,
 *     tests/stats-notes-read-evidence.test.ts).
 *
 * Synthetic store; in-memory Redis; the studio's real component through tests/client-hooks.ts.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { MAX_NOTES, addNote, readNotes } from "@/lib/stats-notes";
import { claimHandle, ensureStatsId, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as notesRoute } from "@/app/api/store/notes/route";
import { NumbersNotes } from "@/components/numbers-notes";
import { StatsPanel } from "@/components/stats-panel";
import { readStats, studioStats, type StatsData } from "@/lib/stats";
import { store as redis } from "./redis-stub";
import { mount } from "./client-hooks";
import { done, is, part } from "./check";

const OWNER = "notes-2689@example.test";
const NOW = Date.UTC(2026, 10, 22, 12);
const DAY = "2026-11-21";
console.error = () => {};

async function liveStore(): Promise<Store> {
  redis.clear();
  if (!(await claimHandle(OWNER, "notes2689", "Fictional Notes", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  return (await storeForEmail(OWNER))!;
}
const key = (store: Store) => `nl:stats:${store.statsId}:notes`;
/** The next HGETALL of the notes throws, as a reply lost after the write landed. */
function failNextRead(): () => void {
  const real = redis.pipeline.bind(redis);
  let armed = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (armed && commands.length === 1 && commands[0][0] === "HGETALL") {
      armed = false;
      throw new Error("synthetic: the reading's reply was lost");
    }
    return real(commands);
  }) as typeof redis.pipeline;
  return () => { redis.pipeline = real; };
}
async function threw(run: () => Promise<unknown>): Promise<boolean> {
  try { await run(); return false; } catch { return true; }
}

async function main(): Promise<void> {
  part("A note sent again after its write landed but its reading failed is one note, not two");
  {
    const store = await liveStore();
    const restore = failNextRead();
    const first = await threw(() => addNote(store, DAY, "Posted the reel", NOW, "0a1b2c3d"));
    restore();
    is("set-up: the first try is not answered as kept", first, true);
    const second = await addNote(store, DAY, "Posted the reel", NOW, "0a1b2c3d");
    is("the try sent again with the same operation id answers the list", Array.isArray(second), true);
    is("and the note is there once", (await readNotes(store.statsId)).filter((n) => n.text === "Posted the reel").length, 1);
    is("under the operation id", (await readNotes(store.statsId)).map((n) => n.id), ["0a1b2c3d"]);
    const other = await addNote(store, DAY, "Launched the course", NOW);
    is("a note without an operation id still gets an id of its own", other?.length, 2);
    is("an operation id in another shape is not used as the field", (await addNote(store, DAY, "Price down", NOW, "../x"))?.some((n) => n.id === "../x"), false);
  }

  part("Tries of one note whose reading keeps failing add one field, never one a try");
  {
    const store = await liveStore();
    const full: (string | number)[] = [];
    for (let i = 0; i < MAX_NOTES; i += 1) full.push(i.toString(16).padStart(8, "0"), JSON.stringify({ day: DAY, text: `Note ${i}` }));
    await redis.pipeline([["HSET", key(store), ...full]]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const restore = failNextRead();
      await threw(() => addNote(store, DAY, "New note", NOW, "feedf00d"));
      restore();
    }
    const [count] = await redis.pipeline([["HLEN", key(store)]]);
    is("three tries of one note whose reading failed add one field, not three", count, MAX_NOTES + 1);
    const kept = await addNote(store, DAY, "New note", NOW, "feedf00d");
    is("the try whose reading works keeps that one note and trims to MAX_NOTES", [kept?.length, (await redis.pipeline([["HLEN", key(store)]]))[0], kept?.some((n) => n.id === "feedf00d")], [MAX_NOTES, MAX_NOTES, true]);
  }

  part("The notes route passes the studio's operation id on");
  {
    const store = await liveStore();
    const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
    const response = await notesRoute(new NextRequest("https://marktmorgen.com/api/store/notes", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify({ action: "add", day: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), text: "Through the route", op: "deadbeef" }) }));
    const data = (await response.json()) as { ok?: boolean; notes?: { id: string }[] };
    is("the note is kept under the studio's operation id", [response.status, data.notes?.map((n) => n.id)], [200, ["deadbeef"]]);
  }

  part("The studio says notes that could not be read, never an empty history");
  {
    const page = readFileSync("app/studio/page.tsx", "utf8");
    is("the page's reading of the notes answers null on a failure, not []", [/readNotes\(current\.statsId\)\.catch\(\(\) => \[\]\)/.test(page), /readNotes\(current\.statsId\)\.catch\(\(\): null => null\)/.test(page)], [false, true]);
    // The real panel, rendered (Claude 2 upbeat's LEVE on #5401, as tests/ad-spend-unread-shown.test.ts renders it).
    const store = await liveStore();
    const stats = await readStats(store, NOW);
    if (!stats) throw new Error("no stats");
    const data = studioStats(store, stats, null, "none", []) as StatsData;
    const unreadPanel = renderToStaticMarkup(createElement(StatsPanel, { data, canExport: false, askHeard: false, spends: [], notes: null }));
    is("the panel with notes that could not be read says so", unreadPanel.includes("Your notes could not be read just now"), true);
    const nonePanel = renderToStaticMarkup(createElement(StatsPanel, { data, canExport: false, askHeard: false, spends: [], notes: [] }));
    is("the panel with no notes says nothing of the kind", nonePanel.includes("could not be read just now"), false);
    const html = renderToStaticMarkup(createElement(NumbersNotes, { notes: [], unread: true, onChange: () => {}, from: "2026-11-01", to: DAY, today: DAY }));
    is("the list says the notes could not be read, in a status region", /role="status"[^>]*>Your notes could not be read just now/.test(html), true);
    is("and that nothing was deleted", html.includes("Nothing was deleted."), true);
    const read = renderToStaticMarkup(createElement(NumbersNotes, { notes: [], onChange: () => {}, from: "2026-11-01", to: DAY, today: DAY }));
    is("notes read as none say nothing of the kind", read.includes("could not be read"), false);
  }

  part("The studio keeps one operation id across the tries of one note, and a new one after it is confirmed");
  {
    const sent: { op?: string; text?: string }[] = [];
    let answer: { status: number; body: unknown } = { status: 503, body: { ok: false, error: "server_error" } };
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")) as { op?: string; text?: string });
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as typeof fetch;
    type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
    const find = (node: unknown, match: (n: Node) => boolean): Node | null => {
      if (!node || typeof node !== "object") return null;
      if (Array.isArray(node)) { for (const c of node) { const hit = find(c, match); if (hit) return hit; } return null; }
      const n = node as Node;
      return match(n) ? n : find(n.props?.children, match);
    };
    const props = { notes: [], onChange: () => {}, from: "2026-11-01", to: DAY, today: DAY };
    const view = await mount(NumbersNotes as (p: typeof props) => unknown, props);
    await view.settle();
    const words = find(view.tree(), (n) => n.type === "input" && n.props?.placeholder === "Posted the October reel");
    (words!.props!.onChange as (e: { target: { value: string } }) => void)({ target: { value: "Posted the reel" } });
    await view.settle();
    const submit = async () => {
      const form = find(view.tree(), (n) => n.type === "form");
      await (form!.props!.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} });
      await view.settle();
    };
    await submit();
    await submit();
    is("two failed tries of one note send the same operation id", [sent.length, sent[0]?.op === sent[1]?.op, /^[a-f0-9]{8}$/.test(sent[0]?.op ?? "")], [2, true, true]);
    answer = { status: 200, body: { ok: true, notes: [{ id: sent[0].op, day: DAY, text: "Posted the reel" }] } };
    await submit();
    is("the confirmed try still carries it", sent[2]?.op, sent[0]?.op);
    const again = find(view.tree(), (n) => n.type === "input" && n.props?.placeholder === "Posted the October reel");
    (again!.props!.onChange as (e: { target: { value: string } }) => void)({ target: { value: "Launched the course" } });
    await view.settle();
    answer = { status: 503, body: { ok: false } };
    await submit();
    is("the next note gets a new operation id", sent[3]?.op !== sent[0]?.op && /^[a-f0-9]{8}$/.test(sent[3]?.op ?? ""), true);
    view.unmount();
  }

  done();
}

void main();
