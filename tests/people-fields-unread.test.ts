/**
 * #5285 row #2901 (Codex X6's LOW 2 on #2901 @030413bc03, NOT FIXED): a person's page in the studio
 * (app/studio/people/page.tsx) read the store's fields and the person's answers uncaught, so a reply in an unknown
 * shape (CrmSchemaReadUnavailable, UnknownReplyError) took the whole page to the site's error page. Now the page reads
 * them through personFieldsForPage (lib/crm.ts), which answers null for an unknown read; the fields' section then
 * says they could not be read just now, as the company section beside it does, and shows no form. An unknown read is
 * never shown as no fields or no answers. Synthetic data, in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { personFieldsForPage, writeFields } from "@/lib/crm";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "people-fields-unread-stats";
const PERSON = "a".repeat(32);
const FIELDS_KEY = `nl:crm:fields:${STATS}`;

let garble: ((command: (string | number)[]) => unknown) | undefined;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await real(commands);
  if (!garble) return replies;
  return replies.map((reply, i) => {
    const swapped = garble!(commands[i]);
    return swapped === undefined ? reply : swapped;
  });
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const fields = await writeFields(STATS, [{ id: "lvl001", name: "Level", type: "text", options: [] }]);
  await real([["HSET", `nl:crm:v:${STATS}:lvl001`, PERSON, "Pro"]]);

  part("Read in its shape, the fields and the answers are as saved");
  const read = await personFieldsForPage(STATS, PERSON);
  is("the store's one field", read?.fields.map((field) => field.id), fields.map((field) => field.id));
  is("and this person's answer", read?.values, { lvl001: "Pro" });
  is("a person not given reads the fields alone, with no answers", (await personFieldsForPage(STATS, ""))?.values, {});

  part("An unknown read is null, never no fields nor no answers");
  for (const shape of [7, ["x"], { a: 1 }, "not json"]) {
    garble = (command) => (command[0] === "GET" && command[1] === FIELDS_KEY ? shape : undefined);
    is(`the fields answered ${JSON.stringify(shape)}: unknown`, await personFieldsForPage(STATS, PERSON), null);
  }
  for (const shape of [7, ["x"], { a: 1 }]) {
    garble = (command) => (command[0] === "HGET" && String(command[1]).startsWith(`nl:crm:v:${STATS}:`) ? shape : undefined);
    is(`an answer read as ${JSON.stringify(shape)}: unknown`, await personFieldsForPage(STATS, PERSON), null);
  }
  garble = undefined;
  is("read again in its shape, as before", (await personFieldsForPage(STATS, PERSON))?.values, { lvl001: "Pro" });

  part("The person's page says so in the fields' section, and no longer falls to the error page");
  const page = readFileSync("app/studio/people/page.tsx", "utf8");
  is("it reads them only through personFieldsForPage", page.includes("await personFieldsForPage(store.statsId, profile.person") && !/await read(Fields|Values)\(/.test(page), true);
  is("an unknown read is said in a status, in plain words, with what to do", page.includes('role="status">Your fields could not be read just now. Open this page again in a moment.</p>'), true);
  is("and no form is drawn over fields that are not known", page.includes("{fields === null ? (") && page.includes(") : profile.person && fields.length ? ("), true);
  done();
}

void main();
