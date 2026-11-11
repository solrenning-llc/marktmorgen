/**
 * Making and stopping a code only for people who already bought from this
 * store, from the studio (554 [DS1], unit 2, part 3; lib/returning-code-make.ts).
 *
 * What must hold:
 *   - one coupon on the creator's own Stripe account, once, with the limit
 *     of uses asked, and never a promotion code, so Stripe's own box can
 *     never take it; kept on the store only when Stripe's answer says it
 *     made exactly that coupon;
 *   - a word already used by one of the creator's live promotion codes, or
 *     by another code of this kind, is refused before anything is made; a
 *     list Stripe answers in another shape is not "no such code";
 *   - a minimum order is refused, never dropped (a coupon applied by us has
 *     none Stripe would check); twenty codes at most;
 *   - stopping takes the word off the store first, which is what stops it,
 *     then deletes the coupon; a failed delete still leaves it stopped;
 *   - a normal code cannot take a word a returning-buyer code has (route);
 *   - the studio's confirmation reader takes the list only in its exact
 *     shape, and the editor offers the choice unchecked, with its words.
 *
 * Stripe is played by a stand-in for `fetch`; synthetic data only.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { makeReturningCode, stopReturningCode } from "@/lib/returning-code-make";
import { readReturningConfirmation } from "@/lib/discount-confirmation";
import { MAX_RETURNING_CODES } from "@/lib/returning-code-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_returning_studio_only";

const OWNER = "returning.studio@example.com";
type Sent = { method: string; path: string; body: URLSearchParams };
const sent: Sent[] = [];
let livePromotions: string[] = [];
let promotionList: "list" | "garbled" = "list";
let couponAnswer: "exact" | "other" | "error" = "exact";
let deleteFails = false;
let n = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(init?.body ? String(init.body) : "");
  sent.push({ method, path, body });
  const answer = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  if (method === "GET" && path === "/promotion_codes") {
    if (promotionList === "garbled") return answer({ object: "list" });
    const word = url.searchParams.get("code") ?? "";
    return answer({ object: "list", data: livePromotions.includes(word) ? [{ id: "promo_live01", code: word, active: true }] : [], has_more: false });
  }
  if (method === "POST" && path === "/coupons") {
    if (couponAnswer === "error") return answer({ error: { message: "synthetic failure" } }, 500);
    n += 1;
    const id = `cpn_Returning${String(n).padStart(4, "0")}`;
    const percent = body.get("percent_off");
    const echo = { id, object: "coupon", duration: body.get("duration"), percent_off: percent ? Number(percent) : null, amount_off: body.get("amount_off") ? Number(body.get("amount_off")) : null, currency: body.get("currency"), max_redemptions: body.get("max_redemptions") ? Number(body.get("max_redemptions")) : null };
    return answer(couponAnswer === "other" ? { ...echo, percent_off: 99 } : echo);
  }
  if (method === "DELETE" && path.startsWith("/coupons/")) {
    if (deleteFails) return answer({ error: { message: "synthetic failure" } }, 500);
    return answer({ id: decodeURIComponent(path.slice("/coupons/".length)), object: "coupon", deleted: true });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const asked = (code: string, extra: Partial<{ maxRedemptions: number | null; minimum: { cents: number; currency: string } | null }> = {}) => ({
  code,
  off: { kind: "percent" as const, percent: 20 },
  maxRedemptions: null,
  minimum: null,
  ...extra,
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "returnstudio", "Return Studio", "Synthetic store.");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRetStud1", true);
  await setSubscription(OWNER, { customerId: "cus_RetStudio0001", subscriptionId: "sub_RetStudio0001", active: true, tier: "creator", period: paidPeriod() });
  const store = async () => (await storeForEmail(OWNER))!;

  part("Made: one coupon, once, with the uses asked, and never a promotion code");
  sent.length = 0;
  let made = await makeReturningCode(OWNER, await store(), asked("THANKYOU", { maxRedemptions: 50 }));
  const coupon = sent.find((s) => s.method === "POST" && s.path === "/coupons");
  is("made", made.ok, true);
  is("the coupon: once, 20% off, 50 uses, its word in its name and metadata", [coupon?.body.get("duration"), coupon?.body.get("percent_off"), coupon?.body.get("max_redemptions"), coupon?.body.get("name"), coupon?.body.get("metadata[returning]")], ["once", "20", "50", "THANKYOU", "THANKYOU"]);
  is("no promotion code is made", sent.some((s) => s.method === "POST" && s.path === "/promotion_codes"), false);
  is("kept on the store, with the coupon Stripe made", (await store()).returningCodes.map((c) => [c.code, c.coupon, c.endsAt]), [["THANKYOU", "cpn_Returning0001", null]]);

  part("A word already in use is refused before anything is made");
  sent.length = 0;
  made = await makeReturningCode(OWNER, await store(), asked("THANKYOU"));
  is("the same word as a returning-buyer code", [made.ok ? "" : made.reason, sent.length], ["taken", 0]);
  livePromotions = ["SPRING"];
  sent.length = 0;
  made = await makeReturningCode(OWNER, await store(), asked("SPRING"));
  is("the word of a live promotion code", [made.ok ? "" : made.reason, sent.some((s) => s.path === "/coupons")], ["taken", false]);
  promotionList = "garbled";
  made = await makeReturningCode(OWNER, await store(), asked("SUMMER"));
  is("a promotion list Stripe answers in another shape is not 'no such code'", [made.ok ? "" : made.reason, sent.some((s) => s.path === "/coupons")], ["stripe", false]);
  promotionList = "list";

  part("A minimum is refused, never dropped");
  sent.length = 0;
  made = await makeReturningCode(OWNER, await store(), asked("MINIMUM", { minimum: { cents: 5000, currency: "usd" } }));
  is("refused, nothing made", [made.ok ? "" : made.reason, sent.length], ["minimum", 0]);

  part("Stripe's answer must say it made exactly that coupon");
  couponAnswer = "other";
  sent.length = 0;
  made = await makeReturningCode(OWNER, await store(), asked("ODDONE"));
  is("another coupon in the answer: not kept, and the coupon deleted", [made.ok ? "" : made.reason, (await store()).returningCodes.some((c) => c.code === "ODDONE")], ["stripe", false]);
  couponAnswer = "error";
  made = await makeReturningCode(OWNER, await store(), asked("ODDTWO"));
  is("an error: not kept", [made.ok ? "" : made.reason, (await store()).returningCodes.some((c) => c.code === "ODDTWO")], ["stripe", false]);
  couponAnswer = "exact";

  part("Twenty at most");
  for (let i = (await store()).returningCodes.length; i < MAX_RETURNING_CODES; i += 1) await makeReturningCode(OWNER, await store(), asked(`THANKS-${i}`));
  sent.length = 0;
  made = await makeReturningCode(OWNER, await store(), asked("ONEMORE"));
  is("the next one is refused, nothing made", [(await store()).returningCodes.length, made.ok ? "" : made.reason, sent.length], [MAX_RETURNING_CODES, "full", 0]);

  part("Stopped: off the store first, then the coupon deleted");
  sent.length = 0;
  is("stopped", await stopReturningCode(OWNER, await store(), "THANKYOU"), true);
  is("no longer on the store", (await store()).returningCodes.some((c) => c.code === "THANKYOU"), false);
  is("its coupon deleted", sent.some((s) => s.method === "DELETE" && s.path === "/coupons/cpn_Returning0001"), true);
  deleteFails = true;
  is("a failed delete still leaves it stopped", [await stopReturningCode(OWNER, await store(), "THANKS-1"), (await store()).returningCodes.some((c) => c.code === "THANKS-1")], [true, false]);
  deleteFails = false;
  is("a word the store does not have is not stopped", await stopReturningCode(OWNER, await store(), "NOPE"), false);

  part("The studio reads the list only in its exact shape");
  const row = { code: "THANKYOU", off: { kind: "percent", percent: 20 }, createdAt: 1_790_000_000, endsAt: null };
  is("a list as sent", readReturningConfirmation({ ok: true, codes: [], returning: [row] }), [{ code: "THANKYOU", off: { kind: "percent", percent: 20 }, createdAt: 1_790_000_000 }]);
  is("anything else is no confirmation", [readReturningConfirmation({ ok: true, codes: [] }), readReturningConfirmation({ ok: true, returning: [{ ...row, code: 7 }] }), readReturningConfirmation({ ok: true, returning: "THANKYOU" })], [null, null, null]);
  is("the coupon id never goes to the page", JSON.stringify(readReturningConfirmation({ ok: true, returning: [{ ...row, coupon: "cpn_x" }] })).includes("cpn_"), false);

  part("The route and the editor");
  const route = readFileSync("app/api/store/discount/route.ts", "utf8");
  is("a normal code cannot take a returning-buyer code's word", /returningCodes\.some\(\(entry\) => entry\.code === read\.asked\.code\)/.test(route), true);
  is("the list never sends the coupon id", /returning: \(await storeForEmail\(ref\)\)\?\.returningCodes\.map\(\(\{ code, off, createdAt \}\) => \(\{ code, off, createdAt \}\)\)/.test(route), true);
  is("nor through the API", readFileSync("app/api/v1/codes/route.ts", "utf8").includes("if (store.returningCodes.some((entry) => entry.code === code)) return apiError(409, \"taken\""), true);
  const editor = readFileSync("components/discount-editor.tsx", "utf8");
  is("the choice starts unchecked", editor.includes("const [returningOnly, setReturningOnly] = useState(false);"), true);
  is("and says what it does", editor.includes("Only for people who already bought from this store"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
