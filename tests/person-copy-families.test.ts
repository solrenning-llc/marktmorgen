/**
 * Every family of a store's people's data is in the person's copy (GDPR arts. 15 and 20, UK GDPR, LGPD art. 18; C7
 * data-copy hunt). lib/person-data.ts says what every module keeps about a store's people; the copy
 * (lib/person-copy.ts) must say each of them, read where it can be read, and say in words what it could not read,
 * never leave it out in silence. Before, the copy covered only the modules the erasure reaches or keeps on purpose:
 * the do-not-email fingerprint and the stops on update emails and review requests, the rows of an imported file,
 * webhook deliveries kept a week and the sending lists were in no part of it.
 *
 * Synthetic data, the in-memory Redis double, no provider.
 */
import { claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { erasureScope } from "@/lib/person-erasure";
import * as copying from "@/lib/person-copy";
import { COPY_PLAN, copyPerson } from "@/lib/person-copy";
import { PERSON_DATA } from "@/lib/person-data";
import { suppressCommand } from "@/lib/suppression";
import * as updates from "@/lib/product-updates";
import * as reviews from "@/lib/review-requests";
import * as recovery from "@/lib/checkout-recovery";
import * as asking from "@/lib/checkout-ask";
import * as hooks from "@/lib/webhooks";
import { ASK_WHENS } from "@/lib/ask-when";
import { store as redis } from "./redis-stub";
import { namesAddress } from "@/lib/address-match";
import { done, is, part } from "./check";

type Command = (string | number)[];
type Also = { how: string; in?: string; days?: number; what?: string };
const ALSO = ((copying as Record<string, unknown>).COPY_ALSO ?? {}) as Record<string, Also>;
const ALSO_COPIERS = ((copying as Record<string, unknown>).ALSO_COPIERS ?? {}) as Record<string, unknown>;
const OWNER = "families-owner@example.com";
const PERSON = "nina@example.com";
const OTHER = "otto@example.com";

async function outcome<T>(promise: Promise<T>): Promise<{ threw: string } | { value: T }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { threw: error instanceof Error ? error.name : String(error) };
  }
}

