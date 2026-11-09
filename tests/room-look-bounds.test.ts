/**
 * R20 finding 1 (synthetic): what a look at a live room may cost.
 *
 * app/api/store/community/chat/new answers anyone holding the room's pass
 * (lib/chat-pass.ts) and is priced as one command and an answer of 2,000
 * bytes (tests/traffic-cost.ts, roomLookCost), shared by the CDN between the
 * readers who ask the same address. Before this test:
 *   - any extra parameter (`&z=1`, `&z=2`...), another order or another
 *     spelling of the same address was answered, so the CDN shared nothing
 *     and every look went to Redis;
 *   - a look far behind (`s=1` in a full room) was answered with CHAT_PAGE
 *     whole messages, about 108 KB, against the 2,000 bytes it is priced at.
 *
 * Now only the exact address the room's page builds
 * (components/community-room.tsx) is answered, anything else is refused
 * with 400 before Redis is asked, and a look sends at most LOOK_BYTES of
 * messages (always at least one, so a page never sticks), with the cursor
 * at the last message it sent so the next look carries on from there.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/store/community/chat/new/route";
import { roomPass } from "@/lib/chat-pass";
import { MAX_CHAT_KEPT, MAX_CHAT_TEXT } from "@/lib/community-chat-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "c".repeat(32);
const EMPTY = "e".repeat(32);
/** What one look is priced at sending: tests/traffic-cost.ts, roomLookCost. */
const PRICED_BYTES = 2_000;

type Body = { ok: boolean; error?: string; messages?: { i: number; text: string }[]; cursor?: number };

const message = (i: number, text: string) => JSON.stringify({ i, a: "d".repeat(32), text, at: 1_000 + i, n: "Member" });

async function fill(id: string, count: number, text: (i: number) => string): Promise<void> {
  const rows: (string | number)[] = [];
  for (let i = 1; i <= count; i++) rows.push(i, message(i, text(i)));
  await redis.pipeline([["ZADD", `nl:cm:${id}:ch`, ...rows]]);
}

let commands = 0;
const original = redis.pipeline.bind(redis);
redis.pipeline = async (list) => {
  commands += list.length;
  return original(list);
};

async function look(query: string): Promise<{ status: number; body: Body; bytes: number; cache: string; commands: number }> {
  const before = commands;
  const response = await GET(new NextRequest(`https://marktmorgen.com/api/store/community/chat/new?${query}`));
  const text = await response.text();
  let body: Body = { ok: false };
  try {
    body = JSON.parse(text) as Body;
  } catch {
    // Left as not ok.
  }
  return { status: response.status, body, bytes: Buffer.byteLength(text), cache: response.headers.get("cache-control") ?? "", commands: commands - before };
}

