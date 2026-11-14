/**
 * A funnel read into a file (lib/funnel-bundle-store.ts collectBundle) never takes a read whose answer is not known
 * for "not there" (CX-123 rules 24 and 30; C4-20261106-2610-C6-153, unit B).
 *
 * Before, each read collectBundle makes turned an answer of an unknown shape into absence, and what was built from it
 * was shared, downloaded or copied as if complete:
 *   - the funnel (HGET, lib/page-funnel-store.ts readPageFunnel): "That funnel is gone" (404 unknown) for a funnel
 *     that is there;
 *   - each of its forms (HGET, lib/form-store.ts readForm): once Codex K's #2857 makes readForm throw UnknownReply
 *     (lib/redis-exact.ts) on an unknown answer, the route answered 500 server_error; before it, the form was quietly
 *     left out of the share snapshot, the file and the copy (that reader's reply shapes come with #2857, not here);
 *   - each of its pages (GET, lib/sales-page-store.ts readPage, line 38): once #2830 makes readPage throw
 *     UnknownReplyError on an unknown answer, the route answered 500 server_error ("We could not confirm the result").
 *
 * Now each answers 503 with a code that says part of the funnel could not be read (funnel_unread_counted where the try
 * was already counted toward a monthly figure, funnel_unread where it was not), and nothing is shared, copied or
 * downloaded. An answer Redis gives as "none kept" (null) is still absence: the funnel is gone (404), a form is left
 * out as before.
 *
 * The real route, a real store over the memory Redis stub; only the one targeted reply is changed after the real
 * command runs. For the page read, the stub throws the UnknownReplyError readPage throws after #2830 (its reply shapes
 * are proven in that PR's tests/page-reads-exact.test.ts); for the form read, the UnknownReply readForm throws after
 * #2857 (its reply shapes are proven there). The route refuses either class. Synthetic data only.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { readPageFunnels } from "@/lib/page-funnel-store";
import { readForms } from "@/lib/form-store";
import { listShares } from "@/lib/funnel-share-store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { UnknownReply } from "@/lib/redis-exact";
import { GET, POST } from "@/app/api/store/funnel-share/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "bundle-reads@example.com";
const URL = "https://marktmorgen.com/api/store/funnel-share";

type Read = "funnel" | "form" | "page";
type Mode = "no reply" | "not a record" | "not a text" | "unknown page" | "unknown form" | "confirmed none";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "bundlereads", "Bundle reads", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  const post = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest(URL, { method: "POST", headers, body: JSON.stringify(body) }));
    return [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];
  };
  const download = async (funnel: string) => {
    const response = await GET(new NextRequest(`${URL}?export=${funnel}`, { headers: { cookie: headers.cookie } }));
    const attachment = response.headers.get("content-disposition")?.startsWith("attachment") ?? false;
    return [response.status, attachment ? "file" : (((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok")];
  };

  // A funnel with two pages and an application form, brought in from a starter.
  const made = await post({ action: "import", starter: "coaching-application", products: {} });
  if (made[0] !== 200) throw new Error(`setup: ${JSON.stringify(made)}`);
  const shop = (await storeForEmail(OWNER))!;
  const statsId = shop.statsId!;
  const funnel = (await readPageFunnels(statsId))[0];
  const form = (await readForms(statsId))[0];
  if (!funnel || !form) throw new Error("setup: funnel or form");

  /** What a share, a copy or a download would leave behind. */
  const kept = async () => {
    const now = (await storeForEmail(OWNER))!;
    return { shares: (await listShares(statsId)).length, funnels: (await readPageFunnels(statsId)).length, pages: now.sitePages.length, forms: (await readForms(statsId)).length };
  };
  const before = await kept();
  /** The month's share, export and import counts start again, so each check meets the read and not a monthly figure. */
  const fresh = async () => {
    const counts = redis.keys().filter((key) => key.startsWith("nl:fuse:"));
    if (counts.length) await redis.pipeline([["DEL", ...counts]]);
  };

  /** Runs `task` with Redis's answer to one read changed; says how many times that read was asked. */
  async function altered(read: Read, mode: Mode, task: () => Promise<unknown>): Promise<{ result: unknown; hits: number }> {
    await fresh();
    const original = redis.pipeline.bind(redis);
    let hits = 0;
    redis.pipeline = async (commands) => {
      const reply = await original(commands);
      const [command] = commands;
      const name = String(command?.[0]);
      const key = String(command?.[1]);
      const field = String(command?.[2]);
      const target =
        commands.length === 1 &&
        (read === "funnel"
          ? name === "HGET" && key === `nl:pfunnels:${statsId}` && field === funnel.id
          : read === "form"
            ? name === "HGET" && key === `nl:forms:${statsId}` && field === form.id
            : name === "GET" && key.startsWith(`nl:product:page:${statsId}:`));
      if (!target) return reply;
      hits += 1;
      if (mode === "unknown page") throw new UnknownReplyError("a page read");
      if (mode === "unknown form") throw new UnknownReply("the form");
      if (mode === "no reply") return [];
      if (mode === "not a record") return ["{"];
      if (mode === "not a text") return [7];
      return [null];
    };
    try {
      return { result: await task(), hits };
    } finally {
      redis.pipeline = original;
    }
  }

  const cases: [Read, Mode][] = [
    ["funnel", "no reply"],
    ["funnel", "not a record"],
    ["funnel", "not a text"],
    // The form's own reply shapes (no reply, not a record, not a text) come with #2857, which makes readForm exact.
    ["form", "unknown form"],
    ["page", "unknown page"],
  ];
  for (const [read, mode] of cases) {
    part(`The funnel's ${read} read answers ${mode}`);
    const share = await altered(read, mode, () => post({ action: "share", funnel: funnel.id, days: 7 }));
    is(`share: 503 funnel_unread_counted, read asked`, [share.result, share.hits > 0], [[503, "funnel_unread_counted"], true]);
    const clone = await altered(read, mode, () => post({ action: "clone", funnel: funnel.id }));
    is(`copy in this store: 503 funnel_unread, read asked`, [clone.result, clone.hits > 0], [[503, "funnel_unread"], true]);
    const file = await altered(read, mode, () => download(funnel.id));
    is(`download: 503 funnel_unread_counted, no file`, [file.result, file.hits > 0], [[503, "funnel_unread_counted"], true]);
    is(`nothing was shared, copied or written`, await kept(), before);
  }

  part("An answer Redis gives as none kept is still absence");
  const gone = await altered("funnel", "confirmed none", () => post({ action: "clone", funnel: funnel.id }));
  is("a funnel Redis says is not kept is gone (404 unknown)", gone.result, [404, "unknown"]);
  is("and nothing is written", await kept(), before);
  const noForm = await altered("form", "confirmed none", () => download(funnel.id));
  is("a form Redis says is not kept is left out, and the file still downloads", noForm.result, [200, "file"]);

  part("With every read known, the funnel is shared, copied and downloaded as before");
  await fresh();
  is("share", await post({ action: "share", funnel: funnel.id, days: 7 }), [200, "ok"]);
  is("copy in this store", await post({ action: "clone", funnel: funnel.id }), [200, "ok"]);
  is("download", await download(funnel.id), [200, "file"]);

  done();
}

void main();
