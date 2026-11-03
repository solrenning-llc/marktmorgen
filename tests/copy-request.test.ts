/**
 * 619 [SZ3]: the door to a copy of one's own data (lib/copy-request.ts).
 * The link is emailed only to an address a store knows, and the page says
 * the same either way; the email is the company's. A copy is made only when
 * the company's data_copy exposure is reserved, and then kept: asked again,
 * the same copy is given. Without the reservation it is never refused: it
 * waits with the day it is due, a month at the most. JSON and a spreadsheet.
 */
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { importContactRows } from "@/lib/contacts";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { COPY_DOOR_OPEN, copyFor, forgetCopiesPerson, queuedCopies, readCopyLink, requestCopyLink } from "@/lib/copy-request";
import { COPY_COMPLETE } from "@/lib/person-copy";
import { CURRENT_EXPOSURE_BUDGET_POLICY } from "@/lib/exposure-budget-policy";
import { POST as copyRoute } from "@/app/api/privacy/copy/route";
import { COPY_DUE_DAYS, copyCsv, copyDueDay, copyJson } from "@/lib/copy-request-rules";
import { EXPOSURE_SCOPES } from "@/lib/funded-exposure-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "copydoor@example.com";
const PERSON = "ivy@example.com";
const sent: { to: string; subject: string; text: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const m = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text?: string };
    sent.push({ to: [m.to].flat()[0], subject: m.subject, text: m.text ?? "" });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  if (url.hostname.endsWith("stripe.com")) return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return realFetch(input as string, init);
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_copy_request_only_a_stand_in";
  redis.clear();
  await claimHandle(OWNER, "doorshop", "Door Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  await importContactRows(store.listId!, [{ email: PERSON, name: "Ivy", tags: [], consent: "agreed" }], store);

  part("Closed until the company's exposure for copies is approved (inbox C3-12)");
  is("open only with every module copied and an approved exposure policy", COPY_DOOR_OPEN, COPY_COMPLETE && CURRENT_EXPOSURE_BUDGET_POLICY !== null);
  is("today: no approved policy, so the door is closed", [CURRENT_EXPOSURE_BUDGET_POLICY, COPY_DOOR_OPEN], [null, false]);
  const asked0 = await copyRoute(new NextRequest("https://marktmorgen.com/api/privacy/copy", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: "ask", email: "ivy@example.com" }) }));
  is("the route says not found while it is closed", asked0.status, 404);
  const page = readFileSync("app/privacy/copy/page.tsx", "utf8");
  is("and so does the page", page.includes("if (!COPY_DOOR_OPEN) notFound();"), true);
  is("the privacy policy does not point to it yet", readFileSync("app/privacy/page.tsx", "utf8").includes("/privacy/copy"), false);

  part("The link");
  is("data copies are a funded exposure of the company", EXPOSURE_SCOPES.includes("data_copy"), true);
  is("an address no store knows: the same answer, nothing sent", [await requestCopyLink({ email: "nobody@example.com", ip: "203.0.113.1", origin: "https://marktmorgen.com", handle: "doorshop" }), sent.length], ["sent", 0]);
  is("not an address", await requestCopyLink({ email: "nope", ip: "203.0.113.1", origin: "https://marktmorgen.com" }), "email");
  is("an address the store knows: a link is emailed to it", [await requestCopyLink({ email: PERSON, ip: "203.0.113.1", origin: "https://marktmorgen.com", handle: "doorshop" }), sent.length, sent[0]?.to], ["sent", 1, PERSON]);
  const token = /\/privacy\/copy\?token=([0-9a-f]{64})/.exec(sent[0]?.text ?? "")?.[1] ?? "";
  const link = await readCopyLink(token);
  is("the link names the address and its store", [link?.email, link?.stores.map((s) => s.handle)], [PERSON, ["doorshop"]]);
  is("a made-up link is nothing", await readCopyLink("f".repeat(64)), null);

  part("Without the company's exposure: it waits, never refused");
  const asked = Date.UTC(2026, 10, 3, 12);
  const waiting = await copyFor(token, store.sid, asked, async () => false);
  is("queued, with the day it is due", waiting, { state: "queued", due: copyDueDay(asked) });
  is("due within the month the law gives", copyDueDay(asked), new Date(asked + COPY_DUE_DAYS * 86_400_000).toISOString().slice(0, 10));
  const later = await copyFor(token, store.sid, asked + 5 * 86_400_000, async () => false);
  is("asked again: still the first day it was asked from", later, waiting);
  is("one place in the queue", (await queuedCopies()).length, 1);

  part("With it: made once, then the same copy");
  let reserved = 0;
  const made = await copyFor(token, store.sid, asked + 6 * 86_400_000, async () => (reserved++, true));
  is("made, from the reserved exposure", [made.state, reserved, made.state === "ready" ? made.again : null], ["ready", 1, false]);
  is("and out of the queue", (await queuedCopies()).length, 0);
  const again = await copyFor(token, store.sid, asked + 7 * 86_400_000, async () => (reserved++, true));
  is("asked again: the copy already made, no new reservation", [again.state, again.state === "ready" ? again.again : null, reserved], ["ready", true, 1]);
  if (made.state !== "ready") throw new Error("no copy");
  is("it is their place on the list", made.copy.sections.some((s) => s.module === "lib/contacts.ts"), true);
  is("a store that is not on the link: nothing", (await copyFor(token, "0".repeat(32), asked)).state, "gone");

  part("Deleted with the person");
  is("the made copy goes with the erasure", await forgetCopiesPerson(store.sid, PERSON) > 0, true);
  let remade = 0;
  is("asked after: a new copy, from a new reservation", [(await copyFor(token, store.sid, asked + 8 * 86_400_000, async () => (remade++, true))).state, remade], ["ready", 1]);

  part("As JSON and as a spreadsheet");
  is("JSON reads back to the same copy", JSON.parse(copyJson(made.copy)), made.copy);
  const csv = copyCsv(made.copy);
  is("a spreadsheet: a header, then a row for each record", [csv.split("\r\n")[0], csv.includes(PERSON)], ['"Store","What it is","Record"', true]);
  is("never a formula", copyCsv({ ...made.copy, marks: ["=HYPERLINK(1)"] }).includes(`"'=HYPERLINK(1)"`), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
