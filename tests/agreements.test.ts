/**
 * Proposals and agreements with an electronic signature (HighLevel audit H28;
 * lib/agreement-rules.ts, lib/agreement-store.ts, lib/agreements.ts, the two
 * routes; added 18 October 2026).
 *
 * Checked, in the in-memory Redis with the email sender mocked:
 *
 *   - what the studio sends is held to every rule, and the exact text is
 *     built once, the same way every time, with its SHA-256 fingerprint;
 *   - each record and each version takes its room in the store's data room
 *     before it is written, and the counts per person and per store hold;
 *   - a version's text is never changed: an edit is a new version that needs
 *     a new signature, the earlier signature stays recorded against the text
 *     it signed, and a text changed in storage is never shown or signed;
 *   - only the person it was sent to signs it: the address typed must be the
 *     one it went to, the version read must still be the latest, the consent
 *     box must be checked, the name must be a name, and a browser signed in
 *     to the store's studio is refused; it is signed once;
 *   - the record keeps the exact text, the fingerprint, the name, the time,
 *     the version and only an HMAC of the internet address, never the address;
 *   - both sides get the signed copy, with the text and an HTML file, each
 *     one of the store's emails for the month, and none when those are used;
 *   - withdrawing, deleting and deleting the person do what they say;
 *   - nothing says "legally binding", "court-admissible" or that anything
 *     complies with a law, and the privacy policy and terms say what is kept;
 *   - and the store commands each action sends, measured.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { CONSENT_VERSION, DRAFT_PROBLEMS, MAX_PER_PERSON, MAX_SENDS, MAX_VERSIONS, SIGN_DAYS, type AgreementDraft, agreementText, canRevise, readDraft, readSignedName, statusOf } from "@/lib/agreement-rules";
import {
  agreementOf,
  createAgreement,
  deleteAgreement,
  fingerprint,
  forgetAgreementsPerson,
  listAgreements,
  readAgreement,
  readVersion,
  recordRoomBytes,
  reviseAgreement,
  signAgreement,
  versionRoomBytes,
  withdrawAgreement,
} from "@/lib/agreement-store";
import { sendAgreementEmail, sendSignedCopies, signedCopyHtml } from "@/lib/agreements";
import { AGREEMENT_WORDS, agreementWords } from "@/lib/buyer-words/agreements";
import { allowanceUsed } from "@/lib/store-allowance";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { allowanceWindow } from "@/lib/allowance-window";
import { dataUsed } from "@/lib/store-data";
import { PERSON_DATA } from "@/lib/person-data";
import { ERASERS } from "@/lib/person-erasure";
import { POST as signRoute } from "@/app/api/store/agreement-sign/route";
import { POST as studioRoute } from "@/app/api/store/agreements/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

type Mail = { to: string; subject: string; text: string; attachments?: { filename: string; content: string }[] };
const mails: Mail[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; attachments?: { filename: string; content: string }[] };
    mails.push({ to: body.to[0], subject: body.subject, text: body.text, attachments: body.attachments });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

// Every command the code sends to the store, counted.
let commands = 0;
const pipeline = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof pipeline }).pipeline = (cmds) => {
  commands += cmds.length;
  return pipeline(cmds);
};
const measured: Record<string, number> = {};
async function measure<T>(what: string, run: () => Promise<T>): Promise<T> {
  const before = commands;
  const out = await run();
  measured[what] = commands - before;
  return out;
}

const BODY = "Twelve weekly coaching calls of 45 minutes, starting 1 November.\n\nEither of us may end it with a week's notice.";
const draftBody = (over: Record<string, unknown> = {}) => ({ kind: "agreement", email: "Client@Example.com", name: "Dana Reyes", title: "Coaching, November to January", body: BODY, lines: [{ text: "Coaching, per month", quantity: 3, amount: "400" }], consent: true, ...over });

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Mara's Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Agr${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

const signForm = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  signRoute(new NextRequest("https://marktmorgen.com/api/store/agreement-sign", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.7", ...headers }, body: new URLSearchParams(fields) }));

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_agreements_only_a_stand_in";
  const now = Date.now();

  part("What the studio sends is held to the rules");
  const ok = readDraft(draftBody(), "usd");
  is("a plain agreement is read: the address lowered, the lines in cents, the total worked out", ok.ok ? [ok.draft.email, ok.draft.lines[0].cents, ok.draft.total, ok.draft.kind] : null, ["client@example.com", 40_000, 120_000, "agreement"]);
  const problem = (over: Record<string, unknown>) => {
    const r = readDraft(draftBody(over), "usd");
    return r.ok ? "ok" : r.problem;
  };
  is("refused: no kind, no address, no title, no text, a bad line, a bad amount, no word from the creator", [problem({ kind: "contract" }), problem({ email: "dana" }), problem({ title: " " }), problem({ body: "" }), problem({ lines: [{ text: "", quantity: 1, amount: "5" }] }), problem({ lines: [{ text: "x", quantity: 1, amount: "$5" }] }), problem({ consent: false })], ["kind", "email", "title", "body", "line", "amount", "consent"]);
  is("lines are optional: an agreement in words alone", problem({ lines: [] }), "ok");
  is("every problem has a sentence", Object.values(DRAFT_PROBLEMS).every((s) => s.length > 10), true);
  const words = agreementWords("en").text;
  const input = { kind: "agreement" as const, title: "T", body: "Terms.", lines: [{ text: "Work", quantity: 2, cents: 1_050 }], currency: "usd" as const, total: 2_100, n: 1, createdAt: Date.UTC(2026, 9, 18) };
  const text = agreementText(input, { store: "Mara's Coaching", name: "Dana", email: "d@example.com" }, words);
  is("the exact text: kind and title, from and to, version and date, the words, the lines and total written the same way everywhere", text, "Agreement: T\nFrom: Mara's Coaching\nTo: Dana <d@example.com>\nVersion 1, written 2026-10-18\n\nTerms.\n\nItems:\n- Work × 2: 21.00 USD\nTotal: 21.00 USD");
  is("built the same every time, so its fingerprint is the same", [agreementText(input, { store: "Mara's Coaching", name: "Dana", email: "d@example.com" }, words) === text, fingerprint(text).length], [true, 64]);
  is("a signer's name must be a name", [readSignedName("  Dana   Reyes "), readSignedName("D"), readSignedName("12345"), readSignedName("<b>x</b>"), readSignedName("https://x.example")], ["Dana Reyes", null, null, null, null]);

  part("Kept within the store's data room and counts, before anything is sent");
  const owner = "agreements@example.com";
  const store = await paidStore(owner, "maracoach");
  const draft = (ok as { ok: true; draft: AgreementDraft }).draft;
  const roomBefore = (await dataUsed(store))!.used;
  const created = await measure("create (record, first version, counts, data room)", () => createAgreement(store, draft, now));
  if (!created.ok) throw new Error(created.message);
  const a = created.agreement;
  const v1 = created.version;
  is("kept, waiting for a signature, its link open for the days said", [statusOf(a, now), a.expiresAt - now, a.versions.length], ["open", SIGN_DAYS * 86_400_000, 1]);
  is("its room in the data room was taken before it was written: the record with room for signatures, and the version", (await dataUsed(store))!.used - roomBefore >= recordRoomBytes(a) + versionRoomBytes(v1), true);
  is("the version's fingerprint is the SHA-256 of its exact text", [v1.sha256 === fingerprint(v1.text), a.versions[0].sha256 === v1.sha256, v1.text.includes("Total: 1200.00 USD")], [true, true, true]);
  is("found only under its own store", [(await agreementOf(store, a.id))?.id, await agreementOf({ sid: "another" }, a.id)], [a.id, null]);
  for (let i = 1; i < MAX_PER_PERSON; i += 1) await createAgreement(store, draft, now);
  const tooMany = await createAgreement(store, draft, now);
  is("one person keeps at most MAX_PER_PERSON agreements in a store, and a refused one leaves nothing", [tooMany.ok, tooMany.ok ? "" : tooMany.reason, (await listAgreements(store))!.length], [false, "person", MAX_PER_PERSON]);
  is("a store with no plan can't send one", (await createAgreement({ ...store, subscriptionActive: false, subscriptionId: null, planEndedAt: "" }, { ...draft, email: "x@example.com" }, now)).ok, false);

  part("The email: one of the store's emails for the month");
  const usedBefore = await allowanceUsed(store, "email", now);
  const sent = await measure("send the link (email meter and record)", () => sendAgreementEmail(store, a, v1, now));
  const mail = mails.at(-1)!;
  is("it goes, to the person, and takes one of the store's emails", [sent.sent, mail.to, (await allowanceUsed(store, "email", now)) - usedBefore], [true, "client@example.com", 1]);
  is("it says who sent it and links to the page", [mail.subject, mail.text.includes(`/@maracoach/sign/${a.id}`), mail.text.includes("nothing is signed unless you sign it")], ['Mara\'s Coaching: agreement to sign, "Coaching, November to January"', true, true]);

  part("The page's reads");
  const page = await measure("open the signing page (record and version)", async () => {
    const found = await agreementOf(store, a.id);
    return found ? readVersion(found, 1) : null;
  });
  is("the page reads the exact text back only while its fingerprint matches", page?.text, v1.text);

  part("Only the person it was sent to signs it, on the version they read");
  const fields = { handle: "maracoach", agreement: a.id, version: "1", sha256: v1.sha256, name: "Dana Reyes", email: "client@example.com", agree: "yes" };
  const where = async (over: Record<string, string>, headers: Record<string, string> = {}) => (await signForm({ ...fields, ...over }, headers)).headers.get("location");
  is("another address is refused", await where({ email: "someone@example.com" }), `https://marktmorgen.com/@maracoach/sign/${a.id}?notice=email`);
  is("an empty or made-up name is refused", [await where({ name: "D" }), await where({ name: "1234" })], [`https://marktmorgen.com/@maracoach/sign/${a.id}?notice=name`, `https://marktmorgen.com/@maracoach/sign/${a.id}?notice=name`]);
  is("without the box checked, nothing is signed", await where({ agree: "" }), `https://marktmorgen.com/@maracoach/sign/${a.id}?notice=consent`);
  is("a fingerprint that is not the version's is refused", await where({ sha256: "0".repeat(64) }), `https://marktmorgen.com/@maracoach/sign/${a.id}?notice=changed`);
  const session = await openSession(owner);
  is("a browser signed in to the store's studio can't sign for them", await where({}, { cookie: `${SESSION_COOKIE}=${session}` }), `https://marktmorgen.com/@maracoach/sign/${a.id}?notice=studio`);
  is("from another site, refused outright", (await signForm(fields, { origin: "https://evil.example", host: "marktmorgen.com" })).status, 403);
  is("still nothing signed", statusOf((await readAgreement(a.id))!, now), "open");

  part("A version's text never changes: an edit is a new version");
  const v2draft = readDraft({ title: "Coaching, November to February", body: `${BODY}\n\nFour months, not three.`, lines: [{ text: "Coaching, per month", quantity: 4, amount: "400" }] }, "usd", a);
  const revised = await measure("new version (lock, record, version, data room)", () => reviseAgreement(store, a.id, (v2draft as { ok: true; draft: AgreementDraft }).draft, now + 1_000));
  if (!revised.ok) throw new Error(revised.message);
  is("version 2, with its own fingerprint; the person stays the same", [revised.version.n, revised.version.sha256 !== v1.sha256, revised.agreement.email, revised.agreement.versions.length], [2, true, "client@example.com", 2]);
  is("version 1's text is as it was written", (await readVersion(revised.agreement, 1))?.text, v1.text);
  is("signing what was read before the edit is refused: the text changed", await where({}), `https://marktmorgen.com/@maracoach/sign/${a.id}?notice=changed`);

  part("Signed: the record");
  const ok2 = await signForm({ ...fields, version: "2", sha256: revised.version.sha256, name: "  Dana   Reyes ", email: "CLIENT@example.com" });
  is("the person it was sent to signs version 2 (the address in any case)", ok2.headers.get("location"), `https://marktmorgen.com/@maracoach/sign/${a.id}?notice=signed`);
  const signedA = (await readAgreement(a.id))!;
  const sig = signedA.versions[1].signature!;
  is("signed, with the name typed, the time, the version's fingerprint, and the sentence checked word for word", [statusOf(signedA, now), sig.name, sig.sha256, sig.consent, sig.consentVersion, typeof sig.at], ["signed", "Dana Reyes", revised.version.sha256, AGREEMENT_WORDS.en.consent, CONSENT_VERSION, "number"]);
  // Inspect every agreement value, including its non-string indexes.
  const raw = JSON.stringify([...redis.keys()].filter((k) => k.startsWith("nl:agree:")).map((key) => {
    switch (redis.run(["TYPE", key])) {
      case "string": return redis.run(["GET", key]);
      case "hash": return redis.run(["HGETALL", key]);
      case "set": return redis.run(["SMEMBERS", key]);
      case "zset": return redis.run(["ZRANGEBYSCORE", key, "-inf", "+inf"]);
      case "list": return redis.run(["LRANGE", key, 0, -1]);
      case "none": return null;
      default: throw new Error("Unrecognized synthetic agreement value type");
    }
  }));
  is("only a one-way code from the internet address: the address itself is kept nowhere", [sig.ipHash.length, raw.includes("203.0.113.7")], [64, false]);
  is("the address typed is not kept beside the signature", JSON.stringify(sig).includes("CLIENT@"), false);
  is("signed once: a second signature on it is refused", await where({ version: "2", sha256: revised.version.sha256 }), `https://marktmorgen.com/@maracoach/sign/${a.id}?notice=closed`);
  is("a signed agreement can't be withdrawn, and its signature stays", [await withdrawAgreement(store, a.id, now), statusOf((await readAgreement(a.id))!, now)], ["not_open", "signed"]);

  part("Both sides get the signed copy");
  const copies = mails.filter((m) => m.subject.startsWith("Signed copy"));
  is("one to the person, one to the creator", copies.map((m) => m.to).sort(), ["agreements@example.com", "client@example.com"]);
  const html = Buffer.from(copies[0].attachments![0].content, "base64").toString("utf8");
  is("each carries the exact text and the record, and an HTML file with the same", [copies[0].text.includes(revised.version.text), copies[0].text.includes(revised.version.sha256), html.includes("Four months, not three."), html.includes(revised.version.sha256), /<script/i.test(html)], [true, true, true, true, false]);
  is("the file escapes what was typed", signedCopyHtml(store, signedA, { ...revised.version, text: "<script>x</script>" }, sig).includes("&lt;script&gt;x&lt;/script&gt;"), true);
  // The store's emails for the month, used: the copies do not go, the signature stands.
  const window = allowanceWindow(store, now)!;
  const keys = [...redis.keys()].filter((k) => k.startsWith("nl:allow:email:") && k.endsWith(window.id));
  for (const k of keys) redis.run(["SET", k, String(STORE_ALLOWANCES.creator.email)]);
  const mailsBefore = mails.length;
  const none = await measure("signed copies with the month's emails used (meter refuses, record)", () => sendSignedCopies(store, signedA, revised.version, sig, now));
  is("with the store's emails used, no copy goes", [none, mails.length - mailsBefore], [{ signer: false, creator: false }, 0]);
  for (const k of keys) redis.run(["SET", k, "1"]);
  const second = (await listAgreements(store))!.find((x) => x.id !== a.id)!;
  const secondV = (await readVersion(second, 1))!;
  const signedSecond = await measure("sign through the route, with its two signed copies (rate limit, public request, studio check, lock, record, version read, two emails)", async () => {
    const r = await signForm({ ...fields, agreement: second.id, sha256: secondV.sha256 }, { "x-forwarded-for": "203.0.113.8" });
    return r.headers.get("location");
  });
  is("another signed through the route", signedSecond, `https://marktmorgen.com/@maracoach/sign/${second.id}?notice=signed`);
  const third = (await listAgreements(store))!.find((x) => statusOf(x, now) === "open")!;
  const thirdV = (await readVersion(third, 1))!;
  const direct = await signAgreement(store, third.id, { n: 1, sha256: thirdV.sha256, name: "Dana Reyes", email: "client@example.com", consent: true, ip: "198.51.100.4" }, "Dana Reyes", now);
  if (!direct.ok) throw new Error("not signed");
  await measure("signed copies (two emails through the meter, record)", () => sendSignedCopies(store, direct.agreement, direct.version, direct.signature, now));

  part("A version changed in storage is never shown or signed");
  const fourth = (await listAgreements(store))!.find((x) => statusOf(x, now) === "open")!;
  const key = `nl:agree:v:${fourth.id}:1`;
  const stored = JSON.parse(String(redis.run(["GET", key])));
  redis.run(["SET", key, JSON.stringify({ ...stored, text: `${stored.text} And a fee of $1,000.` })]);
  is("read back as nothing, and refused for signing", [await readVersion(fourth, 1), (await signAgreement(store, fourth.id, { n: 1, sha256: fourth.versions[0].sha256, name: "Dana Reyes", email: "client@example.com", consent: true, ip: "x" }, "Dana Reyes", now)).ok], [null, false]);

  part("New versions and emails are bounded");
  let open = (await listAgreements(store))!.find((x) => statusOf(x, now) === "open" && x.id !== fourth.id)!;
  for (let n = 2; n <= MAX_VERSIONS; n += 1) {
    const r = await reviseAgreement(store, open.id, { ...draft, title: `Version ${n}` }, now + n);
    if (r.ok) open = r.agreement;
  }
  is(`at most ${MAX_VERSIONS} versions`, [open.versions.length, canRevise(open).ok, (await reviseAgreement(store, open.id, draft, now + 99)).ok], [MAX_VERSIONS, false, false]);
  is(`at most ${MAX_SENDS} emails about one agreement`, (await sendAgreementEmail(store, { ...open, sent: Array.from({ length: MAX_SENDS }, () => now) }, (await readVersion(open, MAX_VERSIONS))!, now)).sent, false);

  part("Withdraw, delete, and deleting the person");
  is("one waiting can't be deleted before it is withdrawn", await deleteAgreement(store, open.id, now), "open");
  const withdrawn = await measure("withdraw (lock, record)", () => withdrawAgreement(store, open.id, now));
  is("withdrawn: its link takes no signature", [withdrawn && typeof withdrawn === "object" ? statusOf(withdrawn, now) : withdrawn, (await signAgreement(store, open.id, { n: MAX_VERSIONS, sha256: open.versions[MAX_VERSIONS - 1].sha256, name: "Dana Reyes", email: "client@example.com", consent: true, ip: "x" }, "Dana Reyes", now)).ok], ["withdrawn", false]);
  const deleted = await measure("delete (record, every version key, indexes)", () => deleteAgreement(store, open.id, now));
  is("then deleted, with every version's text", [deleted, await readAgreement(open.id), redis.run(["GET", `nl:agree:v:${open.id}:1`])], ["deleted", null, null]);
  await measure("list in the studio (index, records)", () => listAgreements(store));
  const left = (await listAgreements(store))!.length;
  const gone = await measure(`delete the person (${left} agreements)`, () => forgetAgreementsPerson(store.sid, "client@example.com"));
  is("deleting the person deletes every agreement of theirs, signed or not, with every version", [gone, await readAgreement(a.id), [...redis.keys()].filter((k) => k.startsWith("nl:agree:r:") || k.startsWith("nl:agree:v:")).length], [left, null, 0]);
  is("the person register and the erasure say so", [PERSON_DATA.some((d) => d.file === "lib/agreement-store.ts" && d.how === "erased"), ERASERS.some((e) => e.module === "lib/agreement-store.ts")], [true, true]);

  part("The studio's route");
  const call = async (body: Record<string, unknown>) => {
    const r = await studioRoute(new NextRequest("https://marktmorgen.com/api/store/agreements", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const made = await call({ action: "create", ...draftBody({ email: "brand@example.com" }) });
  is("create sends it", [made.status, made.body.ok, made.body.sent], [200, true, true]);
  const id = String(made.body.id);
  const readBack = await call({ action: "read", id });
  is("read gives the latest version's own words to start a new version from", [(readBack.body.version as { body: string }).body, (readBack.body.version as { lines: { amount: string }[] }).lines[0].amount], [BODY, "400"]);
  is("a payment request that is not the store's is refused", (await call({ action: "revise", id, title: "x", body: "y", payRequest: "f".repeat(32) })).body.error, "pay");
  is("revise makes version 2", [(await call({ action: "revise", id, title: "x", body: "y" })).body.version], [2]);
  is("withdraw, then delete", [(await call({ action: "withdraw", id })).body.ok, (await call({ action: "delete", id })).body.ok], [true, true]);
  is("signed out: refused", (await studioRoute(new NextRequest("https://marktmorgen.com/api/store/agreements", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).status, 401);

  part("Said honestly where creators and signers read it");
  const banned = /legally binding|court[- ]admissible|admissible in court|compliant with|complies with|in compliance with|ESIGN[- ]compliant|UETA[- ]compliant|guarantee/i;
  const said = [JSON.stringify(Object.values(AGREEMENT_WORDS).map((w) => [w.recorded, w.enforce("S"), w.before("S"), w.consent, w.onlyYou])), read("components/agreements-studio.tsx"), read("app/studio/agreements/page.tsx"), read("app/[handle]/sign/[agreement]/page.tsx"), read("lib/agreements.ts")];
  is("nothing claims it is legally binding, court-admissible or compliant with a law", said.filter((s) => banned.test(s)).length, 0);
  is("every language says enforceability depends on local law, and what is recorded", Object.values(AGREEMENT_WORDS).every((w) => w.enforce("S").includes("S") && w.recorded.includes("SHA-256")), true);
  const privacy = read("app/privacy/page.tsx");
  is("the privacy policy says what is kept, the one-way code, and how it is deleted", [privacy.includes('id="agreements"'), /one-way code/.test(privacy), /deletes every agreement/.test(privacy)], [true, true, true]);
  const terms = read("app/terms/page.tsx");
  is("the terms say it is sent only to someone who expects it, promise no validity, and forbid signing for someone else", [/Proposals and agreements/.test(terms), /We do not promise that a signature/.test(terms), /Never sign, or\s+ask anyone to sign, for someone else/.test(terms)], [true, true, true]);
  is("the help center and the feature page say what it does", [/proposal or an agreement to sign/i.test(read("lib/help-content.ts")), /Proposals and agreements to sign/.test(read("lib/feature-pages.ts"))], [true, true]);

  part("Store commands per action, measured");
  for (const [what, n] of Object.entries(measured)) console.log(`        ${String(n).padStart(4)}  ${what}`);
  is("every single action stays within forty commands", Object.entries(measured).filter(([what, n]) => !what.startsWith("delete the person") && n > 40), []);
  is("deleting the person: two commands an agreement and two more", measured[`delete the person (${left} agreements)`] <= 2 * left + 2, true);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
