/**
 * The creator research answers (lib/creator-research-store.ts) can be deleted by the address that sent them, and read
 * back for that person's copy of their data (r24 unit 1, MÉDIO 1.1 and LEVE 1.2). Rule 24: a reply not in its exact
 * shape, an answer that cannot be read, or a walk that does not reach the end of the list is never "nothing of theirs"
 * and never a finished deletion; a deletion stopped part way says how many went and is never taken as done.
 * Synthetic answers only; no external request.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as research from "@/lib/creator-research-store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store } from "./redis-stub";

// Read through the module object, so a missing function fails each test on its own instead of the whole file's build.
const { RESPONSES_KEY } = research;
const RESEARCH_PAGE = research.RESEARCH_PAGE as number;
const RESEARCH_PAGES = research.RESEARCH_PAGES as number;
const forgetResearchPerson = (email: string) => research.forgetResearchPerson(email);
const researchCopyPerson = (email: string) => research.researchCopyPerson(email);
const isIncomplete = (e: unknown): e is { removed: number } => e instanceof research.ResearchForgetIncomplete;

const pipeline = store.pipeline.bind(store);
type Command = (string | number)[];

let made = 0;
function answer(email: string, extra: Record<string, unknown> = {}): string {
  made += 1;
  return JSON.stringify({ id: `synthetic-${made}`, createdAt: "2026-11-01T00:00:00.000Z", name: `Synthetic ${made}`, email, country: "US", problem: "Synthetic", ...extra });
}

/** The list as stored, newest first, the way the form's LPUSH leaves it. */
async function list(): Promise<string[]> {
  return ((await pipeline([["LRANGE", RESPONSES_KEY, 0, -1]])) as string[][])[0];
}

async function world(
  seed: string[],
  run: (commands: Command[][]) => Promise<void>,
  reply?: (command: Command, index: number) => unknown | Promise<unknown>,
) {
  await pipeline([["DEL", RESPONSES_KEY]]);
  // Seeded oldest first, so the list reads in the order given.
  for (const entry of [...seed].reverse()) await pipeline([["LPUSH", RESPONSES_KEY, entry]]);
  const commands: Command[][] = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;
  store.pipeline = async (batch) => {
    commands.push(batch);
    if (reply) return (await reply(batch[0], commands.length - 1)) as unknown[];
    return pipeline(batch);
  };
  try { await run(commands); }
  finally { store.pipeline = pipeline; globalThis.fetch = fetch; await pipeline([["DEL", RESPONSES_KEY]]); }
}

const removals = (commands: Command[][]) => commands.filter((batch) => batch[0][0] === "LREM");

// ---------------------------------------------------------------- healthy

test("every answer under the address is deleted, whatever its case and spaces, and only those", async () => {
  const a1 = answer("Ana@Example.com");
  const a2 = answer("  ana@example.COM ");
  const other = answer("bo@example.com");
  const near = answer("ana@example.com.br");
  await world([a1, other, a2, near], async (commands) => {
    assert.equal(await forgetResearchPerson(" ANA@example.com"), 2);
    assert.deepEqual(await list(), [other, near]);
    assert.equal(removals(commands).length, 2);
    for (const batch of removals(commands)) assert.equal(batch[0][2], 0, "LREM 0 takes every copy of that exact answer");
  });
});

test("an address with nothing kept is confirmed absent, and nothing is removed", async () => {
  const other = answer("bo@example.com");
  await world([other], async (commands) => {
    assert.equal(await forgetResearchPerson("ana@example.com"), 0);
    assert.deepEqual(await list(), [other]);
    assert.equal(removals(commands).length, 0);
  });
  await world([], async (commands) => {
    assert.equal(await forgetResearchPerson("ana@example.com"), 0);
    assert.deepEqual(await researchCopyPerson("ana@example.com"), []);
    assert.equal(removals(commands).length, 0);
  });
});

test("the copy holds that person's answers, newest first, with every field they sent, and nothing of anyone else", async () => {
  const newer = answer("ana@example.com", { tools: "Synthetic tools", consentFollowUp: true });
  const other = answer("bo@example.com");
  const older = answer("ANA@example.com");
  await world([newer, other, older], async (commands) => {
    const copy = await researchCopyPerson("ana@example.com");
    assert.deepEqual(copy, [JSON.parse(newer), JSON.parse(older)]);
    assert.deepEqual(await list(), [newer, other, older], "a copy changes nothing");
    assert.equal(removals(commands).length, 0);
  });
});

