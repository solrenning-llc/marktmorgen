/**
 * MM-SA-03: a signature, or a new version, could be erased by an email
 * about the same agreement.
 *
 * A signature and a new version are written under the agreement's lock
 * (lib/agreement-store.ts). The emails about it were not: sending the link
 * again (sendAgain, sendAgreementEmail) and sending the signed copy again
 * (resendSignedCopy) read the record, waited for the email to go, and wrote
 * back the whole record they had read. A person who signed while the creator
 * pressed "send again" had their signature taken off the record, which then
 * read as waiting for one; a version written while a signed copy was being
 * sent again was lost from the record.
 *
 * Proved against a real Redis, with the email sender held at its slow step:
 * every signature and every version written meanwhile must still be on the
 * record afterward.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { type AgreementDraft, latestOf, readDraft, statusOf } from "@/lib/agreement-rules";
import { agreementOf, createAgreement, readVersion, reviseAgreement, signAgreement } from "@/lib/agreement-store";
import { resendSignedCopy, sendAgain, sendAgreementEmail } from "@/lib/agreements";
import { paidPeriod } from "../billing-period-fixture";
import { check, finish } from "./check";

const slow = { mail: 0 };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let enteredSlowMail: (() => void) | null = null;
let slowMailEntries = 0;
/** Observe the real mocked provider entry; a refused send cannot stand in for
 * a race with an in-flight email. No mutation starts before this ACK. */
function expectSlowMail(): Promise<void> {
  const expected = slowMailEntries + 1;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { enteredSlowMail = null; reject(new Error("The slow synthetic mail provider was never reached")); }, 5_000);
    enteredSlowMail = () => {
      enteredSlowMail = null;
      clearTimeout(timer);
      check("the exact next slow synthetic provider POST began before the concurrent write", ++slowMailEntries, expected);
      resolve();
    };
  });
}

const real = globalThis.fetch;
let mails = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (String(url).startsWith(String(process.env.UPSTASH_REDIS_REST_URL))) return real(input as string, init);
  if (url.hostname === "api.resend.com") {
    if (slow.mail) {
      const delay = slow.mail;
      enteredSlowMail?.();
      await wait(delay);
    }
    mails += 1;
    return new Response(JSON.stringify({ id: `email_${mails}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this check: ${url.hostname}`);
}) as typeof fetch;

const BODY = "Three months of coaching, one call a week.";
const draftOf = (email: string): AgreementDraft => {
  const read = readDraft({ kind: "agreement", email, name: "Dana Reyes", title: "Coaching", body: BODY, lines: [{ text: "Coaching, per month", quantity: 3, amount: "400" }], consent: true }, "usd");
  if (!read.ok) throw new Error(read.problem);
  return read.draft;
};

async function signLatest(store: Store, id: string, email: string) {
  const a = (await agreementOf(store, id))!;
  const latest = latestOf(a)!;
  return signAgreement(store, id, { n: latest.n, sha256: latest.sha256, name: "Dana Reyes", email, consent: true, ip: "198.51.100.40" }, "Dana Reyes");
}

async function main(): Promise<void> {
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_security_journey_only_a_stand_in";
  process.env.STRIPE_SECRET_KEY = "sk_test_security_journey_only_a_stand_in";
  const owner = "owner@agreement-signature.example";
  await claimHandle(owner, "agreement-signature", "Agreement Signature Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1AgreementSigX", true);
  await setSubscription(owner, { customerId: "cus_agreementsig", subscriptionId: "sub_agreementsig", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;

  // 1. The creator sends the link again while the person signs.
  const one = await createAgreement(store, draftOf("signer@example.com"));
  if (!one.ok) throw new Error(one.message);
  slow.mail = 600;
  const resendingEntered = expectSlowMail();
  const resending = sendAgain(store, one.agreement.id);
  await resendingEntered;
  const signed = await signLatest(store, one.agreement.id, "signer@example.com");
  slow.mail = 0;
  await resending;
  const afterOne = (await agreementOf(store, one.agreement.id))!;
  check("a signature given while the link was being sent again is still on the record", [signed.ok, statusOf(afterOne), Boolean(latestOf(afterOne)?.signature)], [true, "signed", true]);

  // 2. A new version is emailed while the person signs it.
  const two = await createAgreement(store, draftOf("second@example.com"));
  if (!two.ok) throw new Error(two.message);
  const revised = await reviseAgreement(store, two.agreement.id, { ...draftOf("second@example.com"), body: `${BODY}\n\nFour months, not three.` });
  if (!revised.ok) throw new Error(revised.message);
  slow.mail = 600;
  const emailingEntered = expectSlowMail();
  const emailing = sendAgreementEmail(store, revised.agreement, revised.version);
  await emailingEntered;
  const signedTwo = await signLatest(store, two.agreement.id, "second@example.com");
  slow.mail = 0;
  await emailing;
  const afterTwo = (await agreementOf(store, two.agreement.id))!;
  check("a signature on a new version given while it was being emailed is still on the record", [signedTwo.ok, statusOf(afterTwo), latestOf(afterTwo)?.n], [true, "signed", 2]);

  // 3. The signed copy is sent again while the creator writes a new version.
  const three = await createAgreement(store, draftOf("third@example.com"));
  if (!three.ok) throw new Error(three.message);
  await signLatest(store, three.agreement.id, "third@example.com");
  slow.mail = 600;
  const copyingEntered = expectSlowMail();
  const copying = resendSignedCopy(store, three.agreement.id);
  await copyingEntered;
  const v2 = await reviseAgreement(store, three.agreement.id, { ...draftOf("third@example.com"), body: `${BODY}\n\nWith a workbook.` });
  slow.mail = 0;
  await copying;
  const afterThree = (await agreementOf(store, three.agreement.id))!;
  check("a version written while the signed copy was being sent again is still on the record", [v2.ok, afterThree.versions.length, Boolean(await readVersion(afterThree, 2))], [true, 2, true]);
  check("and the earlier version keeps its signature", Boolean(afterThree.versions.find((m) => m.n === 1)?.signature), true);
  finish();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
