/**
 * 631 [AA1] (a): two more reads an agent makes through the real MCP route,
 * with a synthetic store. list_bundle_choices gives the same products, order
 * and reasons as the creator's own bundle picker (app/api/store/bundle, GET,
 * both reading lib/bundle-choices.ts); get_imports gives the store's imports
 * as counts, never the file's name, who started it or the rows.
 */
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { bundleChoices } from "@/lib/bundle-choices";
import { BUNDLE_CHOICES_MOST, IMPORTS_MOST, apiReadUnits } from "@/lib/api-read-rules";
import { allowanceUsed } from "@/lib/store-allowance";
import { addDraftProducts, addProduct, claimHandle, ensureStatsId, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "mcp-bundle-imports@example.com";

type Answer = { isError: boolean; raw: string; value: Record<string, unknown> };

async function main(): Promise<void> {
  redis.clear();
  const previousFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async () => {
    outside += 1;
    throw new Error("No outside requests in this test");
  }) as typeof fetch;
  try {
    await claimHandle(OWNER, "mcp-bundle-imports", "Bundle Imports", "");
    await ensureStatsId(OWNER);
    await setSubscription(OWNER, { customerId: "cus_McpBundleImp01", subscriptionId: "sub_McpBundleImp01", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
    const guide = await addProduct(OWNER, "Sourdough guide", "", "19");
    const recipes = await addProduct(OWNER, "Recipe cards", "", "9");
    const club = await addProduct(OWNER, "Bakers club", "", "5", { interval: "month" } as never);
    const empty = await addProduct(OWNER, "Coming later", "", "12");
    if (!guide.ok || !recipes.ok || !club.ok || !empty.ok) throw new Error("No synthetic products");
    await setProductLink(OWNER, guide.product.id, "https://example.com/guide");
    await setProductLink(OWNER, recipes.product.id, "https://example.com/recipes");
    const store = (await storeForEmail(OWNER))!;
    const key = await makeKey(store.sid, "Synthetic reader");
    if (!key.ok) throw new Error("No synthetic key");
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<Answer> => {
      const response = await POST(new Request("https://marktmorgen.com/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }));
      const body = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
      return { isError: body.result.isError, raw: body.result.content[0].text, value: JSON.parse(body.result.content[0].text) as Record<string, unknown> };
    };

    part("The products a bundle can be made of, as the picker lists them");
    type Choice = { id: string; title: string; price: number; can_go_in: boolean; why_not: string | null };
    const all = await call("list_bundle_choices");
    const listed = all.value.products as Choice[];
    is("answered", all.isError, false);
    is("in the creator's order, each with whether it can go in and why not", listed.map((p) => [p.title, p.can_go_in, p.why_not]), [
      ["Sourdough guide", true, null],
      ["Recipe cards", true, null],
      ["Coming later", false, "It has nothing to hand over yet"],
    ]);
    is("a membership is never offered, as in the picker", listed.some((p) => p.title === "Bakers club"), false);
    is("prices in the smallest unit", listed[0].price, 1900);
    const picker = await bundleChoices(store, { owner: "", query: "", page: 1 });
    is("the same products and reasons as the creator's picker", listed.map((p) => [p.id, p.why_not]).sort(), picker.products.map((p) => [p.id, p.why]).sort());
    const searched = await call("list_bundle_choices", { search: "  RECIPE  " });
    is("found by name, as typed", (searched.value.products as Choice[]).map((p) => p.title), ["Recipe cards"]);
    const own = await call("list_bundle_choices", { bundle: guide.product.id });
    is("the bundle being made is left out of its own list", (own.value.products as Choice[]).some((p) => p.id === guide.product.id), false);
    is("one page: no next cursor", all.value.next_cursor, null);
    const far = await call("list_bundle_choices", { cursor: "900" });
    is("a cursor past the end is an empty page, not an error", [far.isError, (far.value.products as Choice[]).length, far.value.next_cursor], [false, 0, null]);

    part("Codex A3 (#1933): each call reads one page, what one API request pays for; the catalog a page at a time");
    const made = await addDraftProducts(OWNER, Array.from({ length: 100 }, (_, i) => ({ title: `Synthetic guide ${String(i).padStart(3, "0")}`, summary: "", priceCents: 1900, link: "https://example.com/guide" })));
    if (!made.ok) throw new Error("No synthetic drafts");
    const original = redis.pipeline.bind(redis);
    const listingGet = (c: (string | number)[]) => c[0] === "GET" && /^nl:catalog:.*:l:/.test(String(c[1]));
    const measured = async (args: Record<string, unknown>) => {
      const commands: (string | number)[][] = [];
      redis.pipeline = async (batch) => {
        commands.push(...batch);
        return original(batch);
      };
      try {
        return { answer: await call("list_bundle_choices", args), commands };
      } finally {
        redis.pipeline = original;
      }
    };
    const walk = async (args: Record<string, unknown>) => {
      const seen = new Set<string>();
      const reads: number[] = [];
      const all: number[] = [];
      const data: number[] = [];
      let cursor: string | null | undefined = undefined;
      let calls = 0;
      do {
        const { answer, commands } = await measured({ ...args, ...(cursor ? { cursor } : {}) });
        calls += 1;
        reads.push(commands.filter(listingGet).length);
        all.push(commands.length);
        data.push(commands.filter((c) => /^nl:catalog:/.test(String(c[1]))).length);
        for (const p of answer.value.products as Choice[]) seen.add(p.id);
        cursor = answer.value.next_cursor as string | null;
      } while (cursor && calls < 20);
      return { seen, reads, all, data, calls };
    };
    const everything = await walk({});
    is("the 103 products that may go in, in six pages, every one seen once", [everything.calls, everything.seen.size], [6, 103]);
    is("no page reads more than 20 listings", Math.max(...everything.reads) <= 20, true);

    part("Codex A3 (#1933) 1: the catalog is never read or healed whole in one call, its names cached or not");
    const catalogId = (await storeForEmail(OWNER))!.catalog.id;
    await redis.pipeline([["DEL", `nl:catalog:${catalogId}:t`]]);
    const cold = await measured({});
    is("without the cached names, a page still reads its own 20 listings and nothing more", [cold.commands.filter(listingGet).length <= 20, cold.commands.some((c) => c[0] === "HGETALL" || c[0] === "HSET")], [true, false]);
    const coldSearch = await measured({ search: "synthetic guide" });
    is("a search then reads no listing it cannot match, and says what it could not search", [coldSearch.commands.filter(listingGet).length, (coldSearch.answer.value.unsearched as number) > 0, coldSearch.commands.some((c) => c[0] === "HGETALL" || c[0] === "HSET")], [0, true, false]);
    // Ported onto main's paid reads: each call sets aside BUNDLE_CHOICES_MOST before it reads, so what it reads of the
    // catalog stays inside that, never the whole catalog (was: inside one API request's commands, before it paid first).
    const catalogReads = (commands: (string | number)[][]) => commands.filter((c) => /^nl:catalog:/.test(String(c[1]))).length;
    is("every call reads of the catalog no more than the commands it set aside", Math.max(catalogReads(cold.commands), catalogReads(coldSearch.commands), ...everything.data) <= BUNDLE_CHOICES_MOST.commands, true);

    part("Codex A3 (#1933) 2: imports that cannot be read are said so, never an empty history");
    for (const [label, broken] of [["the list", "LRANGE"], ["a job", "GET"]] as const) {
      const real = redis.pipeline.bind(redis);
      await redis.pipeline([["LPUSH", `nl:imports:list:${store.sid}`, "b".repeat(24)], ["SET", `nl:import:${"b".repeat(24)}`, "{}"]]);
      redis.pipeline = async (batch) => (batch.some((c) => c[0] === broken && (/import/.test(String(c[1])))) ? [] : real(batch));
      let unread: Answer;
      try {
        unread = await call("get_imports");
      } finally {
        redis.pipeline = real;
      }
      is(`${label} answered short: an error, not imports: []`, [unread.isError, "imports" in unread.value], [true, false]);
      await redis.pipeline([["DEL", `nl:imports:list:${store.sid}`, `nl:import:${"b".repeat(24)}`]]);
    }

    part("Imports, as counts only");
    is("none yet", (await call("get_imports")).value.imports, []);
    const id = "a".repeat(24);
    const job = {
      id,
      kind: "contacts",
      sid: store.sid,
      by: "assistant-of-owner@example.com",
      at: 1_000,
      state: "done",
      file: "jane-doe-customers.csv",
      expected: 3,
      total: 3,
      done: 3,
      cursor: { batch: 0, row: 3 },
      counts: { added: 1, already: 1, skipped: 1, errors: 0, mailed: 0, unmailed: 0, contacts: 1, stopped: 0 },
      options: { agreed: false, consentColumn: true, tags: ["from-old-shop"], email: false, source: "csv" },
      finishedAt: 2_000,
    };
    await redis.pipeline([
      ["SET", `nl:import:${id}`, JSON.stringify(job)],
      ["LPUSH", `nl:imports:list:${store.sid}`, id],
      ["SET", `nl:import:${"b".repeat(24)}`, JSON.stringify({ ...job, id: "b".repeat(24), sid: "another-store" })],
      ["LPUSH", `nl:imports:list:${store.sid}`, "b".repeat(24)],
    ]);
    const imports = await call("get_imports");
    is("this store's import, and not another store's", (imports.value.imports as { id: string }[]).map((i) => i.id), [id]);
    is("what it came to", (imports.value.imports as Record<string, unknown>[])[0], {
      id,
      kind: "contacts",
      from: "csv",
      state: "done",
      started_at: 1_000,
      finished_at: 2_000,
      rows_expected: 3,
      rows_received: 3,
      rows_looked_at: 3,
      added: 1,
      already: 1,
      skipped: 1,
      errors: 0,
      emailed: 0,
      not_emailed: 0,
      contacts_not_emailable: 1,
      stopped: 0,
    });
    is("never the file's name, who started it or an address", /jane-doe|@/.test(imports.raw), false);

    // Codex G on #1933 (5818274659): a kept import whose store is missing, null or not text says nothing of which store
    // it is, so it is unknown, never "another store's" and left out of a history that then reads shorter or empty.
    part("Codex G (#1933): an import kept without a store that reads is unknown, never another store's");
    for (const [label, sid] of [["missing", undefined], ["null", null], ["a number", 7], ["empty", ""]] as [string, unknown][]) {
      const unsure: Record<string, unknown> = { ...job, id: "c".repeat(24) };
      if (sid === undefined) delete unsure.sid;
      else unsure.sid = sid;
      await redis.pipeline([["SET", `nl:import:${"c".repeat(24)}`, JSON.stringify(unsure)], ["LPUSH", `nl:imports:list:${store.sid}`, "c".repeat(24)]]);
      const read = await call("get_imports");
      is(`its store ${label}: an error, not a shorter list of imports`, [read.isError, "imports" in read.value], [true, false]);
      await redis.pipeline([["LREM", `nl:imports:list:${store.sid}`, 0, "c".repeat(24)], ["DEL", `nl:import:${"c".repeat(24)}`]]);
    }
    // Claude 4 (cloud B) and Codex Nuvem 3 on #3661: a kept record with an import's id is not an import by that alone.
    // Every field get_imports sends is read exactly (whole numbers >= 0 for each count and row figure, times as whole
    // numbers, kind, state and source from their sets); anything else is unknown, with all that was set aside kept,
    // never a TypeError after the hold was taken and never a count sent as text or an object.
    part("Claude 4 (cloud B) and Codex Nuvem 3 (#3661): a kept import not in its exact shape is unknown, all set aside kept");
    const used = async () => allowanceUsed((await storeForEmail(OWNER))!, "api");
    const counts = job.counts;
    const odd: [string, Record<string, unknown>][] = [
      ["only an id and this store", { id: "c".repeat(24), sid: store.sid }],
      ["no counts", { ...job, counts: undefined }],
      ["no options", { ...job, options: undefined }],
      ["a count as text", { ...job, counts: { ...counts, added: "1" } }],
      ["a count as an object", { ...job, counts: { ...counts, errors: {} } }],
      ["a count below zero", { ...job, counts: { ...counts, skipped: -1 } }],
      ["a count not whole", { ...job, counts: { ...counts, already: 1.5 } }],
      ["a count missing", { ...job, counts: { ...counts, mailed: undefined } }],
      ["contacts kept as text", { ...job, counts: { ...counts, contacts: "1" } }],
      ["stopped kept as null", { ...job, counts: { ...counts, stopped: null } }],
      ["rows expected below zero", { ...job, expected: -3 }],
      ["rows received as text", { ...job, total: "3" }],
      ["rows looked at missing", { ...job, done: undefined }],
      ["started at as text", { ...job, at: "1000" }],
      ["finished at null", { ...job, finishedAt: null }],
      ["a state not an import's", { ...job, state: "paused" }],
      ["a kind not an import's", { ...job, kind: "orders" }],
      ["a source not an import's", { ...job, options: { ...job.options, source: "elsewhere" } }],
    ];
    const failed: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void failed.push(args[0]);
    try {
      for (const [label, record] of odd) {
        await redis.pipeline([["SET", `nl:import:${"c".repeat(24)}`, JSON.stringify({ ...record, id: "c".repeat(24) })], ["LPUSH", `nl:imports:list:${store.sid}`, "c".repeat(24)]]);
        const before = await used();
        const read = await call("get_imports");
        const kept = (await used()) - before;
        is(`${label}: unknown, said so, all set aside kept`, [read.isError, "imports" in read.value, /imports could not be read/.test(String(read.value.error)), kept], [true, false, true, 1 + apiReadUnits(IMPORTS_MOST)]);
        await redis.pipeline([["LREM", `nl:imports:list:${store.sid}`, 0, "c".repeat(24)], ["DEL", `nl:import:${"c".repeat(24)}`]]);
      }
    } finally {
      console.error = realError;
    }
    is("no tool threw on any of them", failed, []);

    // LOW (rule 24): an import made before contacts and stopped were counted never recorded them; null, not a zero
    // nobody counted, and the note says so.
    part("Claude 4 (cloud B) LOW (#3661): counts an older import never recorded are null, never 0");
    const older = { ...job, counts: { added: 1, already: 1, skipped: 1, errors: 0, mailed: 0, unmailed: 0 } };
    await redis.pipeline([["SET", `nl:import:${id}`, JSON.stringify(older)]]);
    const olderRead = await call("get_imports");
    const olderRow = (olderRead.value.imports as Record<string, unknown>[])[0];
    is("contacts_not_emailable and stopped are null", [olderRow.contacts_not_emailable, olderRow.stopped], [null, null]);
    is("the note says null is not counted", /null.*(never|not) counted|not counted.*null/i.test(String(olderRead.value.note)), true);
    await redis.pipeline([["SET", `nl:import:${id}`, JSON.stringify(job)]]);

    is("with it gone, the history reads again", ((await call("get_imports")).value.imports as { id: string }[]).map((i) => i.id), [id]);

    is("nothing reached outside", outside, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

void main();
