/**
 * The note that a checkout coupon was made on a creator's Stripe account
 * (lib/intro-coupon.ts, lib/fair-coupon.ts; inventory on main f8c8e0d692).
 *
 * The note is only a shortcut: the coupon's id is fixed, so Stripe itself
 * refuses a second one (resource_already_exists) and the one found is used
 * only when it is exactly the coupon this checkout needs. What is checked:
 *
 *   - the note counts only as the exact "1", and is written only on an exact
 *     "OK"; a failed or odd read or write is said in the log, never passed
 *     over in silence (it was `.catch(() => undefined)`);
 *   - with the note lost or unreadable, the next checkout still finds the
 *     same coupon at Stripe and never makes a second one;
 *   - a coupon already there under the id is used only in its exact shape:
 *     valid, and for a fair price taken off once (a "forever" coupon would
 *     take the fair price off every renewal of a membership).
 */
import { introCoupon } from "@/lib/intro-coupon";
import { fairCoupon } from "@/lib/fair-coupon";
import { introCouponId } from "@/lib/intro-price";
import { fairCouponId } from "@/lib/fair-price";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ACCOUNT = "acct_1TestCouponMark01";

// A stand-in Stripe that keeps each coupon by its id, as Stripe does.
const coupons = new Map<string, Record<string, unknown>>();
let created = 0;
let calls = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls += 1;
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/coupons" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const id = body.get("id")!;
    if (coupons.has(id)) return answer({ error: { code: "resource_already_exists", message: "Coupon already exists." } }, 400);
    created += 1;
    const coupon: Record<string, unknown> = { id, object: "coupon", duration: body.get("duration"), valid: true };
    if (body.get("amount_off")) Object.assign(coupon, { amount_off: Number(body.get("amount_off")), currency: body.get("currency") });
    if (body.get("percent_off")) coupon.percent_off = Number(body.get("percent_off"));
    if (body.get("duration_in_months")) coupon.duration_in_months = Number(body.get("duration_in_months"));
    coupons.set(id, coupon);
    return answer(coupon);
  }
  const one = /^\/coupons\/(.+)$/.exec(path);
  if (one && method === "GET") {
    const coupon = coupons.get(decodeURIComponent(one[1]));
    return coupon ? answer(coupon) : answer({ error: { code: "resource_missing" } }, 404);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

// What lib/ said in the log while `work` ran.
async function logged<T>(work: () => Promise<T>): Promise<{ result: T | Error; lines: string[] }> {
  const lines: string[] = [];
  const before = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { result: await work().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))), lines };
  } finally {
    console.error = before;
  }
}

