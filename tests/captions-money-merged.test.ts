/**
 * #3346 merged with main's #3881: one exact read of a store's AI captions money (autoCaptionsMoney) feeds both course
 * page sections, the refunds Stripe has not confirmed (main's CaptionsRefundsOwed, through autoRefundsOwed) and the
 * charges kept for a person (this PR's "not confirmed yet" list). Every listed record is in one section at most and
 * none is lost between them; main's exact checks (list size, folder, a whole number of cents above zero) hold for the
 * kept charges too, never "nothing owed".
 */
import { autoCaptionsMoney, autoRefundsOwed } from "@/lib/auto-captions";
import { UnknownReplyError } from "@/lib/redis-reply";
import { streamPath } from "@/lib/stream-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "d".repeat(32);
const OTHER = "e".repeat(32);
const idOf = (n: number) => `4b7c1d2e-3f40-4a5b-8c6d-${n.toString(16).padStart(12, "0")}`;
type Shape = { cents: number; owed?: number | null; kept?: boolean; folder?: string };
const record = (id: string, { cents, owed, kept, folder }: Shape) =>
  JSON.stringify({
    langs: ["en"], got: [], at: 1_000, cents, pi: "pi_Captions000010", path: streamPath(folder ?? FOLDER, "lesson000010", id),
    ...(owed !== undefined ? { owed: { cents: owed, key: `k-${id}`, since: 1, looks: 0 } } : {}),
    ...(kept ? { kept: 2_000 } : {}),
  });
const put = (rows: [string, Shape][]) => {
  redis.clear();
  for (const [id, shape] of rows) {
    redis.run(["SADD", `nl:stream:autoowed:${FOLDER}`, id]);
    redis.run(["SET", `nl:stream:auto:${id}`, record(id, shape), "EX", 3600]);
  }
};
const money = async () => {
  try {
    return await autoCaptionsMoney(FOLDER);
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other ${String(error)}`;
  }
};

async function main(): Promise<void> {
  part("Each record in one section at most, none lost between them");
  const A = idOf(1), B = idOf(2), C = idOf(3), D = idOf(4), E = idOf(5);
  put([
    [A, { cents: 3500, owed: null }], // a refund owed in full
    [B, { cents: 1200, owed: 500, kept: true }], // owed and also kept: owed wins, never both
    [C, { cents: 3500, kept: true }], // kept for a person only
    [D, { cents: 3500, owed: 0, kept: true }], // a settlement that gives nothing back: neither
    [E, { cents: 3500 }], // neither owed nor kept: in no money section
  ]);
  const read = await money();
  is("refunds owed: A in full and B's own amount", typeof read === "string" ? read : read.owed, [{ id: A, cents: 3500, stuck: false }, { id: B, cents: 500, stuck: false }]);
  is("charges kept for a person: C only", typeof read === "string" ? read : read.unconfirmed, [{ id: C, cents: 3500 }]);
  const ids = typeof read === "string" ? [] : [...read.owed.map((r) => r.id), ...read.unconfirmed.map((r) => r.id)];
  is("no record counted twice", ids.length, new Set(ids).size);
  is("the course page's refunds section reads the same owed list", await autoRefundsOwed(FOLDER), [{ id: A, cents: 3500, stuck: false }, { id: B, cents: 500, stuck: false }]);

  part("Main's exact checks hold for the kept charges too");
  put([[C, { cents: 3500, kept: true, folder: OTHER }]]);
  is("a kept charge listed here that names another folder is unknown, never left out", await money(), "unknown");
  put([[C, { cents: 0, kept: true }]]);
  is("a kept charge of $0 is unknown, never \"a charge of $0.00\"", await money(), "unknown");
  put([[C, { cents: 12.5, kept: true }]]);
  is("nor a fractional one", await money(), "unknown");
  put(Array.from({ length: 101 }, (_, i): [string, Shape] => [idOf(100 + i), { cents: 3500, kept: true }]));
  is("more members than one read takes is unknown, never cut to the first hundred", await money(), "unknown");
  put([[C, { cents: 3500, kept: true }], [E, { cents: 3500, folder: OTHER }]]);
  is("control: a record that is neither owed nor kept is not checked for its folder", await money(), { owed: [], unconfirmed: [{ id: C, cents: 3500 }] });
  done();
}

void main();