async function main(): Promise<void> {
  part("Every line about a store's people is in the copy");
  const about = PERSON_DATA.filter((d) => d.how !== "account" && d.how !== "none");
  const covered = (d: (typeof PERSON_DATA)[number]) => Boolean(COPY_PLAN[d.file] || (d.how === "erased" && d.via && COPY_PLAN[d.via]) || ALSO[d.file]);
  is("no line of lib/person-data.ts about a store's people is left out of the copy", about.filter((d) => !covered(d)).map((d) => `${d.how} ${d.file}`), []);
  is("each line the copy reads beyond the erasure has its reader", Object.entries(ALSO).filter(([m, p]) => p.how === "copied" && !ALSO_COPIERS[m]).map(([m]) => m), []);
  is("each line read within another part names a part that is read", Object.entries(ALSO).filter(([, p]) => p.how === "within" && !(COPY_PLAN[p.in!]?.how === "copied" || ALSO[p.in!]?.how === "copied")).map(([m]) => m), []);
  // The part about their no reads these four (checked below with each mark written); any other one-way mark must be
  // in a part that is read.
  const yourNo = ["lib/suppression.ts", "lib/product-updates.ts", "lib/review-requests.ts", "lib/checkout-recovery.ts"];
  is("each one-way mark (suppression) is read: in their no, or in a part that is copied", about.filter((d) => d.how === "suppression" && !(ALSO["lib/suppression.ts"]?.how === "copied" && yourNo.includes(d.file)) && COPY_PLAN[d.file]?.how !== "copied").map((d) => d.file), []);

  part("What is held only while a job is done says how long, no shorter than the store is told or the code keeps it");
  const told = (file: string) => Math.max(0, ...PERSON_DATA.filter((d) => d.file === file && d.how === "expires").map((d) => ("days" in d ? d.days : 0)));
  is("each passing line says at least the days lib/person-data.ts says", Object.entries(ALSO).filter(([m, p]) => p.how === "passing" && !((p.days ?? 0) >= told(m))).map(([m]) => m), []);
  const ask = ALSO["lib/checkout-ask.ts"];
  const askMost = Math.max(...Object.values(ASK_WHENS)) + Number((asking as Record<string, unknown>).ASK_STALE_SECONDS ?? Infinity);
  is("a reminder asked for waits as long as the code can keep it: three days and the hours a late try may still go", (ask?.days ?? 0) * 86_400 >= askMost, true);
  is("webhook deliveries: the store is told a week, and the code keeps them a week", [told("lib/webhooks.ts") * 86_400, (hooks as Record<string, unknown>).WEBHOOK_DELIVERY_KEEP_SECONDS], [7 * 86_400, 7 * 86_400]);

  part("The copy reads them");
  redis.clear();
  await claimHandle(OWNER, "familiesshop", "Families Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const listId = store.listId!;
  const sid = store.sid;
  const stop = (key: string | undefined) => (key ? [["SET", key, "2026-11-01T10:00:00.000Z"]] : []);
  const markKey = (mod: Record<string, unknown>, name: string, email: string) => (typeof mod[name] === "function" ? (mod[name] as (s: string, e: string) => string)(statsId, email) : undefined);
  redis.run(suppressCommand(listId, PERSON, 1_793_000_000));
  for (const command of [...stop(markKey(updates, "updatesStopMarkKey", PERSON)), ...stop(markKey(reviews, "reviewStopMarkKey", PERSON)), ...stop(markKey(recovery, "recoveryStopMarkKey", PERSON)), ...stop(markKey(updates, "updatesStopMarkKey", OTHER))]) redis.run(command);
  // An import of the store: a row still waiting, a row not brought in, the note of rows seen and an email waiting.
  const importId = "a1".repeat(12);
  const job = { id: importId, kind: "purchases", sid, by: OWNER, at: Date.now(), state: "mailing", file: "buyers.csv", expected: 3, total: 3, done: 1, cursor: { batch: 0, row: 0 }, counts: { added: 1, already: 0, skipped: 0, errors: 1, mailed: 0, unmailed: 0, contacts: 0, stopped: 0 }, options: { agreed: false, consentColumn: false, tags: [], email: true, dateOrder: "", source: "csv" }, finishedAt: 0 };
  redis.run(["SET", `nl:import:${importId}`, JSON.stringify(job), "EX", 14 * 86_400]);
  redis.run(["LPUSH", `nl:imports:list:${sid}`, importId]);
  // Addresses that only contain theirs (Codex G on #4321): a longer domain, and a longer local part.
  const LONGER = `${PERSON}.au`, PREFIXED = `x${PERSON}`;
  redis.run(["RPUSH", `nl:import:${importId}:rows`, JSON.stringify([["2", "Nina@Example.com", "Nina", "prod1"], ["3", OTHER, "Otto", "prod1"], ["7", LONGER, "Nia", "prod1"], ["8", PREFIXED, "Xenia", "prod1"]])]);
  redis.run(["RPUSH", `nl:import:${importId}:errors`, JSON.stringify([4, "email", "Not a product here", PERSON]), JSON.stringify([5, "email", "Not a product here", OTHER]), JSON.stringify([9, "email", "Not a product here", LONGER])]);
  redis.run(["HSET", `nl:import:${importId}:seen`, `p:${PERSON}|prod1`, "2", `p:${OTHER}|prod1`, "3", `p:${PERSON}.au|prod1`, "6"]);
  redis.run(["SADD", `nl:import:${importId}:mail`, PERSON, OTHER]);
  // A second import whose only email waiting is to a longer address than theirs: nothing of it is about them.
  const otherImport = "b2".repeat(12);
  redis.run(["SET", `nl:import:${otherImport}`, JSON.stringify({ ...job, id: otherImport, file: "others.csv" }), "EX", 14 * 86_400]);
  redis.run(["LPUSH", `nl:imports:list:${sid}`, otherImport]);
  redis.run(["SADD", `nl:import:${otherImport}:mail`, LONGER, PREFIXED]);
  // A webhook delivery about them, and one about somebody else.
  const delivery = (id: string, email: string) => JSON.stringify({ id, statsId, endpoint: "ep_1", eventId: "evt_1", type: "order.paid", body: JSON.stringify({ type: "order.paid", data: { email, product: "prod1" } }), attempts: 1, state: "delivered", next: 0, lastStatus: 200, lastError: "", lastAt: Date.now(), createdAt: Date.now() });
  const mine = `dlv_${"1".repeat(24)}`, theirs = `dlv_${"2".repeat(24)}`, longer = `dlv_${"3".repeat(24)}`;
  redis.run(["SET", `nl:hooks:d:${mine}`, delivery(mine, PERSON), "EX", 7 * 86_400]);
  redis.run(["SET", `nl:hooks:d:${theirs}`, delivery(theirs, OTHER), "EX", 7 * 86_400]);
  redis.run(["SET", `nl:hooks:d:${longer}`, delivery(longer, LONGER), "EX", 7 * 86_400]);
  redis.run(["LPUSH", `nl:hooks:log:${statsId}`, mine, theirs, longer]);

  const scope = (await erasureScope(store, PERSON))!;
  const copy = await copyPerson(scope, Date.now());
  const section = (m: string) => (copy.sections.find((s) => s.module === m)?.records ?? []) as Record<string, unknown>[];
  is("their no: the do-not-email list and each stop they pressed, with when", section("lib/suppression.ts"), [
    { yourNo: "On the store's do-not-email list", since: "2026-10-26T07:33:20.000Z" },
    { yourNo: "Stopped product update emails", since: "2026-11-01T10:00:00.000Z" },
    { yourNo: "Stopped review requests", since: "2026-11-01T10:00:00.000Z" },
    { yourNo: "Stopped checkout reminders", since: "2026-11-01T10:00:00.000Z" },
  ]);
  const imported = section("lib/imports.ts").find((r) => r.import === "buyers.csv") as Record<string, unknown> | undefined;
  is("the imported file's row waiting that names them, and only theirs", imported?.rowsWaiting, [["2", "Nina@Example.com", "Nina", "prod1"]]);
  is("the row not brought in that names them", imported?.notBroughtIn, [{ row: 4, column: "email", problem: "Not a product here", value: PERSON }]);
  is("the note of which row they were seen on, not a longer address that starts with theirs", imported?.rowsSeen, [{ key: `${PERSON}|prod1`, row: "2" }]);
  is("and that an email to them from the import waits", imported?.toBeEmailed, true);
  const hooked = section("lib/webhooks.ts");
  is("the webhook delivery about them, as the endpoint received it, and not the other", hooked.map((h) => [h.event, h.state, (h.sent as { data: { email: string } }).data.email]), [["order.paid", "delivered", PERSON]]);
  is("nobody else's address is anywhere in it", JSON.stringify(copy).includes(OTHER), false);
  is("nor an address that only contains theirs (rows, report, mail queue, webhook body)", [JSON.stringify(copy).includes(LONGER), JSON.stringify(copy).includes(PREFIXED)], [false, false]);
  is("an import whose only email waiting is to another address is not in it", section("lib/imports.ts").map((r) => r.import), ["buyers.csv"]);
  is("what is held only while a job is done is said, with how long", Array.isArray(copy.passing) && copy.passing.some((p) => p.includes("sending list") && p.includes("at most 60 days")), true);
  is("everything was read: the copy is complete", [copy.complete, copy.notComplete], [true, []]);

  part("An address with letters outside ASCII is found whole too (Claude 3 cloud S on #4321)");
  // The import takes such addresses, so the copy must find them: a token cut at the first non-ASCII letter never
  // equals the address, and their own rows went missing while the copy still said it was complete.
  is("a non-ASCII domain, any case", namesAddress("José@Müller.de", "josé@müller.de"), true);
  is("a non-ASCII local part inside a webhook body", namesAddress(JSON.stringify({ data: { email: "josé@example.com" } }), "josé@example.com"), true);
  is("the same letters written decomposed", namesAddress("jose\u0301@mu\u0308ller.de", "josé@müller.de"), true);
  is("a longer non-ASCII address is still not theirs", [namesAddress("xjosé@müller.de", "josé@müller.de"), namesAddress("josé@müller.de.au", "josé@müller.de")], [false, false]);
  is("nor is the part of it after a non-ASCII letter", namesAddress("josé@müller.de", "é@müller.de"), false);
  {
    const WIDE = "josé@müller.de";
    const wideImport = "c3".repeat(12);
    redis.run(["SET", `nl:import:${wideImport}`, JSON.stringify({ ...job, id: wideImport, file: "wide.csv" }), "EX", 14 * 86_400]);
    redis.run(["LPUSH", `nl:imports:list:${sid}`, wideImport]);
    redis.run(["RPUSH", `nl:import:${wideImport}:rows`, JSON.stringify([["2", "José@Müller.de", "José", "prod1"], ["3", `x${WIDE}`, "Xosé", "prod1"]])]);
    const wideCopy = await copyPerson((await erasureScope(store, WIDE))!, Date.now());
    const wideRows = ((wideCopy.sections.find((s) => s.module === "lib/imports.ts")?.records ?? []) as Record<string, unknown>[]).find((r) => r.import === "wide.csv")?.rowsWaiting;
    is("their own import row is in their copy, and only theirs", wideRows, [["2", "José@Müller.de", "José", "prod1"]]);
  }

  part("What is kept but cannot be read makes the copy say it is not complete");
  for (let i = 0; i < 50; i += 1) {
    const id = `dlv_${String(i).padStart(24, "a")}`;
    redis.run(["SET", `nl:hooks:d:${id}`, delivery(id, OTHER), "EX", 7 * 86_400]);
    redis.run(["LPUSH", `nl:hooks:log:${statsId}`, id]);
  }
  redis.run(["LTRIM", `nl:hooks:log:${statsId}`, 0, 49]);
  const full = await copyPerson((await erasureScope(store, PERSON))!, Date.now());
  is("a full log of this week's deliveries may hide older ones still kept: said, not left out", [full.complete, full.notComplete.some((line) => line.includes("webhooks") && line.includes("could not be read"))], [false, true]);

  part("An import on the store's list kept in a shape that cannot be read is said, not left out (Codex U on #4321)");
  // One whose record names another store, and one that is not JSON: both kept on the list, neither readable as its import.
  const elsewhere = "c3".repeat(12), garbled = "d4".repeat(12);
  redis.run(["SET", `nl:import:${elsewhere}`, JSON.stringify({ ...job, id: elsewhere, sid: `${sid}-other` }), "EX", 14 * 86_400]);
  redis.run(["SET", `nl:import:${garbled}`, "{not json", "EX", 14 * 86_400]);
  redis.run(["LPUSH", `nl:imports:list:${sid}`, elsewhere, garbled]);
  redis.run(["DEL", `nl:hooks:log:${statsId}`]);
  const unreadable = await copyPerson((await erasureScope(store, PERSON))!, Date.now());
  is("the copy says it is not complete, naming the imports", [unreadable.complete, unreadable.notComplete.some((line) => /import/i.test(line) && line.includes("could not be read"))], [false, true]);

  part("An unknown answer fails the copy rather than leave their no out");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: Command[]) => (commands.some((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:erased:")) ? commands.map(() => ({ unexpected: true })) : real(commands))) as typeof redis.pipeline;
  const odd = await outcome(copyPerson((await erasureScope(store, PERSON))!, Date.now()));
  redis.pipeline = real;
  is("copyPerson throws UnknownReplyError", odd, { threw: "UnknownReplyError" });
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
