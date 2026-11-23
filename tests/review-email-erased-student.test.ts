/**
 * The email that tells a student what the creator made of their work is never sent to a student erased while the
 * review was saved and the course's end noted (Codex U-20261119-0503, row 98 of #5010). The route reads the store at
 * the start of the request, saves the review, awaits noteIfFinished and only then sends: the erasure can pass in that
 * wait. tellStudentOfReview reads the store again by its handle and the student's deletion print just before the send.
 * Synthetic stores, the in-memory Redis and a stand-in Resend only.
 */
import { REVIEW_MAIL_CHECK_COMMANDS, studentStillThere, tellStudentOfReview } from "@/lib/assignment-notify";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { MAX_STORE_BYTES, claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail, storeHandleKey as handleKey, type Listing, type Store } from "@/lib/store";
import { suppressCommand } from "@/lib/suppression";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { COMMAND, DB_BYTE, reviewMailCheckUsd } from "./plan-cost-registry";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    sent.push([(JSON.parse(String(init?.body)) as { to: string | string[] }).to].flat()[0]);
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const product = { id: "p1", title: "Selling better" } as Listing;
const answered = { text: "", file: null, at: 1, state: "approved" as const, feedback: "Well done.", reviewedAt: 2, tries: 1 };
const STUDENT = "student@example.com";
type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

async function shop(email: string, handle: string): Promise<Store> {
  await claimHandle(email, handle, "Review shop", "");
  await ensureStoreId(email);
  await ensureStatsId(email);
  await ensureListId(email);
  return (await storeForEmail(email))!;
}

/** The send's answer, or "threw"; and how many emails went to the student. */
async function tell(store: Store): Promise<{ answer: boolean | "threw"; emails: number }> {
  const before = sent.length;
  const answer = await tellStudentOfReview({ store, product, lessonId: "l1", lessonTitle: "Opening", to: STUDENT, submission: answered, origin: "https://marktmorgen.com" }).catch(() => "threw" as const);
  return { answer, emails: sent.slice(before).filter((to) => to === STUDENT).length };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";

  part("A student still there is told, as before");
  const live = await shop("review-live@example.com", "reviewlive");
  is("the email goes", await tell(live), { answer: true, emails: 1 });

  part("The student is erased in the wait, the store already had a list");
  const listed = await shop("review-listed@example.com", "reviewlisted");
  redis.run(suppressCommand(listed.listId!, STUDENT));
  is("nothing is sent", await tell(listed), { answer: false, emails: 0 });

  part("The student is erased in the wait, and the store the route read had no list yet");
  const kept = await shop("review-bare@example.com", "reviewbare");
  const { listId, ...bare } = kept;
  is("the store the route read has no list", (bare as Store).listId ?? null, null);
  redis.run(suppressCommand(listId!, STUDENT));
  is("nothing is sent", await tell(bare as Store), { answer: false, emails: 0 });

  part("Another student of the same store erased: this one is still told");
  const other = await shop("review-other@example.com", "reviewother");
  redis.run(suppressCommand(other.listId!, "someone-else@example.com"));
  is("the email goes", await tell(other), { answer: true, emails: 1 });

  part("The store is no longer behind its handle");
  const gone = await shop("review-gone@example.com", "reviewgone");
  redis.run(["DEL", handleKey("reviewgone")]);
  is("nothing is sent", await tell(gone), { answer: false, emails: 0 });

  part("Another store holds the handle now");
  const moved = await shop("review-moved@example.com", "reviewmoved");
  const taker = await shop("review-taker@example.com", "reviewtaker");
  redis.run(["SET", handleKey("reviewmoved"), taker.email]);
  is("nothing is sent", await tell(moved), { answer: false, emails: 0 });

  part("The check of the deletion print cannot be read");
  const garbled = await shop("review-garbled@example.com", "reviewgarbled");
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await real(commands);
    return commands.map((c, i) => (c[0] === "HEXISTS" ? "yes?" : replies[i]));
  }) as typeof redis.pipeline;
  try {
    const result = await tell(garbled);
    is("no email, and the send is not called done", [result.answer === true, result.emails], [false, 0]);
  } finally {
    redis.pipeline = real;
  }
  part("What the check costs, and where it is priced");
  for (const [what, shopEmail, handle, erased] of [["a student still there", "review-cost-live@example.com", "reviewcostlive", false], ["an erased student", "review-cost-gone@example.com", "reviewcostgone", true]] as const) {
    const store = await shop(shopEmail, handle);
    if (erased) redis.run(suppressCommand(store.listId!, STUDENT));
    const seen: Command[] = [];
    redis.pipeline = (async (commands: Command[]) => {
      seen.push(...commands);
      return real(commands);
    }) as typeof redis.pipeline;
    try {
      await studentStillThere(store, STUDENT);
    } finally {
      redis.pipeline = real;
    }
    is(`${what}: the check sends at most REVIEW_MAIL_CHECK_COMMANDS (${REVIEW_MAIL_CHECK_COMMANDS}) commands`, seen.length <= REVIEW_MAIL_CHECK_COMMANDS, true);
    is(`${what}: a GET of the handle, a GET of the store's record and the print's HEXISTS`, seen.map((c) => c[0]).join(" "), "GET GET HEXISTS");
  }
  // Fits in the room: priced on every studio request of the month, since each review is one and the check runs before
  // the email is taken. For each plan: studio requests × (3 commands × $0.000002 + (1,000,000 + 4,096) bytes × $3e-11).
  for (const tier of Object.keys(STORE_ALLOWANCES) as (keyof typeof STORE_ALLOWANCES)[]) {
    const studio = STORE_ALLOWANCES[tier].studio;
    const each = REVIEW_MAIL_CHECK_COMMANDS * COMMAND + (MAX_STORE_BYTES + 4_096) * DB_BYTE;
    const usd = studio * each;
    is(`${tier}: ${studio} studio requests × $${each.toFixed(8)} = $${usd.toFixed(4)} a month, priced in the store-email line`, reviewMailCheckUsd(tier) >= usd - 1e-12 && usd > 0, true);
  }
  done();
}

void main();
