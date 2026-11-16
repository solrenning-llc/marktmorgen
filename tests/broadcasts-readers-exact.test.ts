/**
 * Rule 24 in lib/broadcasts.ts's two loose readers. broadcastSizes measures
 * what an MCP emails read will cost before it is paid (lib/mcp-tools.ts
 * emailsTool, which refuses on null); listBroadcasts is what that read and
 * lib/auto-marks.ts show. A list of ids in another shape was read as no
 * campaigns at all, and a record that did not parse was silently dropped.
 * Now only Redis's own answers count: an empty list is none, a nil record is a
 * campaign whose record expired (written before its id is listed, kept 400
 * days), and anything else is unknown: null from broadcastSizes, a throw from
 * listBroadcasts.
 */
import { broadcastSizes, listBroadcasts } from "@/lib/broadcasts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const id = "1234567890abcdef12345678";
const other = "abcdef1234567890abcdef12";
const row = { id, listId: "chosen-list", handle: "chosen-store", subject: "Campaign", body: "Content", productId: null, notProductId: null, who: "all", narrow: null, status: "sent", createdAt: 1, sendAt: 2, finishedAt: 3, total: 3, sent: 3, note: "", failures: 0, listed: false, tagged: true, test: null };

async function main(): Promise<void> {
  const original = redis.pipeline;
  let replies: unknown[] = [];
  redis.pipeline = (async () => {
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next as unknown[];
  }) as typeof redis.pipeline;
  const throws = async (label: string, read: () => Promise<unknown>) => {
    let failed = false;
    try {
      await read();
    } catch {
      failed = true;
    }
    is(label, failed, true);
  };
  try {
    part("Control: what Redis says plainly");
    replies = [[[]]];
    is("sizes: no campaigns, known", await broadcastSizes("chosen-list"), { count: 0, bytes: 0 });
    replies = [[[id]], [120]];
    is("sizes: one campaign of 120 bytes", await broadcastSizes("chosen-list"), { count: 1, bytes: 120 });
    replies = [[[]]];
    is("list: no campaigns, known", await listBroadcasts("chosen-list"), []);
    replies = [[[id, other]], [JSON.stringify(row), null]];
    is("list: a record Redis says is gone (nil) is left out", (await listBroadcasts("chosen-list")).map((b) => b.id), [id]);

    part("A list of ids in another shape is unknown, never no campaigns");
    for (const ids of [null, 7, "x", {}, [[7]], [["not-an-id"]], [[id, id]]]) {
      replies = [Array.isArray(ids) && ids.length === 1 && Array.isArray(ids[0]) ? ids : [ids], [0]];
      is(`sizes: ids answered as ${JSON.stringify(ids)}: null`, await broadcastSizes("chosen-list"), null);
      replies = [Array.isArray(ids) && ids.length === 1 && Array.isArray(ids[0]) ? ids : [ids], [JSON.stringify(row)]];
      await throws(`list: ids answered as ${JSON.stringify(ids)}: unknown`, () => listBroadcasts("chosen-list"));
    }
    replies = [[]];
    is("sizes: the envelope cut short: null", await broadcastSizes("chosen-list"), null);

    part("A record that is not Redis's own nil and does not read is unknown, never dropped");
    for (const bad of ["{", "null", "[]", 7, {}, JSON.stringify({ ...row, id: other })]) {
      replies = [[[id]], [bad]];
      await throws(`list: a record answered as ${JSON.stringify(bad).slice(0, 40)}: unknown`, () => listBroadcasts("chosen-list"));
    }
    replies = [[[id, other]], [JSON.stringify(row)]];
    await throws("list: fewer records than ids: unknown", () => listBroadcasts("chosen-list"));

    // Claude 4's LEVE 1 on #3187: holes and a Proxy were read past instead of refused, unlike repliesFor/stringList.
    part("A reply with a hole or behind a Proxy is unknown, as repliesFor reads it");
    // eslint-disable-next-line no-sparse-arrays
    const holed = [, id];
    replies = [[holed], [0, 0]];
    is("sizes: ids with a hole: null", await broadcastSizes("chosen-list"), null);
    replies = [[holed], [JSON.stringify(row)]];
    await throws("list: ids with a hole: unknown", () => listBroadcasts("chosen-list"));
    replies = [[new Proxy([id], {})], [120]];
    is("sizes: ids behind a Proxy: null", await broadcastSizes("chosen-list"), null);
    // eslint-disable-next-line no-sparse-arrays
    replies = [[[id, other]], [, 100]];
    is("sizes: a size with a hole: null, never the other's bytes alone", await broadcastSizes("chosen-list"), null);
    // eslint-disable-next-line no-sparse-arrays
    replies = [[[id, other]], [, JSON.stringify(row)]];
    await throws("list: records with a hole: unknown, never an expired record", () => listBroadcasts("chosen-list"));
  } finally {
    redis.pipeline = original;
  }
  done();
}

void main();
