/**
 * #5010 row 145 (synthetic only): a form's answers as a file (GET
 * /api/store/forms/export, lib/forms.ts responsesCsv) read every kept
 * response, up to KEPT_RESPONSES of them with MAX_FIELDS answers of up to
 * MAX_LONG_ANSWER characters each, and sent a file sized by them, for the one
 * essential request that let it in, nothing from the store's studio figure,
 * while a studio request is priced at twenty commands and fifty kilobytes
 * (tests/plan-cost-registry.ts, UNIT_COST.studio). A form at the store's data
 * room moves hundreds of times that.
 *
 * Now the export measures its answers in Redis first, with nothing read out
 * (lib/form-store.ts responsesSize), and takes from the store's studio figure
 * the units of reading them at their widest and of the file, at the unit of a
 * download (lib/export-unit-rules.ts), before any answer is read; the file is
 * held again before it is sent, and what was held and not used is given back.
 * A size that does not read, or a figure without the units, refuses before
 * any answer is read.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { allowanceUsed, forceAllowance } from "@/lib/store-allowance";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { DATA_ROOM_BYTES } from "@/lib/store-data-rules";
import { KEPT_RESPONSES, MAX_FIELDS, MAX_LONG_ANSWER, parseForm } from "@/lib/forms";
import { writeForm } from "@/lib/form-store";
import { GET as exportGet } from "@/app/api/store/forms/export/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ORIGIN_PER_BYTE, UNIT_COST, request } from "./plan-cost-registry";

type Store = NonNullable<Awaited<ReturnType<typeof storeForEmail>>>;

const FORM = "formbig001";
const form = parseForm({
  id: FORM,
  name: "Long answers",
  fields: Array.from({ length: MAX_FIELDS }, (_, i) => ({ id: `fld${String(i).padStart(3, "0")}`, type: "long", label: `Question ${i + 1}` })),
  updatedAt: 1,
})!;
const answersKey = (store: Store) => `nl:form:r:${store.statsId}:${FORM}`;

async function storeWith(owner: string, handle: string): Promise<{ store: Store; session: string }> {
  await claimHandle(owner, handle, "Forms export", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  await writeForm(store.statsId!, form);
  return { store, session: await openSession(owner) };
}

/** `count` responses, each of MAX_FIELDS answers `each` characters of `char` long, pushed as the form keeps them. */
async function answers(store: Store, count: number, each: number, char = "a"): Promise<number> {
  let bytes = 0;
  for (let i = 0; i < count; i += 100) {
    const page = Array.from({ length: Math.min(100, count - i) }, (_, k) =>
      JSON.stringify({ at: 1_800_000_000 + i + k, page: "apply", answers: Object.fromEntries(form.fields.map((f) => [f.id, char.repeat(each)])), outcome: "", joined: false }),
    );
    bytes += page.reduce((sum, item) => sum + Buffer.byteLength(item, "utf8"), 0);
    await redis.pipeline([["LPUSH", answersKey(store), ...page]]);
  }
  return bytes;
}

/** One export, with what it read from the database (commands, bytes, whether the answers were read) and what it sent. */
async function exportOf(store: Store, session: string, alter?: (command: (string | number)[]) => unknown) {
  let commands = 0;
  let bytes = 0;
  let read = false;
  const pipeline = redis.pipeline;
  redis.pipeline = async (list) => {
    if (list.some((c) => c[0] === "LRANGE" && c[1] === answersKey(store))) read = true;
    const replies = await pipeline(list);
    commands += list.length;
    bytes += Buffer.byteLength(JSON.stringify(replies), "utf8");
    return alter ? replies.map((reply, i) => (alter(list[i]) === undefined ? reply : alter(list[i]))) : replies;
  };
  const before = await allowanceUsed(store, "studio");
  try {
    const response = await exportGet(new NextRequest(`https://marktmorgen.com/api/store/forms/export?id=${FORM}`, { headers: { host: "marktmorgen.com", "x-nimbus-store": store.sid, cookie: `${SESSION_COOKIE}=${session}` } }));
    const text = await response.text();
    redis.pipeline = pipeline;
    const taken = (await allowanceUsed(store, "studio")) - before;
    return { status: response.status, commands, bytes, sent: Buffer.byteLength(text, "utf8"), read, taken, text };
  } finally {
    redis.pipeline = pipeline;
  }
}

/** What an export that read `bytes` in `commands` and sent `sent` costs at the most, by the registry's own prices. */
const costOf = (commands: number, bytes: number, sent: number) => request("heavy", commands, bytes) + sent * ORIGIN_PER_BYTE;

