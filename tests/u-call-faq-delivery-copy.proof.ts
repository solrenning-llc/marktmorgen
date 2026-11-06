/**
 * Evidence for the paid-call FAQ's unconditional email-delivery claim.
 *
 * confirmBooking records a paid booking even when both real sendEmail calls
 * return false. The FAQ must describe those messages as attempts, while still
 * explaining who receives each calendar invitation when the sender accepts it.
 */
import { callBeginnerQuestions } from "@/lib/call-faq";
import type { CallSetup } from "@/lib/call-setup";
import { type CallListing, confirmBooking, isConfirmed } from "@/lib/calls";
import { readListing } from "@/lib/catalog";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  setProductCall,
  setStripeAccount,
  setSubscription,
  storeForEmail,
} from "@/lib/store";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "calls-owner@example.com";
const BUYER = "calls-buyer@example.com";
const requests: { accepted: boolean; to: string; hasCalendar: boolean }[] = [];
let acceptMail = false;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as {
      attachments?: { filename?: string }[];
      to: string | string[];
    };
    requests.push({
      accepted: acceptMail,
      to: [body.to].flat()[0] ?? "",
      hasCalendar: body.attachments?.some((file) => file.filename === "call.ics") ?? false,
    });
    return acceptMail ? answer({ id: `email_${requests.length}` }) : answer({ message: "synthetic refusal" }, 500);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const weekly = {
  kind: "weekly",
  minutes: 30,
  tz: "America/New_York",
  weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []],
  noticeHours: 1,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/call-room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

async function storeWithCall(email: string, handle: string) {
  await claimHandle(email, handle, "Calendar Workshop", "");
  await ensureStatsId(email);
  await setStripeAccount(email, `acct_${handle}`, true);
  await setSubscription(email, { customerId: null, subscriptionId: null, active: true });
  const made = await addProduct(email, "Planning call", "", "20", null);
  if (!made.ok) throw new Error("the synthetic call product was not created");
  await setProductCall(email, made.product.id, weekly);
  const store = await storeForEmail(email);
  if (!store) throw new Error("the synthetic store was not created");
  return { store, product: (await readListing(store, made.product.id)) as CallListing };
}

async function book(handle: string, session: string): Promise<void> {
  const call = await storeWithCall(OWNER.replace("@", `+${handle}@`), handle);
  const start = Date.now() + 5 * 86_400_000;
  await confirmBooking({
    store: call.store,
    product: call.product,
    session,
    start,
    end: start + 1_800_000,
    buyerEmail: BUYER,
    buyerTz: "Europe/Lisbon",
    due: null,
    cancel: null,
    origin: "https://marktmorgen.com",
  });
}

async function main(): Promise<void> {
  redis.clear();
  // An allow-listed synthetic credential: the fallback-budget fixture blocks
  // every unknown value before any provider request can be attempted.
  process.env.RESEND_API_KEY = "re_test_demo_silence_only";
  delete process.env.SES_ACCESS_KEY_ID;
  delete process.env.SES_SECRET_ACCESS_KEY;

  const answer = callBeginnerQuestions()[0]?.a ?? "";

  part("The public words");
  is("the answer is the paid-call answer", callBeginnerQuestions()[0]?.q, "What is a paid call here?");
  is("it still explains the calendar file", answer.includes("calendar file"), true);
  is("it still distinguishes the team host", answer.includes("or the host does on a team call you do not host"), true);
  is("it still distinguishes a Google Calendar entry", answer.includes("Google Calendar"), true);

  part("A real booking when the sender refuses both messages");
  acceptMail = false;
  await book("faq-refused", "cs_test_call_faq_refused");
  is("the booking is confirmed", await isConfirmed("cs_test_call_faq_refused"), true);
  is("the sender was asked for both messages", requests.map((request) => request.to).sort(), [BUYER, "calls-owner+faq-refused@example.com"].sort());
  is("both attempted messages carried calendar files", requests.every((request) => request.hasCalendar), true);
  is("neither message was accepted", requests.filter((request) => request.accepted).length, 0);

  part("The same real path when the sender accepts");
  requests.length = 0;
  acceptMail = true;
  await book("faq-accepted", "cs_test_call_faq_accepted");
  is("the second booking is confirmed", await isConfirmed("cs_test_call_faq_accepted"), true);
  is("both messages are accepted", requests.filter((request) => request.accepted).length, 2);
  is("the buyer and creator are still the recipients", requests.map((request) => request.to).sort(), [BUYER, "calls-owner+faq-accepted@example.com"].sort());

  part("The claim matches what the booking path can prove");
  is(
    "the FAQ does not promise delivery after a provider refusal",
    answer.includes("The buyer gets an email with a calendar file. You get one too"),
    false,
  );
  is(
    "the FAQ says that both calendar emails are attempted",
    answer.includes("We try to email the buyer a calendar file. We try to email you one too"),
    true,
  );

  done();
}

void main();