async function main(): Promise<void> {
  redis.clear();
  await fill(ID, MAX_CHAT_KEPT, () => "y".repeat(MAX_CHAT_TEXT));
  const pass = roomPass(ID);
  is("the deployment makes a pass", /^[0-9a-f]{32}$/.test(pass), true);
  is("the price of a look is still 2,000 bytes in the cost model", /export function roomLookCost\(\)[\s\S]{0,400}?\+ 2_000 \* ORIGIN_PER_BYTE;/.test(readFileSync(join(process.cwd(), "tests/traffic-cost.ts"), "utf8")), true);

  part("Only the address the room's page builds is answered, so the CDN shares it");
  const page = readFileSync(join(process.cwd(), "components/community-room.tsx"), "utf8");
  is("the page builds c, p, s and, at a quiet room's pace, i=1, in that order", page.includes("/api/store/community/chat/new?c=${room}&p=${pass}&s=${cursor.current}${idle ? \"&i=1\" : \"\"}"), true);
  const odd = [
    `c=${ID}&p=${pass}&s=1&z=1`,
    `p=${pass}&c=${ID}&s=1`,
    `c=${ID}&s=1&p=${pass}`,
    `c=%63${ID.slice(1)}&p=${pass}&s=1`,
    `c=${ID}&p=${pass}&s=01`,
    `c=${ID}&p=${pass}&s=1.0`,
    `c=${ID}&p=${pass}&s=-1`,
    `c=${ID}&p=${pass}&s=%31`,
    `c=${ID}&p=${pass}&s=`,
    `c=${ID}&p=${pass}`,
    `c=${ID}&p=${pass}&s=1&s=2`,
    `c=${ID}&p=${pass}&s=1&i=0`,
    `c=${ID}&p=${pass}&s=1&i=1&i=1`,
    `c=${ID}&p=${pass}&s=1&`,
  ];
  const answers = [];
  for (const query of odd) answers.push(await look(query));
  is("every other spelling of the address is refused with 400", answers.map((a) => a.status), odd.map(() => 400));
  is("and none of them asks Redis", answers.map((a) => a.commands), odd.map(() => 0));
  is("and none is kept by the CDN", answers.map((a) => a.cache), odd.map(() => "no-store"));
  is("each says why, in words the page reads as not ok", answers.map((a) => [a.body.ok, a.body.error]), odd.map(() => [false, "address"]));

  const ASKS = 2_000;
  commands = 0;
  let answered = 0;
  for (let k = 0; k < ASKS; k++) if ((await look(`c=${ID}&p=${pass}&s=1&z=${k}`)).status === 200) answered += 1;
  is(`${ASKS} looks with one pass, each with its own extra parameter: none answered, no command`, [answered, commands], [0, 0]);

  part("A look far behind sends no more than it is priced at");
  const far = await look(`c=${ID}&p=${pass}&s=1`);
  const sent = far.body.messages ?? [];
  is("it is answered", [far.status, far.body.ok], [200, true]);
  is(`with no more than ${PRICED_BYTES} bytes (it sent ${far.bytes})`, far.bytes <= PRICED_BYTES, true);
  is("and at least the next message, in order", [sent.length >= 1, sent[0]?.i], [true, 2]);
  is("its cursor is the last message it sent, so nothing is skipped", far.body.cursor, sent[sent.length - 1]?.i);
  const next = await look(`c=${ID}&p=${pass}&s=${far.body.cursor}`);
  is("the next look carries on from there", [next.status, next.body.messages?.[0]?.i, next.bytes <= PRICED_BYTES], [200, (far.body.cursor ?? 0) + 1, true]);
  is("each is still one read of the database", [far.commands, next.commands], [1, 1]);
  const opened = await look(`c=${ID}&p=${pass}&s=0`);
  is("a page that has nothing yet (s=0) is answered within the same bytes", [opened.status, opened.bytes <= PRICED_BYTES, (opened.body.messages ?? []).length >= 1], [200, true, true]);

  const WIDE = "f".repeat(32);
  await fill(WIDE, 3, () => "é".repeat(MAX_CHAT_TEXT));
  const widePass = roomPass(WIDE);
  const wide = await look(`c=${WIDE}&p=${widePass}&s=0`);
  is("a single message larger than the budget is still sent, alone, so a page never sticks", [wide.status, wide.body.messages?.map((m) => m.i), wide.body.cursor], [200, [1], 1]);
  const wideNext = await look(`c=${WIDE}&p=${widePass}&s=1`);
  is("and the one after it comes with the next look", [wideNext.body.messages?.map((m) => m.i), wideNext.body.cursor], [[2], 2]);

  part("A look that is caught up is unchanged");
  const last = await look(`c=${ID}&p=${pass}&s=${MAX_CHAT_KEPT - 1}`);
  is("the one new message, whole, in one read", [last.status, last.body.messages?.map((m) => [m.i, m.text.length]), last.body.cursor, last.commands], [200, [[MAX_CHAT_KEPT, MAX_CHAT_TEXT]], MAX_CHAT_KEPT, 1]);
  is("shared by the CDN for a few seconds", last.cache, "public, max-age=0, s-maxage=3");
  const idle = await look(`c=${ID}&p=${pass}&s=${MAX_CHAT_KEPT}&i=1`);
  is("nothing new at a quiet room's pace, shared a little longer", [idle.status, idle.body.messages, idle.body.cursor, idle.cache], [200, [], MAX_CHAT_KEPT, "public, max-age=0, s-maxage=10"]);
  const empty = await look(`c=${EMPTY}&p=${roomPass(EMPTY)}&s=0`);
  is("an empty room answers nothing, with its cursor where it was", [empty.status, empty.body.messages, empty.body.cursor], [200, [], 0]);
  is("a wrong pass is still 403 and asks nothing", [(await look(`c=${ID}&p=${"0".repeat(32)}&s=1`)).status, (await look(`c=${ID}&p=${"0".repeat(32)}&s=1&z=1`)).commands], [403, 0]);
  is("a room that is not one is still 404", (await look(`c=nope&p=${pass}&s=0`)).status, 404);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