async function main(): Promise<void> {
  console.error = () => {};

  part("A form's answers as a file: 300 responses, each with every answer at MAX_LONG_ANSWER characters");
  {
    redis.clear();
    const { store, session } = await storeWith("fx-big@example.com", "fxbigform");
    await answers(store, 300, MAX_LONG_ANSWER);
    const got = await exportOf(store, session);
    console.log(`status ${got.status}; commands ${got.commands}; bytes read ${got.bytes}; bytes sent ${got.sent}; studio units taken ${got.taken}`);
    is("(setup) it answered with the file", [got.status, got.text.split("\r\n").length - 2], [200, 300]);
    is("the studio units it takes pay for what it read and sent", got.taken * UNIT_COST.studio >= costOf(got.commands, got.bytes, got.sent), true);
  }

  part("Answers whose every character is sent at its widest (a <, escaped in six): the units still pay for them");
  {
    redis.clear();
    const { store, session } = await storeWith("fx-wide@example.com", "fxwideform");
    await answers(store, 100, MAX_LONG_ANSWER, "<");
    const got = await exportOf(store, session);
    console.log(`status ${got.status}; commands ${got.commands}; bytes read ${got.bytes}; bytes sent ${got.sent}; studio units taken ${got.taken}`);
    is("(setup) it answered with the file", got.status, 200);
    is("the studio units it takes pay for what it read and sent", got.taken * UNIT_COST.studio >= costOf(got.commands, got.bytes, got.sent), true);
  }

  part("A creator on the Store plan whose answers fill the store's whole data room still downloads every one of them");
  {
    redis.clear();
    const { store, session } = await storeWith("fx-room@example.com", "fxroomform");
    // KEPT_RESPONSES responses, as long as the Store plan's room lets the store keep them all.
    const each = Math.floor((DATA_ROOM_BYTES.creator / KEPT_RESPONSES - 400) / MAX_FIELDS);
    const kept = await answers(store, KEPT_RESPONSES, Math.min(each, MAX_LONG_ANSWER));
    const got = await exportOf(store, session);
    console.log(`kept ${kept.toLocaleString("en-US")} bytes; status ${got.status}; bytes read ${got.bytes}; bytes sent ${got.sent}; studio units taken ${got.taken} of ${STORE_ALLOWANCES.creator.studio}`);
    is("(setup) the answers fill the room", kept <= DATA_ROOM_BYTES.creator && kept > DATA_ROOM_BYTES.creator * 0.9, true);
    is("it answers with the whole file", [got.status, got.text.split("\r\n").length - 2], [200, KEPT_RESPONSES]);
    is("within the Store plan's studio figure, a small share of it", got.taken > 0 && got.taken * 10 <= STORE_ALLOWANCES.creator.studio, true);
    is("the studio units it takes pay for what it read and sent", got.taken * UNIT_COST.studio >= costOf(got.commands, got.bytes, got.sent), true);
  }

  part("An export when the studio figure has no room left for it");
  {
    redis.clear();
    const { store, session } = await storeWith("fx-spent@example.com", "fxspentform");
    await answers(store, 300, MAX_LONG_ANSWER);
    await forceAllowance(store, "studio", STORE_ALLOWANCES.creator.studio);
    const spent = await exportOf(store, session);
    is("refused as too many, not answered with a file", spent.status, 429);
    is("no answer is read", spent.read, false);
  }

  part("An export when the figure has room for the request but not for the answers");
  {
    redis.clear();
    const { store, session } = await storeWith("fx-short@example.com", "fxshortform");
    await answers(store, 300, MAX_LONG_ANSWER);
    await forceAllowance(store, "studio", STORE_ALLOWANCES.creator.studio - 3);
    const short = await exportOf(store, session);
    console.log(`answered ${short.status}: ${short.text.slice(0, 200)}`);
    is("refused as too many", short.status, 429);
    is("no answer is read", short.read, false);
    is("nothing taken from the studio figure", short.taken, 0);
    is("it says how many the file needs and how many are left, never that the figure is used", [/^This download needs [0-9,]+ of your studio requests this month, and only 3 are left\./.test(short.text), /are used/.test(short.text)], [true, false]);
  }

  part("An export whose size of the answers comes back in a shape Redis does not give");
  {
    redis.clear();
    const { store, session } = await storeWith("fx-odd@example.com", "fxoddform");
    await answers(store, 10, 100);
    const odd = await exportOf(store, session, (c) => (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:form-responses-size:") ? [10, "9"] : undefined));
    is("refused as unavailable, not answered with a file", odd.status, 503);
    is("no answer is read", odd.read, false);
  }

  part("An empty form still downloads its header");
  {
    redis.clear();
    const { store, session } = await storeWith("fx-empty@example.com", "fxemptyform");
    const empty = await exportOf(store, session);
    is("the file is its header alone", [empty.status, empty.text.split("\r\n").length - 2], [200, 0]);
    is("nothing taken from the studio figure: there is nothing to read", empty.taken, 0);
  }

  done();
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