test("answers past the first page are found and deleted, and the walk reads the whole list", async () => {
  const seed: string[] = [];
  for (let i = 0; i < RESEARCH_PAGE * 2 + 5; i += 1) seed.push(answer(`p${i}@example.com`));
  const deep = answer("ana@example.com");
  const last = answer("ana@example.com");
  seed.splice(RESEARCH_PAGE + 3, 0, deep);
  seed.push(last);
  await world(seed, async () => {
    assert.deepEqual(await researchCopyPerson("ana@example.com"), [JSON.parse(deep), JSON.parse(last)]);
    assert.equal(await forgetResearchPerson("ana@example.com"), 2);
    const after = await list();
    assert.equal(after.length, RESEARCH_PAGE * 2 + 5);
    assert.ok(!after.includes(deep) && !after.includes(last));
  });
});

test("an answer sent while the deletion runs is found by the confirming walk and deleted too", async () => {
  const first = answer("ana@example.com");
  const late = answer("ana@example.com");
  let pushed = false;
  await world([first], async () => {
    assert.equal(await forgetResearchPerson("ana@example.com"), 2);
    assert.deepEqual(await list(), []);
  }, async (command) => {
    if (command[0] === "LREM" && !pushed) {
      pushed = true;
      await pipeline([["LPUSH", RESPONSES_KEY, late]]);
    }
    return pipeline([command]);
  });
});

test("an answer another job removed first is not counted, and the deletion still ends confirmed", async () => {
  const mine = answer("ana@example.com");
  await world([mine], async () => {
    assert.equal(await forgetResearchPerson("ana@example.com"), 0);
    assert.deepEqual(await list(), []);
  }, async (command) => {
    if (command[0] === "LREM") await pipeline([["LREM", RESPONSES_KEY, 0, mine]]); // The 24-month pruning took it.
    return pipeline([command]);
  });
});

test("an answer another job removes from the part already read never makes the walk pass over one of theirs", async () => {
  // Theirs sit at both page boundaries (newest-first position RESEARCH_PAGE and its mirror from the oldest end), so a
  // walk in either direction would pass over one if the removal shifted the list under it.
  const seed: string[] = [];
  for (let i = 0; i < RESEARCH_PAGE * 3; i += 1) seed.push(answer(`q${i}@example.com`));
  const nearHead = answer("ana@example.com");
  const nearTail = answer("ana@example.com");
  seed[RESEARCH_PAGE] = nearHead;
  seed[seed.length - 1 - RESEARCH_PAGE] = nearTail;
  for (const run of ["copy", "forget"] as const) {
    let firstPage: string[] = [];
    let reads = 0;
    await world(seed, async () => {
      if (run === "copy") assert.deepEqual(await researchCopyPerson("ana@example.com"), [JSON.parse(nearHead), JSON.parse(nearTail)]);
      else {
        assert.equal(await forgetResearchPerson("ana@example.com"), 2);
        assert.ok(!(await list()).some((entry) => entry === nearHead || entry === nearTail));
      }
    }, async (command) => {
      if (command[0] === "LRANGE") {
        reads += 1;
        if (reads === 2) {
          const gone = firstPage.find((entry) => entry !== nearHead && entry !== nearTail);
          if (gone) await pipeline([["LREM", RESPONSES_KEY, 0, gone]]); // Another person's deletion, between two pages.
        }
        const reply = await pipeline([command]);
        if (reads === 1) firstPage = (reply as string[][])[0];
        return reply;
      }
      return pipeline([command]);
    });
  }
});

// ---------------------------------------------------------------- unknown is never absent or done

const badPages: [string, unknown][] = [
  ["missing reply", []],
  ["extra reply", [[], []]],
  ["hole", Array(1)],
  ["null page", [null]],
  ["number page", [3]],
  ["object page", [{}]],
  ["string page", ["[]"]],
  ["number member", [[1]]],
  ["null member", [[null]]],
  ["hole member", [Array(1)]],
  ["not a list", null],
];

