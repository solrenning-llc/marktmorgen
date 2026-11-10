/**
 * The creator research list has a ceiling, checked before an answer is kept
 * (MR: a ceiling before every spend; unknown cost is never zero).
 *
 * app/api/creators/route.ts takes answers from anyone, signed in or not,
 * five an hour per connection. Before this, nl:creators:responses only grew
 * for 24 months (the daily job drops older answers), with no count and no
 * byte ceiling: many connections could fill the database, and one list over
 * the backup's part size (lib/backup-parts.ts) stops every backup run.
 *
 * Now an answer is at most 12,288 bytes as stored (every real answer fits:
 * each field at its limit, three bytes a character, stays under it), and the
 * list holds at most 320 answers, read before the write and checked again on
 * the length the write answers, so two answers sent at once cannot both pass.
 * A full list is said honestly (503 "full"), never as saved.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/creators/route";
import { RESPONSES_KEY } from "@/lib/creator-research-store";
import { RESEARCH_ANSWER_MAX_BYTES, RESEARCH_MAX_ANSWERS, RESEARCH_MAX_BYTES } from "@/lib/creator-research-room";
import { LIMITS } from "@/lib/creator-research";
import { BACKUP_MAX_BYTES } from "@/lib/backup-export";
import { store } from "./redis-stub";
import { done, is, part } from "./check";

const MAX_ANSWERS = 320;
const ANSWER_MAX_BYTES = 12_288;

const payload = {
  name: "Synthetic Creator", email: "creator@example.test", platform: "Other",
  country: "Test country", problem: "A synthetic research answer for a regression test.",
  link: "", tools: "", cost: "", consentResearch: true,
  consentFollowUp: false, consentUpdates: false, website: "",
};

let ip = 0;
async function ask(body: unknown): Promise<[number, string]> {
  ip += 1;
  const response = await POST(
    new NextRequest("https://marktmorgen.com/api/creators", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://marktmorgen.com", Host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${ip}` },
      body: JSON.stringify(body),
    }),
  );
  const json = (await response.json()) as { error?: string; saved?: boolean };
  return [response.status, json.error ?? (json.saved === true ? "saved" : "?")];
}

async function rows(): Promise<string[]> {
  const [list] = await store.pipeline([["LRANGE", RESPONSES_KEY, 0, -1]]);
  return list as string[];
}

async function fill(count: number): Promise<void> {
  store.clear();
  const at = new Date().toISOString();
  const values = Array.from({ length: count }, (_, i) => JSON.stringify({ id: `old-${i}`, createdAt: at, problem: "kept" }));
  if (values.length) await store.pipeline([["LPUSH", RESPONSES_KEY, ...values]]);
}

const pipeline = store.pipeline.bind(store);
const quiet = (on: boolean) => {
  console.error = on ? () => {} : original;
};
const original = console.error;

async function main() {
  globalThis.fetch = (async () => {
    throw new Error("Unexpected external request");
  }) as typeof fetch;

  part("A full list keeps no more answers and says so");
  {
    await fill(MAX_ANSWERS);
    is("the 321st answer is refused as full", await ask(payload), [503, "full"]);
    is("and the list still holds 320", (await rows()).length, MAX_ANSWERS);
    await fill(MAX_ANSWERS - 1);
    is("the 320th answer is kept", await ask(payload), [201, "saved"]);
    is("and the list holds 320", (await rows()).length, MAX_ANSWERS);
  }

  part("Two answers at once: the one the write finds past the ceiling takes itself back");
  {
    await fill(MAX_ANSWERS);
    // Another answer was kept between this one's read and its write: the read says 319, the write finds 321.
    store.pipeline = async (commands) => (commands.length === 1 && commands[0][0] === "LLEN" ? [MAX_ANSWERS - 1] : pipeline(commands));
    const got = await ask({ ...payload, name: "Raced Creator" });
    store.pipeline = pipeline;
    is("refused as full, never said saved", got, [503, "full"]);
    const kept = await rows();
    is("the list holds 320, none of them the raced answer", [kept.length, kept.some((row) => row.includes("Raced Creator"))], [MAX_ANSWERS, false]);
  }

  part("An unread count or an unconfirmed take-back is never a saved answer (rule 24)");
  {
    await fill(3);
    store.pipeline = async (commands) => (commands.length === 1 && commands[0][0] === "LLEN" ? ["3"] : pipeline(commands));
    quiet(true);
    const unread = await ask(payload);
    quiet(false);
    store.pipeline = pipeline;
    is("a count not read as a number: 500, nothing kept", [unread, (await rows()).length], [[500, "server_error"], 3]);

    await fill(MAX_ANSWERS);
    store.pipeline = async (commands) => {
      if (commands.length === 1 && commands[0][0] === "LLEN") return [MAX_ANSWERS - 1];
      if (commands.length === 1 && commands[0][0] === "LREM") return [undefined];
      return pipeline(commands);
    };
    quiet(true);
    const lost = await ask(payload);
    quiet(false);
    store.pipeline = pipeline;
    is("a take-back not answered 1: 500, not saved and not full", lost, [500, "server_error"]);
  }

  part("Eight answers at once never leave the list past its ceiling, whatever a reply says (review of #3584, Codex T)");
  {
    const writes = (commands: (string | number)[][]) => commands.some((c) => c[0] === "LPUSH" || c[0] === "EVAL");
    /** Eight answers sent together, each held at its count read until all eight have read it (or 200 ms). */
    const eight = async (fault: (commands: (string | number)[][], replies: unknown[]) => unknown[], dropTakeBack = false) => {
      let read = 0;
      let open: () => void = () => {};
      const all = new Promise<void>((resolve) => {
        open = resolve;
        setTimeout(resolve, 200);
      });
      store.pipeline = (async (commands: (string | number)[][]) => {
        if (commands.length === 1 && commands[0][0] === "LLEN") {
          const replies = await pipeline(commands);
          read += 1;
          if (read >= 8) open();
          await all;
          return replies;
        }
        // A take-back that does not apply (the command or its effect lost): nothing is removed, and it says so.
        if (dropTakeBack && commands.some((c) => c[0] === "LREM")) return commands.map(() => 0);
        return fault(commands, await pipeline(commands));
      }) as typeof store.pipeline;
      quiet(true);
      const got = await Promise.all(Array.from({ length: 8 }, (_, i) => ask({ ...payload, name: `Concurrent ${i}` })));
      quiet(false);
      store.pipeline = pipeline;
      return got;
    };
    const statuses = (got: [number, string][]) => got.map(([status]) => status).sort().join(",");

    await fill(MAX_ANSWERS - 1);
    const healthy = await eight((_, replies) => replies);
    is("control: all healthy, exactly one kept", [statuses(healthy), (await rows()).length], ["201,503,503,503,503,503,503,503", MAX_ANSWERS]);

    await fill(MAX_ANSWERS - 1);
    const unapplied = await eight((_, replies) => replies, true);
    is("a take-back that did not apply leaves the list at 320, never past it", (await rows()).length, MAX_ANSWERS);
    is("and only one is said saved", unapplied.filter(([status]) => status === 201).length <= 1, true);

    await fill(MAX_ANSWERS - 1);
    // Each write applied, its reply lost on the way back.
    const lost = await eight((commands, replies) => (writes(commands) ? replies.map(() => undefined) : replies));
    is("writes applied with their replies lost leave the list at 320, never past it", (await rows()).length, MAX_ANSWERS);
    is("and none is said saved: a lost reply is not a confirmation", lost.some(([status]) => status === 201), false);
    is("a later healthy answer is refused as full and the list stays at 320", [await ask(payload), (await rows()).length], [[503, "full"], MAX_ANSWERS]);
  }

  part("An answer past its byte ceiling is refused before anything is kept");
  {
    await fill(0);
    // Characters JSON writes as six bytes each (\u0001): far past the ceiling, inside the form's character limits.
    const heavy = { ...payload, problem: "\u0001".repeat(2000), tools: "\u0001".repeat(1000) };
    is("refused as too large", await ask(heavy), [413, "too_large"]);
    is("nothing kept", (await rows()).length, 0);
  }

  part("Every real answer fits under the byte ceiling");
  {
    await fill(0);
    const wide = "語";
    const largest = {
      ...payload,
      name: wide.repeat(80), email: `${wide.repeat(194)}@${wide}.${wide.repeat(3)}`, link: wide.repeat(300),
      country: wide.repeat(60), problem: wide.repeat(2000), tools: wide.repeat(1000), cost: wide.repeat(200),
      consentFollowUp: true, consentUpdates: true,
    };
    is("each field at its limit, three bytes a character, is kept", await ask(largest), [201, "saved"]);
    const [row] = await rows();
    is("and stored in fewer bytes than the ceiling", Buffer.byteLength(row ?? "", "utf8") <= ANSWER_MAX_BYTES, true);
  }

  part("The ceiling in the code is the one held here, and it never stops the backup");
  {
    is("320 answers of 12,288 bytes", [RESEARCH_MAX_ANSWERS, RESEARCH_ANSWER_MAX_BYTES, RESEARCH_MAX_BYTES], [MAX_ANSWERS, ANSWER_MAX_BYTES, MAX_ANSWERS * ANSWER_MAX_BYTES]);
    is("the whole list fits in one backup part less its 1 KiB of room", RESEARCH_MAX_BYTES <= BACKUP_MAX_BYTES - 1_024, true);
    const characters = Object.values(LIMITS).reduce((sum, limit) => sum + limit, 0);
    is("every field at its limit at three bytes a character, with 512 bytes for the rest, is under one answer's ceiling", characters * 3 + 512 <= RESEARCH_ANSWER_MAX_BYTES, true);
    const registry = readFileSync("tests/store-data-registry.ts", "utf8");
    is("the store data registry states the family's bound", /"nl:creators:responses@[^\n]*RESEARCH_MAX_ANSWERS[^\n]*RESEARCH_ANSWER_MAX_BYTES/.test(registry), true);
  }

  part("The form says a full list and a too long answer in plain words");
  {
    const form = readFileSync("components/creator-research-form.tsx", "utf8");
    is("a full list is told, with where to send the answers instead", /full:\s*`[^`]*no room[^`]*\$\{SUPPORT_EMAIL\}/.test(form), true);
    is("a too long answer is told", /too_large:\s*"[^"]*too long/.test(form), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
