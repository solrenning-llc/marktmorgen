/**
 * When the studio refuses a page read (for example 429 studio_used: the
 * month's requests are used up), the page editor shows the server's own
 * sentence, not the general "could not be read just now", for the earlier
 * versions, one version brought back and a page copied from another product.
 */
import { readFileSync } from "node:fs";
import { serverNote } from "@/lib/server-note";
import { done, is, part } from "./check";

const FALLBACK = "That page could not be read just now. Try again in a moment.";
const USED = "Your studio has no requests left this month for this. Try again next month, or change your plan.";

part("The server's sentence first");
is("429 studio_used with a message: the message", serverNote({ ok: false, error: "studio_used", message: USED }, FALLBACK), USED);
is("surrounding spaces trimmed", serverNote({ ok: false, message: `  ${USED}  ` }, FALLBACK), USED);

part("The general sentence otherwise");
is("no message", serverNote({ ok: false, error: "page_unread" }, FALLBACK), FALLBACK);
is("an empty message", serverNote({ ok: false, message: "   " }, FALLBACK), FALLBACK);
is("a message that is not text", serverNote({ ok: false, message: 429 }, FALLBACK), FALLBACK);
is("no reply at all", serverNote(null, FALLBACK), FALLBACK);
is("a reply that is not an object", serverNote("busy", FALLBACK), FALLBACK);

part("Every page read refusal in the editor uses it");
const editor = readFileSync("components/page-editor.tsx", "utf8");
is("the earlier versions", editor.includes('serverNote(refused, "The earlier versions could not be read just now. Try again in a moment.")'), true);
is("one version brought back", editor.includes('serverNote(refused, "That version could not be read just now. Try again in a moment.")'), true);
is("a page copied from another product", editor.includes('serverNote(data, "That page could not be read just now. Try again in a moment.")'), true);

done();
