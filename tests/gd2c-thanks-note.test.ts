/**
 * 568 [GD2] (c), the note after paying: it may not pose as Marktmorgen itself.
 *
 * A product's note after paying (lib/thanks-note.ts) is drawn on the thanks page and put in the confirmation email,
 * right after the buyer's card was used: "Marktmorgen Support: confirm your card to get your files", with a button
 * to a look-alike of marktmorgen.com, works best there. With the real route on the in-memory database and a real
 * session (app/api/store/thanks-note):
 *
 *   - a heading, text or button words that pose, or a button leading to an address that only looks like
 *     marktmorgen.com, are refused with "brand_imitation", the part, the passage, why (said of a note) and the fix;
 *     nothing is saved, so a note already there stays as it was;
 *   - plain notes, a button to the creator's own page or to marktmorgen.com, and the protective opposite are saved;
 *   - the note editor says it naming the part, with the note left as typed.
 *
 * Synthetic store and data only.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId } from "@/lib/store";
import { readThanksNote } from "@/lib/thanks-note-store";
import { IMITATION_FIX, imitationMessage, imitationWhy } from "@/lib/brand-imitation-rules";
import { POST as noteRoute } from "@/app/api/store/thanks-note/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ORIGIN = "https://marktmorgen.com";
const OWNER = "posing.note@example.com";
type Json = Record<string, unknown> & { ok?: boolean; error?: string; passage?: { field?: string; excerpt?: string; why?: string; fix?: string } };
const NOTE_WHY = imitationWhy("the note cannot be shown with it");

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "posingnote", "Posing Note", "");
  const statsId = (await ensureStatsId(OWNER))!.statsId!;
  await ensureStoreId(OWNER);
  const made = await addProduct(OWNER, "Supper Club Guide", "", "27", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", origin: ORIGIN, host: "marktmorgen.com", "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE}=${session}` };
  const save = async (note: Record<string, string>): Promise<Json & { status: number }> => {
    const response = await noteRoute(new NextRequest(`${ORIGIN}/api/store/thanks-note`, { method: "POST", headers, body: JSON.stringify({ id, note }) }));
    return { status: response.status, ...((await response.json().catch(() => ({}))) as Json) };
  };
  const stored = async () => (await readThanksNote(statsId, id))?.heading ?? null;

  part("A plain note is saved");
  const plain = await save({ heading: "Welcome", body: "Start with chapter one. Your files are sold on Marktmorgen, like the rest of the store.", label: "Join the group", url: "https://discord.gg/supper" });
  is("saved", [plain.status, plain.ok, await stored()], [200, true, "Welcome"]);
  const ours = await save({ heading: "Welcome", body: "Your library is linked below.", label: "My store", url: "https://marktmorgen.com/@posingnote" });
  is("a button to marktmorgen.com itself is saved", ours.status, 200);

  part("A note that poses is refused, and the note there stays");
  const heading = await save({ heading: "Marktmorgen Support", body: "Confirm your card below to get your files." });
  is("a heading speaking as Marktmorgen's staff: the part, the passage, why for a note and the fix", [heading.status, heading.error, heading.passage?.field, heading.passage?.excerpt, heading.passage?.why, heading.passage?.fix], [409, "brand_imitation", "heading", "Marktmorgen Support", NOTE_WHY, IMITATION_FIX]);
  const body = await save({ heading: "Thanks", body: "Your Marktmorgen account is locked. Verify your card to unlock the guide." });
  is("its account in trouble, in the text", [body.status, body.error, body.passage?.field], [409, "brand_imitation", "body"]);
  const label = await save({ heading: "Thanks", body: "Your guide is ready.", label: "Enter your Marktmorgen password", url: "https://example.com/start" });
  is("the button's words", [label.status, label.error, label.passage?.field], [409, "brand_imitation", "button"]);
  const link = await save({ heading: "Thanks", body: "Your guide is ready.", label: "Open my guide", url: "https://marktmorgen-login.com/files" });
  is("a button to a look-alike address", [link.status, link.error, link.passage?.field, link.passage?.excerpt], [409, "brand_imitation", "link", "https://marktmorgen-login.com/files"]);
  is("nothing was saved by any of them", [await stored(), (await readThanksNote(statsId, id))?.button?.url], ["Welcome", "https://marktmorgen.com/@posingnote"]);

  part("The protective opposite passes");
  const opposite = await save({ heading: "A note on safety", body: "Marktmorgen will never ask for your password or your card after you pay." });
  is("saved", [opposite.status, await stored()], [200, "A note on safety"]);

  part("The note editor says it");
  is("the sentence", imitationMessage(heading.passage, "the note's heading", "Your note was not saved"), `Your note was not saved. In the note's heading: “Marktmorgen Support”. ${NOTE_WHY} ${IMITATION_FIX} Nothing you wrote was changed.`);
  const editor = readFileSync("components/thanks-note-editor.tsx", "utf8");
  is("the editor names each part and uses it before its other refusals", [
    editor.includes(`const NOTE_PARTS: Record<string, string> = { heading: "the note's heading", body: "the note's text", button: "the button's words", link: "the button's link" };`),
    /if \(problem === "brand_imitation"\) \{[\s\S]{0,260}setError\(imitationMessage\(data\?\.passage, NOTE_PARTS\[field\] \?\? "the note", "Your note was not saved"\)\);\n\s+return;\n\s+\}\n\s+setError\(typeof problem === "string"/.test(editor),
  ], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
