/**
 * The two LOWs of the review at 15974dfb92 on #3559 (import column suggestions):
 * 1. a model answer wrapped in one code fence was set aside as unreadable after its writing job was already counted;
 * 2. the browser checked only the first MAX_COLUMNS names but POSTed the whole first row, so a wide header was refused
 *    (413 or invalid) and cells past MAX_COLUMNS reached our server although the model never sees them.
 * Pure functions only; no model, no network.
 */
import { MAX_COLUMNS, askBody, readMapAnswer } from "@/lib/csv-map-ai-rules";
import { done, is, part } from "./check";

const GOOD = '{"email":0,"name":1,"tags":null,"consent":2}';
const WANT = { email: 0, name: 1, tags: -1, consent: 2 };

part("An answer in one code fence is read; the exact-shape check still holds");
is("bare", readMapAnswer("contacts", 3, GOOD), WANT);
is("```json fence", readMapAnswer("contacts", 3, "```json\n" + GOOD + "\n```"), WANT);
is("``` fence, spaces around", readMapAnswer("contacts", 3, "  ```\n" + GOOD + "\n```  "), WANT);
is("a fence holding a wrong shape is still refused", readMapAnswer("contacts", 3, '```json\n{"email":0}\n```'), null);
is("text around a fence is still refused", readMapAnswer("contacts", 3, "Here it is:\n```json\n" + GOOD + "\n```"), null);
is("two fences are refused", readMapAnswer("contacts", 3, "```json\n" + GOOD + "\n```\n```json\n" + GOOD + "\n```"), null);
is("an unclosed fence is refused", readMapAnswer("contacts", 3, "```json\n" + GOOD), null);

part("Only the names the model can see leave the browser");
const wide = Array.from({ length: MAX_COLUMNS + 40 }, (_, i) => `Field ${i}`);
const body = askBody(wide, { email: 3, name: MAX_COLUMNS + 5, tags: -1, consent: MAX_COLUMNS - 1 });
is("the first MAX_COLUMNS names, no more", [body.header.length, body.header[0], body.header[MAX_COLUMNS - 1]], [MAX_COLUMNS, "Field 0", `Field ${MAX_COLUMNS - 1}`]);
is("a choice past them is sent as open, the rest unchanged", body.guess, { email: 3, name: -1, tags: -1, consent: MAX_COLUMNS - 1 });
is("a narrow header is sent whole", askBody(["Email", "Name"], { email: 0 }), { header: ["Email", "Name"], guess: { email: 0 } });

done();
