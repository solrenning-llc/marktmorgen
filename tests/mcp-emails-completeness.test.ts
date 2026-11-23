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
import { SMALL, idsFor, makeStore, redis, writeEmails } from "./broadcasts-read-cost-world";
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
  is(`it says the newest ${EMAILS_BROADCASTS}`, new RegExp(`newest ${EMAILS_BROADCASTS}`).test(described), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
