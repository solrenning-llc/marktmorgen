/**
 * 487 [IT4], item 5 (no empty screen without a ready example), the waitlist: "Start the note from an example".
 *
 * The audit (docs/ease-patterns-audit.md, Pattern 5) found that the waitlist had a sentence and a button but no
 * ready example. The note in the email that tells the waitlist it is on sale can now start from an example
 * (lib/waitlist-note.ts) that sets out what someone who waited looks for, every part the creator writes in
 * [brackets]. It holds nothing but those prompts: no figure, no price (the email carries the price itself), no
 * urgency, no scarcity and no claim, so no word of it stays once the creator has written theirs.
 *
 * That email goes to everyone confirmed, once, and the list is spent, so it never goes out with one of those
 * prompts left: the panel says so before its review, and launch (lib/waitlist.ts, which the route answers with)
 * refuses it before anything is put on sale, queued or sent. Only the exact prompts are looked for, so the
 * creator's own brackets are never taken for one.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmSpot, isSoon, joinWaitlist, launch, setSoon, waitlistViews } from "@/lib/waitlist";
import { MAX_LAUNCH_NOTE } from "@/lib/waitlist-rules";
import { WAITLIST_NOTE, WAITLIST_NOTE_LEFT, WAITLIST_NOTE_PROMPTS, waitlistPromptsLeft } from "@/lib/waitlist-note";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { to: string[]; subject: string; text: string };
const single: Sent[] = [];
const batches: Sent[][] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
    const batch = JSON.parse(String(init?.body)) as Sent[];
    batches.push(batch);
    return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
  }
  if (url.hostname === "api.resend.com") {
    single.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  part("The example");
  const lines = WAITLIST_NOTE.split("\n");
  is("holds only prompts in [brackets] and blank lines", lines.every((line) => line === "" || /^\[[^\]\n]+\]$/.test(line)), true);
  is("three prompts or more, each once", [WAITLIST_NOTE_PROMPTS.length >= 3, new Set(WAITLIST_NOTE_PROMPTS).size === WAITLIST_NOTE_PROMPTS.length], [true, true]);
  is("no figure, no price, no quotation", /\d|\$|“|"/.test(WAITLIST_NOTE), false);
  is("no urgency or scarcity", /\b(hurry|now|today|only|last|limited|left|soon|quick|fast)\b/i.test(WAITLIST_NOTE.replace(/\[|\]/g, "")), false);
  is("fits the note", WAITLIST_NOTE.length <= MAX_LAUNCH_NOTE, true);
  is("starts with thanks for waiting", /thank/i.test(WAITLIST_NOTE_PROMPTS[0] ?? "") && /waiting/.test(WAITLIST_NOTE_PROMPTS[0] ?? ""), true);

  part("A prompt left is found");
  is("none in the creator's own words", waitlistPromptsLeft("Thank you for waiting.\n[Updated] the recipes are in."), []);
  is("all of them, in the order they appear", waitlistPromptsLeft(WAITLIST_NOTE), WAITLIST_NOTE_PROMPTS);
  const one = WAITLIST_NOTE_PROMPTS[1] ?? "";
  is("one left among the creator's words", waitlistPromptsLeft(`Thank you for waiting.\n\n${one}`), [one]);
  is("a prompt edited inside its brackets is no longer one", waitlistPromptsLeft(WAITLIST_NOTE.replace(one, "[Thirty bread recipes]")).includes(one), false);
  is("not a string: none", waitlistPromptsLeft(undefined), []);
  is("what the panel says names the brackets, and that the email goes to everyone at once", /\[brackets\]/.test(WAITLIST_NOTE_LEFT) && /everyone on the waitlist at once/.test(WAITLIST_NOTE_LEFT), true);

  part("Never put on sale and sent with one left");
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  const made = await addProduct("owner@example.com", "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  await setSoon(store, product.id, true);
  is("Dana joins", await joinWaitlist({ store, product, email: "dana@example.com", consent: false, ip: "1.1.1.1", origin: "https://marktmorgen.com" }), "sent");
  await confirmSpot(single[0]?.text.match(/token=([0-9a-f]{48})/)?.[1] ?? "", store);
  is("confirmed", (await waitlistViews(store, [product.id]))[product.id]?.confirmed, 1);
  const address = "1 Main St, Portland, OR 97201";
  const refused = await launch(store, product, { note: WAITLIST_NOTE, address });
  is("the example still in the note: refused", refused, { ok: false, reason: "outline_left" });
  const left = await launch(store, product, { note: `Thank you for waiting.\n\n${one}`, address });
  is("one prompt left: refused", left, { ok: false, reason: "outline_left" });
  is("still coming soon, nothing queued or sent", [await isSoon(store, product.id), (await waitlistViews(store, [product.id]))[product.id]?.launch ?? null, batches.length], [true, null, 0]);
  const fine = await launch(store, product, { note: "Thank you for waiting. [Updated] every recipe is in.", address });
  is("the creator's own words, brackets of their own included: on sale, for the one confirmed", fine.ok && fine.total, 1);

  part("The panel and the route");
  const panel = readFileSync("components/waitlist-panel.tsx", "utf8");
  is("offers the example under the note, explained by its help", [panel.includes("Start the note from an example"), panel.includes("aria-describedby={`waitlist-${productId}-example-help`}"), panel.includes("id={`waitlist-${productId}-example-help`}")], [true, true, true]);
  is("only into an empty note: nothing typed is replaced", /if \(note\.trim\(\)\) return;\s*setNote\(WAITLIST_NOTE\);/.test(panel), true);
  is("once the note has words, a sentence instead of a button that does nothing", panel.includes("The example goes only into an empty note. Clear the note to use it."), true);
  is("the focus goes to the note, the first part selected", panel.includes('field.setSelectionRange(start, WAITLIST_NOTE.indexOf("]", start) + 1);'), true);
  is("the note has a visible label tied to it", panel.includes("htmlFor={`waitlist-${productId}-note`}"), true);
  const press = panel.slice(panel.indexOf("if (!confirming) {") - 200, panel.indexOf('await act({ action: "launch", note, address });'));
  is("refused before the review opens, so it is never offered to send", press.includes("waitlistPromptsLeft(note).length") && press.indexOf("waitlistPromptsLeft(note).length") < press.indexOf("setConfirming(true);"), true);
  is("the route's refusal has its words", panel.includes("outline_left: WAITLIST_NOTE_LEFT,"), true);
  const route = readFileSync("app/api/store/waitlist/route.ts", "utf8");
  is("the route answers launch's own reason", route.includes("const result = await launch(store, product, { note: body.note, address: body.address });") && route.includes("return Response.json({ ok: false, error: result.reason }, { status: 400 });"), true);
  const lib = readFileSync("lib/waitlist.ts", "utf8");
  const body = lib.slice(lib.indexOf("export async function launch("), lib.indexOf("async function launchTarget("));
  is("launch refuses it before it writes anything", body.indexOf('reason: "outline_left"') > -1 && body.indexOf('reason: "outline_left"') < body.indexOf('["SREM", soonKey(sid), product.id]'), true);

  done();
}

void main();