// The stand-in Redis, with the coupon notes' writes or reads made to fail or answer oddly.
const realPipeline = redis.pipeline.bind(redis);
function noteTrouble(command: "GET" | "SET", how: "throws" | "odd"): void {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const note = commands.length === 1 && commands[0][0] === command && /^nl:(intro|fair):c:/.test(String(commands[0][1]));
    if (!note) return realPipeline(commands);
    if (how === "throws") throw new Error("Redis is unavailable (stand-in)");
    // Not written, or not read, and answered in a shape that is not the command's.
    return command === "SET" ? [null] : [1];
  }) as typeof redis.pipeline;
}
function noteFine(): void {
  redis.pipeline = realPipeline;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_coupon_mark_only_a_stand_in";
  const introId = introCouponId("usd", 1500, 3);
  const introNote = `nl:intro:c:${ACCOUNT}:${introId}`;

  part("Introductory price: a note that is not written is said, and Stripe still holds one coupon");
  noteTrouble("SET", "throws");
  let run = await logged(() => introCoupon(ACCOUNT, "usd", 1500, 3));
  is("the coupon is made and used", [run.result, created], [introId, 1]);
  is("the lost note is said in the log, never in silence", run.lines.some((line) => line.includes(introNote)), true);
  noteFine();
  run = await logged(() => introCoupon(ACCOUNT, "usd", 1500, 3));
  is("the next checkout finds the same coupon at Stripe: no second one", [run.result, created, coupons.size], [introId, 1, 1]);
  is("and now notes it", await realPipeline([["GET", introNote]]), ["1"]);
  calls = 0;
  is("noted, Stripe is not asked again", [await introCoupon(ACCOUNT, "usd", 1500, 3), calls], [introId, 0]);

  part("Introductory price: a write answered in another shape is not a note");
  redis.clear();
  noteTrouble("SET", "odd");
  run = await logged(() => introCoupon(ACCOUNT, "usd", 1500, 3));
  is("used, from the coupon Stripe holds", [run.result, created, coupons.size], [introId, 1, 1]);
  is("not written: said in the log", run.lines.some((line) => line.includes(introNote)), true);
  is("and nothing was noted", await realPipeline([["GET", introNote]]), [null]);
  noteFine();

  part("Introductory price: an unreadable note asks Stripe, which makes no second coupon");
  await realPipeline([["SET", introNote, "1"]]);
  for (const how of ["throws", "odd"] as const) {
    noteTrouble("GET", how);
    calls = 0;
    run = await logged(() => introCoupon(ACCOUNT, "usd", 1500, 3));
    is(`a read that ${how === "throws" ? "fails" : "answers 1 as a number"} is not "made": Stripe is asked and finds it`, [run.result, created, coupons.size, calls > 0], [introId, 1, 1, true]);
    is(`and it is said in the log (${how})`, run.lines.some((line) => line.includes(introNote)), true);
    noteFine();
  }

  part("Introductory price: a coupon already there is used only in its exact shape");
  redis.clear();
  const odd = introCouponId("usd", 700, 2);
  coupons.set(odd, { id: odd, object: "coupon", amount_off: 700, currency: "usd", duration: "repeating", duration_in_months: 2 });
  run = await logged(() => introCoupon(ACCOUNT, "usd", 700, 2));
  is("one Stripe sends without saying it is valid is refused", run.result instanceof Error, true);
  coupons.set(odd, { ...coupons.get(odd), valid: true });
  is("valid, it is used", await introCoupon(ACCOUNT, "usd", 700, 2), odd);

  part("Fair price: the same note, the same honesty");
  redis.clear();
  coupons.clear();
  created = 0;
  const fairId = fairCouponId(50);
  const fairNote = `nl:fair:c:${ACCOUNT}:50`;
  noteTrouble("SET", "throws");
  run = await logged(() => fairCoupon(ACCOUNT, 50));
  is("made and used", [run.result, created], [fairId, 1]);
  is("the lost note is said in the log", run.lines.some((line) => line.includes(fairNote)), true);
  noteFine();
  run = await logged(() => fairCoupon(ACCOUNT, 50));
  is("the next checkout finds the same coupon: no second one", [run.result, created, coupons.size], [fairId, 1, 1]);
  is("and now notes it", await realPipeline([["GET", fairNote]]), ["1"]);
  noteTrouble("GET", "odd");
  run = await logged(() => fairCoupon(ACCOUNT, 50));
  is("a note read in another shape asks Stripe, no second coupon", [run.result, created, coupons.size], [fairId, 1, 1]);
  is("and is said in the log", run.lines.some((line) => line.includes(fairNote)), true);
  noteFine();

  part("Fair price: a coupon already there is used only when it is taken off once");
  redis.clear();
  const forever = fairCouponId(30);
  coupons.set(forever, { id: forever, object: "coupon", percent_off: 30, duration: "forever", valid: true });
  run = await logged(() => fairCoupon(ACCOUNT, 30));
  is("a coupon taking 30% off every renewal is refused", run.result instanceof Error, true);
  coupons.set(forever, { id: forever, object: "coupon", percent_off: 30, duration: "once" });
  run = await logged(() => fairCoupon(ACCOUNT, 30));
  is("one Stripe sends without saying it is valid is refused", run.result instanceof Error, true);
  coupons.set(forever, { ...coupons.get(forever), valid: true });
  is("once and valid, it is used", await fairCoupon(ACCOUNT, 30), forever);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
