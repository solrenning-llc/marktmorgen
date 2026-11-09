/**
 * A store's own fields and its deals (lib/crm-rules.ts, added 13 October
 * 2026). What is checked:
 *
 *   - fields are read safely: named once each, a choice with two options;
 *   - a value is kept only as the field keeps it: a number, a real date, one
 *     of the choices; "" clears it;
 *   - stages need one open, one won and one lost;
 *   - a deal is read safely and the board adds each stage up;
 *   - through the route: a deal is made, moved and removed; a field's answer
 *     is kept and written into the list's file; a field taken away takes its
 *     answers; a stage taken away moves its deals to the first open one;
 *   - somebody signed out is refused.
 */
import { NextRequest } from "next/server";
import { DEFAULT_STAGES, boardTotals, fieldValue, newCrmId, parseDeal, parseFields, parseStages } from "@/lib/crm-rules";
import { readDeals, readFields, readValues, valuesOf } from "@/lib/crm";
import { personKey } from "@/lib/person-key";
import { listAsCsv } from "@/lib/free";
import { plainRead, upsertContact } from "@/lib/contacts";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST } from "@/app/api/store/crm/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("Fields, read safely");
  const fields = parseFields([
    { id: "compny", name: " Company ", type: "text" },
    { id: "dupe01", name: "company", type: "text" },
    { id: "offer1", name: "Offer", type: "choice", options: ["Coaching", "Course", "Coaching", ""] },
    { id: "lonely", name: "Lonely", type: "choice", options: ["Only one"] },
    { id: "BADID!", name: "Bad id", type: "text" },
    { id: "callon", name: "First call", type: "date" },
    { id: "seats1", name: "Seats", type: "number" },
    { id: "weird1", name: "Weird", type: "colour" },
  ]);
  is("each named once, a choice with two options, known kinds only", fields.map((f) => [f.id, f.name, f.options]), [
    ["compny", "Company", []],
    ["offer1", "Offer", ["Coaching", "Course"]],
    ["callon", "First call", []],
    ["seats1", "Seats", []],
  ]);

  part("A value, kept as the field keeps it");
  const [company, offer, call, seats] = fields;
  is("text, trimmed to one line", fieldValue(company, "  Acme\nInc  "), "Acme Inc");
  is("a number, or nothing", [fieldValue(seats, "1,200"), fieldValue(seats, "many")], ["1200", null]);
  is("a real date, or nothing", [fieldValue(call, "2026-10-13"), fieldValue(call, "13/10/2026"), fieldValue(call, "2026-13-45")], ["2026-10-13", null, null]);
  is("one of the choices, or nothing", [fieldValue(offer, "Course"), fieldValue(offer, "Webinar")], ["Course", null]);
  is("empty clears", fieldValue(seats, "   "), "");

  part("Stages");
  is("the default ones are valid", parseStages(DEFAULT_STAGES)?.length, 5);
  is("without a lost stage, refused", parseStages(DEFAULT_STAGES.filter((s) => s.kind !== "lost")), null);

  part("A deal, and the board");
  const deal = parseDeal({ id: "abcdefghij", title: "Coaching\tpackage", email: "Dana@Example.com", cents: 150_000.4, stage: "talk00", note: "Line one\r\nLine two" }, DEFAULT_STAGES);
  is("read safely", [deal?.title, deal?.email, deal?.cents, deal?.note], ["Coaching package", "dana@example.com", 150_000, "Line one\nLine two"]);
  is("no stage the store has, no deal", parseDeal({ id: "abcdefghij", title: "x", stage: "gone00" }, DEFAULT_STAGES), null);
  is("a negative value is none", parseDeal({ id: "abcdefghij", title: "x", stage: "lead00", cents: -5 }, DEFAULT_STAGES)?.cents, 0);
  is(
    "each stage added up",
    boardTotals(DEFAULT_STAGES, [deal!, { ...deal!, id: "bbbbbbbbbb", cents: 50_000 }]).map((t) => [t.stage.id, t.count, t.cents]),
    [
      ["lead00", 0, 0],
      ["talk00", 2, 200_000],
      ["offr00", 0, 0],
      ["won000", 0, 0],
      ["lost00", 0, 0],
    ],
  );
  is("ids of the right length", [newCrmId().length, newCrmId(10).length], [6, 10]);

  part("Through the route");
  const OWNER = "crm@example.com";
  await claimHandle(OWNER, "crmshop", "CRM Shop", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const call_ = async (body: Record<string, unknown>, signedIn = true) =>
    (
      await POST(
        new NextRequest("https://marktmorgen.com/api/store/crm", {
          method: "POST",
          headers: { "content-type": "application/json", ...(signedIn ? { cookie: `${SESSION_COOKIE}=${session}` } : {}) },
          body: JSON.stringify(body),
        }),
      )
    ).json();
  is("signed out, refused", (await call_({ action: "deal", deal: { title: "x", stage: "lead00" } }, false)).ok, false);

  const made = await call_({ action: "deal", deal: { title: "Six sessions", email: "dana@example.com", cents: 90000, stage: "lead00", note: "" } });
  is("a deal made, with an id of its own", [made.ok, typeof made.deal?.id, made.deal?.id?.length], [true, "string", 10]);
  const store = (await storeForEmail(OWNER))!;
  const id = made.deal.id as string;
  const moved = await call_({ action: "deal", version: made.version, deal: { ...made.deal, stage: "won000" } });
  is("moved on", [moved.ok, (await readDeals(store.statsId, DEFAULT_STAGES))[0]?.stage], [true, "won000"]);
  is("no title, refused", (await call_({ action: "deal", deal: { title: " ", stage: "lead00" } })).error, "title");
  is("an id that is not one of theirs, refused", (await call_({ action: "deal", deal: { id: "zzzzzzzzzz", title: "x", stage: "lead00" } })).error, "unknown");

  const otherOpen = { id: "pitch0", name: "Pitch", kind: "open" };
  const stagesNow = [otherOpen, { id: "done00", name: "Signed", kind: "won" }, { id: "nope00", name: "No", kind: "lost" }];
  is("stages without a won one, refused", (await call_({ action: "stages", stages: stagesNow.filter((s) => s.kind !== "won") })).error, "stages");
  is("stages saved", (await call_({ action: "stages", stages: stagesNow })).ok, true);
  is("a deal in a stage that is gone moves to the first open one", (await readDeals(store.statsId, stagesNow as never))[0]?.stage, "pitch0");

  is("fields saved", (await call_({ action: "fields", fields: fields.map((f) => ({ ...f })) })).ok, true);
  is("a field sent twice by name, refused", (await call_({ action: "fields", fields: [{ id: "aaaaaa", name: "A", type: "text" }, { id: "bbbbbb", name: "a", type: "text" }] })).error, "fields");
  const person = personKey(store.statsId!, "dana@example.com");
  is("an answer kept", (await call_({ action: "value", person, field: "offer1", value: "Coaching" })).ok, true);
  is("an answer the field does not keep, refused", (await call_({ action: "value", person, field: "seats1", value: "lots" })).ok, false);
  is("an unknown field, refused", (await call_({ action: "value", person, field: "nope00", value: "x" })).error, "unknown");
  is("read back for the person", await readValues(store.statsId, person, await readFields(store.statsId)), { offer1: "Coaching" });

  await upsertContact(store.listId!, "dana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const csv = (await listAsCsv(store, false)).split("\r\n");
  is("the list's file has a column per field", csv[0].endsWith(',"Company","Offer","First call","Seats"'), true);
  is("and the person's answer in it", csv[1].endsWith(',"","Coaching","",""'), true);

  await call_({ action: "fields", fields: fields.filter((f) => f.id !== "offer1") });
  is("a field taken away takes its answers", (await valuesOf(store.statsId!, [{ id: "offer1", name: "Offer", type: "choice", options: [] }], [person], plainRead)).offer1, [null]);

  is("removed", (await call_({ action: "undeal", id })).ok, true);
  is("removed twice, unknown", (await call_({ action: "undeal", id })).error, "unknown");

  done();
}

void main();
