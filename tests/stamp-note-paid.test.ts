/**
 * Claude 5 icEJ on #5360 @3faa549193: the problem note is one script billed PROBLEM_NOTE_WRITE_COMMANDS (main wrote it
 * with one SET) and the storage note's clear is a compare-and-delete billed three (main: one DEL), but only a copy made
 * on the fly priced them (FLY_BASE). Every other note a download writes, and the clear, is now paid first from the
 * store's public requests (PROBLEM_NOTE_UNITS, lib/stamp-cost-rules.ts), and refused, nothing is written: the buyer
 * still gets what the download gives (owner rule MR: a ceiling before every spend). The storage note of a copy sent
 * unkept is written only once that copy's flyUnits, which hold FLY_BASE and so this note, are paid. Synthetic files and addresses;
 * Redis is the repository's in-memory stand-in (tests/redis-stub.ts), the file stores tests/stamped-drop-retry-world.ts.
 */
import { readFileSync } from "node:fs";
import * as stamp from "@/lib/pdf-stamp";
import * as rules from "@/lib/stamp-cost-rules";
import { MAX_STAMP_BYTES, type ProductFile } from "@/lib/product-file";
import * as world from "./stamped-drop-retry-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const FOLDER = "fedcba9876543210fedcba9876543210";
const UNITS = (rules as { PROBLEM_NOTE_UNITS?: number }).PROBLEM_NOTE_UNITS;
const shop = { sid: "stamp-note-paid", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "" };
const sale = { reference: "cs_test_n0tePa1d00001", email: "buyer@example.com", paidAt: Date.UTC(2026, 10, 24) / 1000 };

function meter(left: number) {
  const log: string[] = [];
  const m: rules.CopyMeter = {
    async take(units) {
      log.push(`take ${units}`);
      if (units > left) return false;
      left -= units;
      return true;
    },
    async give(units) {
      log.push(`give ${units}`);
      left += units;
    },
  };
  return { m, log };
}

/** Counts what Redis bills while `run` goes: a script is the EVAL plus each call inside it. */
async function billed(run: () => Promise<unknown>): Promise<{ evals: number; commands: number }> {
  const plain = redis.pipeline.bind(redis);
  let evals = 0;
  let commands = 0;
  redis.pipeline = (async (list: (string | number)[][]) => {
    for (const c of list) {
      const script = String(c[0]).toUpperCase() === "EVAL";
      if (script && String(c[1]).includes("stamp-problem-note")) evals += 1;
      commands += script ? 1 + (String(c[1]).match(/redis\.call\(/g) ?? []).length : 1;
    }
    return plain(list);
  }) as typeof redis.pipeline;
  try {
    await run();
  } finally {
    redis.pipeline = plain;
  }
  return { evals, commands };
}

const big = (i: number): ProductFile => ({ pathname: `stores/${FOLDER}/000000000${i}/Huge.pdf`, name: "Huge.pdf", bytes: MAX_STAMP_BYTES + 1, contentType: "application/pdf", addedAt: "2026-11-24T00:00:00.000Z" });
function broken(i: number): ProductFile {
  const pathname = `stores/${FOLDER}/000000001${i}/Broken.pdf`;
  const bytes = new TextEncoder().encode("this is not a PDF at all");
  world.files.set(pathname, bytes);
  return { pathname, name: "Broken.pdf", bytes: bytes.byteLength, contentType: "application/pdf", addedAt: "2026-11-24T00:00:00.000Z" };
}
const note = async (file: ProductFile) => (await redis.pipeline([["GET", stamp.problemKey(file.pathname)]]))[0];

async function main(): Promise<void> {
  part("The units a note is paid with cover what it bills");
  is("PROBLEM_NOTE_UNITS is one public request", UNITS, 1);

  part("A file too big to stamp: its note is paid before it is written");
  {
    redis.clear();
    const file = big(1);
    const paid = meter(10);
    const answer = await stamp.stampedDelivery(file, sale, shop, paid.m);
    is("the buyer gets the original", answer.kind, "original");
    is("one public request taken for the note", paid.log, ["take 1"]);
    is("the note is written", await note(file), "too_big");
  }
  {
    redis.clear();
    const file = big(2);
    const empty = meter(0);
    const counted = await billed(() => stamp.stampedDelivery(file, sale, shop, empty.m));
    is("refused: the note's script is not sent", counted.evals, 0);
    is("and the note is not written; the buyer still gets the original", await note(file), null);
  }

  part("A file that cannot be stamped: its note is paid before it is written");
  {
    redis.clear();
    const file = broken(1);
    const paid = meter(10);
    const answer = await stamp.stampedDelivery(file, sale, shop, paid.m);
    is("the buyer gets the original", answer.kind, "original");
    is("one public request taken for the note", paid.log, ["take 1"]);
    is("the note says why", typeof (await note(file)), "string");
  }
  {
    redis.clear();
    const file = broken(2);
    const counted = await billed(() => stamp.stampedDelivery(file, sale, shop, meter(0).m));
    is("refused: no note script", [counted.evals, await note(file)], [0, null]);
  }

  part("Every note and clear outside a copy made on the fly goes through the paid write");
  {
    const code = readFileSync("lib/pdf-stamp.ts", "utf8");
    const delivery = code.slice(code.indexOf("export async function stampedDelivery("));
    const body = delivery.slice(0, delivery.indexOf("\n}\n"));
    is("stampedDelivery writes a note unpaid only after a copy sent unkept was paid (FLY_BASE prices it)",
      (body.match(/[^d]noteProblem\(/g) ?? []).length === 1 && /const sent = await sendUnkept\(file, stamped, meter\);\s*if \(kept === "no_room" && sent\.kind === "fly"\) await noteProblem\(file\.pathname, "storage"\);/.test(body), true);
    is("its other notes are written by notePaid with the meter", (body.match(/notePaid\(file\.pathname, [^)]*, meter\)/g) ?? []).length, 3);
    is("FLY_BASE prices the note a copy made on the fly or sent unkept writes", /\(2 \+ PROBLEM_NOTE_WRITE_COMMANDS \+ FLY_SHARE_COMMANDS\) \* COMMAND/.test(readFileSync("tests/plan-cost-registry.ts", "utf8")), true);
    is("the storage note's clear is paid first", /storageNoted && \(await meter\.take\(PROBLEM_NOTE_UNITS\)/.test(body), true);
  }

  done();
}

void main();