for (const [name, raw] of badPages) {
  test(`an unreadable page is not "nothing of theirs": ${name}`, async () => {
    const mine = answer("ana@example.com");
    await world([mine], async (commands) => {
      await assert.rejects(forgetResearchPerson("ana@example.com"), UnknownReplyError);
      assert.equal(removals(commands).length, 0);
      await assert.rejects(researchCopyPerson("ana@example.com"), UnknownReplyError);
      assert.deepEqual(await list(), [mine]);
    }, () => raw);
  });
}

const badAnswers: [string, string][] = [
  ["not JSON", "{not json"],
  ["JSON string", JSON.stringify("ana@example.com")],
  ["JSON list", JSON.stringify([{ email: "ana@example.com" }])],
  ["JSON null", "null"],
  ["no email", JSON.stringify({ id: "synthetic-x", name: "Synthetic" })],
  ["number email", JSON.stringify({ id: "synthetic-y", email: 7 })],
  ["empty email", JSON.stringify({ id: "synthetic-z", email: "  " })],
];

for (const [name, bad] of badAnswers) {
  test(`an answer whose sender cannot be read stops the deletion and the copy: ${name}`, async () => {
    const mine = answer("ana@example.com");
    await world([mine, bad], async (commands) => {
      await assert.rejects(forgetResearchPerson("ana@example.com"), UnknownReplyError);
      assert.equal(removals(commands).length, 0, "nothing is removed before the whole list is read");
      await assert.rejects(researchCopyPerson("ana@example.com"), UnknownReplyError);
      assert.deepEqual(await list(), [mine, bad]);
    });
  });
}

const badReceipts: [string, unknown][] = [
  ["missing receipt", []],
  ["extra receipt", [1, 1]],
  ["hole", Array(1)],
  ["null receipt", [null]],
  ["string receipt", ["1"]],
  ["negative receipt", [-1]],
  ["fractional receipt", [0.5]],
  ["nonfinite receipt", [Number.NaN]],
  ["not a list", "OK"],
];

for (const [name, raw] of badReceipts) {
  test(`a removal not confirmed is reported partial, never done: ${name}`, async () => {
    const first = answer("ana@example.com");
    const second = answer("ana@example.com");
    let lrem = 0;
    await world([first, second], async () => {
      const error = await forgetResearchPerson("ana@example.com").then(
        () => assert.fail("a partial deletion was taken as done"),
        (e: unknown) => e,
      );
      assert.ok(isIncomplete(error));
      assert.equal(error.removed, 1, "the one confirmed removal is said");
      assert.deepEqual(await list(), [second]);
    }, async (command) => {
      if (command[0] === "LREM") {
        lrem += 1;
        if (lrem === 2) return raw;
      }
      return pipeline([command]);
    });
  });
}

test("a walk that does not reach the end of the list within its ceiling is unknown", async () => {
  const page = Array.from({ length: RESEARCH_PAGE }, (_, i) => answer(`ceiling${i}@example.com`));
  await world([], async (commands) => {
    await assert.rejects(forgetResearchPerson("ana@example.com"), UnknownReplyError);
    assert.equal(commands.length, RESEARCH_PAGES, "the walk stops at its ceiling");
    assert.equal(removals(commands).length, 0);
    await assert.rejects(researchCopyPerson("ana@example.com"), UnknownReplyError);
  }, () => [page]);
});

test("answers still there after every confirming walk make the deletion partial, with what went", async () => {
  const mine = answer("ana@example.com");
  await world([mine], async (commands) => {
    const error = await forgetResearchPerson("ana@example.com").then(
      () => assert.fail("an answer still kept was taken as deleted"),
      (e: unknown) => e,
    );
    assert.ok(isIncomplete(error));
    assert.ok(error.removed >= 1);
    assert.ok(removals(commands).length >= 2, "it walks and removes again before giving up");
    assert.deepEqual(await list(), [mine]);
  }, async (command) => (command[0] === "LREM" ? [1] : pipeline([command]))); // Says removed, never removes.
});

test("an address that is not one is refused before anything is read", async () => {
  await world([answer("ana@example.com")], async (commands) => {
    for (const bad of ["", "   ", "ana", "ana@", "@example.com", "a b@example.com"]) {
      await assert.rejects(forgetResearchPerson(bad), TypeError);
      await assert.rejects(researchCopyPerson(bad), TypeError);
    }
    assert.equal(commands.length, 0);
  });
});
