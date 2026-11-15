/**
 * One answer's PDF (GET app/api/store/forms/response-pdf) finds that answer
 * inside Redis (lib/form-store.ts readResponse, the FIND_FORM_RESPONSE script)
 * instead of bringing every kept answer to the app to look for it (sibling-
 * routes cost study of 7 November 2026, R1). Checked on the real route,
 * synthetic data only:
 *
 *   - the app sends no LRANGE of the answers, and of the list only the one
 *     answer travels back;
 *   - healthy control: the PDF is byte for byte the one made from the answer
 *     as the list of answers reads it, newest, middle and oldest;
 *   - an answer whose words hold another answer's id is not taken for it;
 *   - confirmed absence (an id not kept, a form with no answers): 404, as before;
 *   - the script's reply in any other shape, or an answer that does not read,
 *     is unknown (rule 24): 503 "unavailable", never a PDF and never "gone".
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { type FormDef } from "@/lib/forms";
import { responsePdf } from "@/lib/form-response-pdf";
import { readResponses } from "@/lib/form-store";
import { parseLanguage } from "@/lib/store-language";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as saveForms } from "@/app/api/store/forms/route";
import { GET as responseFile } from "@/app/api/store/forms/response-pdf/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "pdfdirect@example.com";
const KEPT = 120;

type Seen = { command: (string | number)[]; bytes: number };
let seen: Seen[] = [];
const size = (reply: unknown): number => (typeof reply === "string" ? Buffer.byteLength(reply) : Array.isArray(reply) ? reply.reduce<number>((sum, r) => sum + size(r), 0) : 0);
const original = redis.pipeline.bind(redis);
let breakFind: ((command: (string | number)[]) => unknown) | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const finding = commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:form-find:");
  const replies = finding && breakFind ? [breakFind(commands[0])] : await original(commands);
  commands.forEach((command, i) => seen.push({ command, bytes: size(replies[i]) }));
  return replies;
}) as typeof redis.pipeline;

const form = {
  name: "Apply", button: "", doneHeading: "", doneBody: "", offerList: false, updatedAt: 1,
  outcomes: [],
  fields: [
    { id: "aaaaaa", type: "email", label: "Your email", required: true, options: [] },
    { id: "bbbbbb", type: "long", label: "About you", required: false, options: [] },
  ],
};

/** A PDF carries the moment it was made (new Date()): both made at one fixed moment, so they compare byte for byte; the clock (Date.now) runs on. */
const RealDate = Date;
const FIXED = RealDate.now();
async function frozen<T>(make: () => Promise<T>): Promise<T> {
  class Fixed extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length) super(...(args as [number]));
      else super(FIXED);
    }
  }
  globalThis.Date = Fixed as DateConstructor;
  try {
    return await make();
  } finally {
    globalThis.Date = RealDate;
  }
}
const base64 = (bytes: Uint8Array | ArrayBuffer) => Buffer.from(bytes as ArrayBuffer).toString("base64");

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "pdfdirect", "PDF Direct", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const saved = (await (await saveForms(new NextRequest("https://marktmorgen.com/api/store/forms", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ form }) }))).json()).form as FormDef;
  if (!saved?.id) throw new Error("no form");
  const store = (await storeForEmail(OWNER))!;
  const list = `nl:form:r:${store.statsId}:${saved.id}`;
  const idOf = (i: number) => i.toString(16).padStart(32, "0");
  const at = 1_790_000_000;
  // Written as addResponse writes them (JSON.stringify), the newest first.
  const answer = (i: number, words = "I sell recipes to busy parents. ".repeat(60)) => JSON.stringify({ id: idOf(i), at: at + i, page: "", answers: { aaaaaa: `p${i}@example.com`, bbbbbb: words }, outcome: "", joined: false });
  for (let i = 0; i < KEPT; i += 1) await redis.pipeline([["LPUSH", list, answer(i)]]);
  // Each download is one of the store's essential actions of the day: its counter is cleared so the checks are not counted out.
  const essential = `nl:rl:studio-essential:${createHash("sha256").update(`nimbus-studio-essential:${store.sid || store.handle}`).digest("hex").slice(0, 32)}`;
  const get = async (response: string, id = saved.id) => {
    await redis.pipeline([["DEL", essential]]);
    return frozen(() => responseFile(new NextRequest(`https://marktmorgen.com/api/store/forms/response-pdf?id=${id}&response=${response}`, { headers: { cookie: `${SESSION_COOKIE}=${session}` } })));
  };
  const listed = (await readResponses(store.statsId, saved.id)).responses;
  const expected = async (id: string) => {
    const response = listed.find((r) => r.id === id)!;
    const when = new Date(response.at * 1000);
    const sentLine = `Sent on ${new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(when)}`;
    return base64(await frozen(() => responsePdf({ form: saved, response, storeName: store.name, sentLine, lang: parseLanguage(store.language) })));
  };

  for (const [name, i] of [["the newest", KEPT - 1], ["one in the middle", 57], ["the oldest", 0]] as const) {
    part(`${name}`);
    seen = [];
    const got = await get(idOf(i));
    const body = got.status === 200 ? base64(await got.arrayBuffer()) : "";
    is("answered with the PDF", [got.status, got.headers.get("content-type")], [200, "application/pdf"]);
    is("byte for byte the PDF made from the answer as the list reads it", body, await expected(idOf(i)));
    is("no LRANGE of the answers sent by the app", seen.filter((s) => s.command[0] === "LRANGE" && s.command[1] === list).length, 0);
    is("of the list, only the one answer travels back", seen.filter((s) => s.command.includes(list)).reduce((sum, s) => sum + s.bytes, 0), Buffer.byteLength(answer(i)));
  }

  part("An answer whose words hold another answer's id");
  await redis.pipeline([["LPUSH", list, answer(KEPT, `see ${JSON.stringify({ id: idOf(3) })} "id":"${idOf(3)}"`)]]);
  seen = [];
  const decoy = await get(idOf(3));
  is("is not taken for it: the real one is found", [decoy.status, seen.filter((s) => s.command.includes(list)).reduce((sum, s) => sum + s.bytes, 0)], [200, Buffer.byteLength(answer(3))]);

  part("Confirmed absence, as before");
  is("an answer no longer kept: 404", (await get("b".repeat(32))).status, 404);
  const other = (await (await saveForms(new NextRequest("https://marktmorgen.com/api/store/forms", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ form: { ...form, name: "Empty" } }) }))).json()).form as FormDef;
  is("a form with no answers: 404", (await get(idOf(1), other.id)).status, 404);

  part("Unknown is never a PDF and never gone (rule 24)");
  const shapes: [string, (command: (string | number)[]) => unknown][] = [
    ["a number", () => 1],
    ["a list", () => [answer(9)]],
    ["an object", () => ({ ok: true })],
    ["text that is not an answer", () => "not json"],
    ["an answer without its time", () => JSON.stringify({ id: idOf(9), answers: {} })],
    ["another answer", () => answer(10)],
  ];
  for (const [name, reply] of shapes) {
    breakFind = reply;
    try {
      const got = await get(idOf(9));
      is(`${name}: 503 unavailable`, [got.status, (await got.text()).includes("unavailable")], [503, true]);
    } finally {
      breakFind = null;
    }
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
