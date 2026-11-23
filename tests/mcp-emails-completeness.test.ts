/**
 * Issue #4062 (Codex C2, MEDIUM): get_emails (lib/mcp-tools.ts, emailsTool) reads the newest EMAILS_BROADCASTS (30)
 * emails and answered them as `emails` with nothing saying older ones were left out, so an assistant could not tell
 * "this store sent exactly 30" from "these are the newest 30 of more", and could take the omitted ones for none.
 *
 * Now the same LRANGE asks for one id more (no command added): when that id is there, the answer still shows the newest
 * 30 and says `emails_more: true`; otherwise `emails_more: false`. The tool's description says so too. Synthetic only.
 */
import { emailsTool } from "@/lib/mcp-tools";
import { holdMoreApi, takeMoreApi } from "@/lib/api-guard";
import { EMAILS_BROADCASTS } from "@/lib/api-read-rules";
import { MCP_TOOLS } from "@/lib/mcp-catalog";
import type { Store } from "@/lib/store";
import { SMALL, emailKey, idsFor, makeStore, redis, writeEmails } from "./broadcasts-read-cost-world";
import { done, is, part } from "./check";

type Told = { emails?: unknown[]; emails_more?: unknown };
const read = async (store: Store) =>
  (await emailsTool(store, { charge: (more, taken) => takeMoreApi(store, more, taken), hold: (most) => holdMoreApi(store, most) })) as Told;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const store = await makeStore("mcp-emails-more@example.com", "mcpemailsmore");

  part("More emails than the tool shows: the newest are shown, and the answer says older ones exist");
  await writeEmails(store, idsFor(EMAILS_BROADCASTS + 1), () => SMALL);
  const more = await read(store);
  is(`the newest ${EMAILS_BROADCASTS} are shown`, more.emails?.length, EMAILS_BROADCASTS);
  is("and emails_more says older ones were left out", more.emails_more, true);

  part("The email past the newest has expired (Claude 6's LEVE on #5431): no older one can be shown, so emails_more is false");
  // The index is never trimmed and each record lives RECORD_DAYS from its last write: the id just older than the newest
  // shown is still listed after its record is gone. emails_more says only what that one id shows.
  const listed = idsFor(EMAILS_BROADCASTS + 1);
  await writeEmails(store, listed, () => SMALL);
  await redis.pipeline([["DEL", emailKey(listed[EMAILS_BROADCASTS])]]);
  const gone = await read(store);
  is(`the newest ${EMAILS_BROADCASTS} are shown`, gone.emails?.length, EMAILS_BROADCASTS);
  is("and emails_more is false: never a promise of older emails no page or tool can show", gone.emails_more, false);

  part("An older email kept past the expired one (Claude 6 hsz3's LEVE on #5431): false is not 'none left', and the tool says so");
  // A record's 400 days restart at every write (a send step, a cancel; a send scheduled up to a year ahead), so an email
  // listed before the expired one can still be kept. One id is looked at, never more: the answer says only that.
  const longer = idsFor(EMAILS_BROADCASTS + 2);
  await writeEmails(store, longer, () => SMALL);
  await redis.pipeline([["DEL", emailKey(longer[EMAILS_BROADCASTS])]]);
  const kept = await read(store);
  is("the 32nd is still kept, and emails_more is false: only the 31st was looked at", [kept.emails?.length, kept.emails_more], [EMAILS_BROADCASTS, false]);
  const told = MCP_TOOLS.find((t) => t.name === "get_emails")?.description ?? "";
  is("so the description never says false means none is left: false says the one just older is gone, not every older one", /not that every older one is/.test(told) && !/one older than that is gone/.test(told), true);
  is("and why: each email is kept 400 days after its last change", /400 days after its last change/.test(told), true);

  part("Exactly as many as the tool shows: nothing left out");
  await writeEmails(store, idsFor(EMAILS_BROADCASTS), () => SMALL);
  const all = await read(store);
  is(`all ${EMAILS_BROADCASTS} are shown`, all.emails?.length, EMAILS_BROADCASTS);
  is("emails_more is false", all.emails_more, false);

  part("No email at all");
  await writeEmails(store, [], () => SMALL);
  const none = await read(store);
  is("none shown, and emails_more is false", [none.emails?.length, none.emails_more], [0, false]);

  part("The tool's description says the answer is the newest emails and what emails_more means");
  const described = MCP_TOOLS.find((t) => t.name === "get_emails")?.description ?? "";
  is("it names emails_more", /emails_more/.test(described), true);
  is("and says an email is kept 400 days after its last change", /400 days after its last change/.test(described), true);
  is(`it says the newest ${EMAILS_BROADCASTS}`, new RegExp(`newest ${EMAILS_BROADCASTS}`).test(described), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
