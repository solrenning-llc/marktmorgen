/**
 * Proof only (CX-123 rule 24 candidate): storeForHandle (lib/store.ts) reads
 * the handle-to-owner mapping (`GET nl:store:handle:<handle>`) loosely, so a
 * reply of the wrong shape, or no reply at all, answers null, exactly what a
 * confirmed absence (Redis nil) answers. Real code paths; only the one GET of
 * the handle mapping is given a malformed reply. Not part of CI.
 *
 * (a) what storeForHandle answers for each shape, against a nil control and a healthy control;
 * (b) what the store's own pages answer from it (front page, its head, the layout's head, robots.txt);
 * (c) which callers write from that "no store": the drip schedule, a webhook delivery, the
 *     unpaid-renewal record behind the failed-payment email; and the handle claim, ruled out.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeForEmail, storeForHandle, type Store } from "@/lib/store";
import StorePage, { generateMetadata as pageMeta } from "@/app/[handle]/page";
import { generateMetadata as layoutMeta } from "@/app/[handle]/layout";
import { GET as robotsGet } from "@/app/[handle]/store-robots/route";
import { sendDripEmails } from "@/lib/learn";
import { saveCourse, type Course } from "@/lib/course";
import { ROOM } from "./data-room";
import { addEndpoint, deliverDue, emitEvent, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { sendFailedPlanNotices } from "@/lib/billing-reminders";
import { isPaidUp } from "@/lib/billing";
import { canUse } from "@/lib/plan";
import { RENEWAL_PAUSED_WORDS } from "@/lib/renewal-unpaid-words";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_store_for_handle_proof";
// A synthetic key literal already listed in tests/resend-fixture-credentials.ts (the renewal-unpaid test's own).
process.env.RESEND_API_KEY = "re_test_renewal_unpaid_only";

const OWNER = "sfh-owner@example.com";
const HANDLE = "sfh-shop";
const HANDLE_KEY = `nl:store:handle:${HANDLE}`;
const SUB = "sub_SfhProof000001";
const NOW = Math.floor(Date.now() / 1000);

// ---- The one injection: the handle mapping's GET, and nothing else. ----
type Command = (string | number)[];
const SHAPES: Record<string, (real: unknown[]) => unknown[]> = {
  "no reply ([])": () => [],
  "an extra reply ([owner, extra])": (real) => [...real, "extra"],
  "a number (42)": () => [42],
  "a list ([owner])": (real) => [[real[0]]],
  "an object ({})": () => [{}],
  "a boolean (true)": () => [true],
  "an empty string": () => [""],
  "a missing slot ([undefined])": () => [undefined],
  "a string naming no owner": () => ["not-an-owner-ref"],
};
let shape = "";
let injected = 0;
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  const [only] = commands;
  // The webhook queue's lease script, as tests/webhook-resend.test.ts models it.
  if (commands.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await original([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await original([["ZADD", key, Number(until), member]]);
    return [1];
  }
  if (shape && commands.length === 1 && only[0] === "GET" && only[1] === HANDLE_KEY) {
    injected += 1;
    if (shape === "throw") throw new Error("injected: the read failed");
    return SHAPES[shape](await original(commands));
  }
  return original(commands);
}) as typeof redis.pipeline;

// ---- Providers: Stripe and Resend answered here, never reached. ----
let list: Record<string, unknown>[] = [];
const emails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    if (method === "GET" && url.pathname === "/v1/subscriptions") return Response.json({ data: list, has_more: false });
    if (method === "POST" && url.pathname.startsWith("/v1/subscriptions/")) return Response.json({ id: url.pathname.split("/").pop() });
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, text: body.text });
    return Response.json({ id: "re_1" });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

// ---- The webhook receiver: a real local HTTP server through lib/safe-fetch.ts. ----
const received: string[] = [];
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString()));
  request.on("end", () => {
    received.push(body);
    response.writeHead(200);
    response.end("ok");
  });
});
class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}

async function setup(): Promise<Store> {
  shape = "";
  redis.clear();
  emails.length = 0;
  await claimHandle(OWNER, HANDLE, "Handle proof shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_SfhProof000001", subscriptionId: SUB, active: true, tier: "pro", cycle: "month", period: paidPeriod(NOW * 1_000) });
  return (await storeForEmail(OWNER))!;
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "rendered";
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest.includes("404")) return "not found";
    if (digest) return `thrown ${digest}`;
    return `threw: ${(error as Error).message}`;
  }
}

const routeProps = (handle: string) => ({ params: Promise.resolve({ handle }), searchParams: Promise.resolve({}) }) as never;

async function main(): Promise<void> {
  const store = await setup();
  is("setup: the store holds its address", store.handle, HANDLE);

  part("(a) What storeForHandle answers, shape by shape");
  is("healthy control: the store", (await storeForHandle(HANDLE))?.handle, HANDLE);
  is("confirmed absence control (nil on a free handle): null", await storeForHandle("sfh-nobody-here"), null);
  const answers: Record<string, string> = {};
  for (const name of Object.keys(SHAPES)) {
    shape = name;
    const before = injected;
    let got: string;
    try {
      const found = await storeForHandle(HANDLE);
      got = found ? `store ${found.handle}` : "null";
    } catch (error) {
      got = `throws ${(error as Error).name}`;
    }
    answers[name] = got;
    is(`${name}: injected once`, injected - before, 1);
  }
  shape = "";
  console.log("  answers:", JSON.stringify(answers));
  is("every malformed shape answers null (same as nil), the extra reply is taken as healthy", answers, {
    "no reply ([])": "null",
    "an extra reply ([owner, extra])": `store ${HANDLE}`,
    "a number (42)": "null",
    "a list ([owner])": "null",
    "an object ({})": "null",
    "a boolean (true)": "null",
    "an empty string": "null",
    "a missing slot ([undefined])": "null",
    "a string naming no owner": "null",
  });
  shape = "throw";
  is("a failed read throws (callers with .catch(() => null) turn it into null)", await storeForHandle(HANDLE).then(() => "answered", (e: Error) => `throws ${e.message}`), "throws injected: the read failed");
  shape = "";

  part("(b) The store's own pages, from a live store's malformed read");
  answering(new Request(`https://marktmorgen.com/@${HANDLE}`));
  is("healthy control: the front page's title is the store's", (await pageMeta(routeProps(`@${HANDLE}`))).title, "Handle proof shop — Marktmorgen");
  is("healthy control: the front page is not a 404", (await outcome(() => StorePage(routeProps(`@${HANDLE}`)))) !== "not found", true);
  is("healthy control: the layout's head names the store's manifest", (await layoutMeta(routeProps(`@${HANDLE}`))).manifest, `/@${HANDLE}/manifest.webmanifest`);
  is("healthy control: robots.txt is the store's own, not Disallow: /", (await (await robotsGet(new Request("https://shop.example/robots.txt"), routeProps(`@${HANDLE}`))).text()) !== "User-agent: *\nDisallow: /\n", true);
  const pageResults: Record<string, unknown> = {};
  for (const name of ["a number (42)", "no reply ([])", "an empty string"]) {
    shape = name;
    pageResults[name] = {
      title: (await pageMeta(routeProps(`@${HANDLE}`))).title,
      page: await outcome(() => StorePage(routeProps(`@${HANDLE}`))),
      layoutManifest: (await layoutMeta(routeProps(`@${HANDLE}`))).manifest ?? null,
      robots: await (await robotsGet(new Request("https://shop.example/robots.txt"), routeProps(`@${HANDLE}`))).text(),
    };
  }
  shape = "throw";
  pageResults["throw (transient)"] = {
    layoutManifest: (await layoutMeta(routeProps(`@${HANDLE}`))).manifest ?? null,
    robots: await (await robotsGet(new Request("https://shop.example/robots.txt"), routeProps(`@${HANDLE}`))).text(),
    page: await outcome(() => StorePage(routeProps(`@${HANDLE}`))),
  };
  shape = "";
  console.log("  pages:", JSON.stringify(pageResults));
  for (const name of ["a number (42)", "no reply ([])", "an empty string"]) {
    const r = pageResults[name] as { title: string; page: string; robots: string };
    is(`${name}: the live store's front page answers 404 "Not found"`, [r.page, r.title], ["not found", "Not found — Marktmorgen"]);
    is(`${name}: its robots.txt tells every crawler Disallow: /`, r.robots, "User-agent: *\nDisallow: /\n");
  }
  is("a failed read: the layout and robots.txt swallow it (no manifest, Disallow: /)", [(pageResults["throw (transient)"] as { layoutManifest: unknown }).layoutManifest, (pageResults["throw (transient)"] as { robots: string }).robots], [null, "User-agent: *\nDisallow: /\n"]);
  answering(null);

  part("(c1) The drip schedule: a course is taken off it for good (SREM)");
  {
    await setup();
    const DRIP = "nl:courses:drip";
    const made = await addProduct(OWNER, "Drip course", "", "49", null);
    if (!made.ok) throw new Error("no product");
    const course = {
      id: "c".repeat(32), certificate: false, startsAt: null,
      modules: [{ id: "module000001", title: "Week 2", dripDays: 7, lessons: [{ id: "lesson000001", title: "Lesson", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null }] }],
    } as unknown as Course;
    await saveCourse(course, ROOM, true);
    const attached = await setProductCourse(OWNER, made.product.id, { id: course.id, lessons: 1 });
    if (!attached.ok) throw new Error(`no course: ${attached.reason}`);
    const courseId = course.id;
    const member = `${courseId}|${HANDLE}|${made.product.id}`;
    const members = async () => ((await original([["SMEMBERS", DRIP]]))[0] as string[]) ?? [];
    await original([["SADD", DRIP, member]]);
    const healthy = await sendDripEmails(storeForHandle, async () => course, "https://marktmorgen.com", NOW);
    is("healthy control: the course is read and stays on the schedule", [healthy.courses, (await members()).includes(member)], [1, true]);
    shape = "a number (42)";
    await sendDripEmails(storeForHandle, async () => course, "https://marktmorgen.com", NOW);
    is("an unknown handle read: the course's drip member is removed from the schedule", (await members()).includes(member), false);
    await original([["SADD", DRIP, member]]);
    shape = "throw";
    const thrown = await sendDripEmails(storeForHandle, async () => course, "https://marktmorgen.com", NOW).then(() => "answered", () => "threw");
    is("a failed read (throw) keeps it: the pass stops, nothing removed", [thrown, (await members()).includes(member)], ["threw", true]);
    shape = "";
    const source = readFileSync("lib/learn.ts", "utf8");
    is("source: `if (!store || !product || !course) SREM DRIP_SET member`", /if \(!store \|\| !product \|\| !course\) \{\s*await redisPipeline\(\[\["SREM", DRIP_SET, member\]\]\);/.test(source), true);
    is("source: only registerDrip (a course save) puts it back", (source.match(/"SADD"/g) ?? []).length >= 1 && source.includes("export async function registerDrip"), true);
  }

  part("(c2) A creator's webhook delivery: given up for good, never sent");
  {
    const one = await setup();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });
    const added = await addEndpoint(one, "https://hooks.example.com/sales", ["sale.completed"]);
    is("endpoint added", added.ok, true);
    await emitEvent(one, "sale.completed", "cs_sfh_healthy01", { amount_cents: 100 });
    await deliverDue(Date.now() + 10_000);
    is("healthy control: delivered to the endpoint", [received.length, (await webhooksView(one)).log[0]?.state], [1, "delivered"]);
    // emitEvent runs the first try at once (lib/webhooks.ts claim then runClaimed), so the read is unknown from there.
    shape = "a number (42)";
    await emitEvent(one, "sale.completed", "cs_sfh_unknown01", { amount_cents: 100 });
    await deliverDue(Date.now() + 10_000);
    shape = "";
    const line = (await webhooksView(one)).log.find((d) => d.state !== "delivered");
    is("unknown handle read: the sale's delivery is failed, with no retry, and nothing was sent", [line?.state, line?.next, line?.lastError, received.length], ["failed", 0, "The store could not be found.", 1]);
    const [queued] = await original([["ZCARD", "nl:hooks:q"]]);
    await deliverDue(Date.now() + 10_000, Date.now() + 25 * 3_600_000);
    is("and it is never tried again once the read is healthy", [received.length, queued === 0 || queued === null], [1, true]);
    // The same through a thrown read: lib/webhooks.ts catches it into null.
    shape = "throw";
    await emitEvent(one, "sale.completed", "cs_sfh_thrown001", { amount_cents: 100 }).catch(() => 0);
    await deliverDue(Date.now() + 10_000).catch(() => undefined);
    shape = "";
    const thrownLine = (await webhooksView(one)).log.find((d) => d.state === "failed" && d.id !== line?.id);
    is("a failed read (throw) is given up the same way (.catch(() => null))", [thrownLine?.state, thrownLine?.lastError, received.length], ["failed", "The store could not be found.", 1]);
    server.close();
  }

  part("(c3) The failed-payment email: says costs stopped, but nothing is written down");
  {
    const subscription = (): Record<string, unknown> => {
      const period = paidPeriod(NOW * 1_000);
      return {
        id: SUB, status: "past_due", created: NOW - 90 * 86_400, trial_end: NOW - 76 * 86_400,
        metadata: { store: HANDLE }, customer: { email: OWNER },
        items: { data: [{ current_period_start: period.start, current_period_end: period.end, price: { lookup_key: "nimbus_labs_pro_month", unit_amount: 44900, recurring: { interval: "month" } } }] },
        latest_invoice: { id: "in_SfhProof000001", status: "open", amount_due: 44900, hosted_invoice_url: "https://invoice.stripe.com/i/acct_x/test_unpaid", next_payment_attempt: NOW + 3 * 86_400 },
      };
    };
    await setup();
    list = [subscription()];
    const healthy = await sendFailedPlanNotices();
    is("healthy control: one email and the store recorded unpaid", [healthy.sent, ((await storeForEmail(OWNER))!.renewalUnpaidSince ?? 0) > 0], [1, true]);

    await setup();
    list = [subscription()];
    shape = "a number (42)";
    const unknown = await sendFailedPlanNotices();
    shape = "";
    const after = (await storeForEmail(OWNER))!;
    is("unknown handle read: the email still goes, saying what stopped", [unknown.sent, emails[0]?.text.includes(RENEWAL_PAUSED_WORDS)], [1, true]);
    is("but the store is NOT recorded unpaid: costs keep running", [after.renewalUnpaidSince ?? 0, isPaidUp(after), canUse(after, "email")], [0, true, true]);
    const [claim] = await original([["TTL", "nl:remind:failed:in_SfhProof000001"]]);
    is("and the invoice's notice is claimed (90 days): this job never writes it down again", Number(claim) > 80 * 86_400, true);
    await setup();
    list = [subscription()];
    shape = "throw";
    const thrown = await sendFailedPlanNotices();
    shape = "";
    const [kept] = await original([["EXISTS", "nl:remind:failed:in_SfhProof000001"]]);
    is("a failed read (throw): no email, claim given back, tried next run", [thrown.sent, thrown.failed, emails.length, kept], [0, 1, 0, 0]);
  }

  part("(c4) The handle claim: ruled out (SET NX, never this read)");
  {
    await setup();
    shape = "a number (42)";
    const before = injected;
    const other = await claimHandle("sfh-intruder@example.com", HANDLE, "Intruder", "");
    shape = "";
    is("claiming a live store's handle while its read is unknown: refused as taken", other, { ok: false, reason: "taken" });
    is("claimHandle never reads the handle mapping with GET", injected - before, 0);
    is("the store keeps its handle", (await storeForHandle(HANDLE))?.email, OWNER);
    const source = readFileSync("lib/store.ts", "utf8");
    const claim = source.slice(source.indexOf("export async function claimHandle("), source.indexOf("export type CreateResult"));
    is("source: claimHandle takes the handle by SET NX and does not call storeForHandle", [claim.includes('["SET", handleKey(handle), email.toLowerCase(), "NX"]'), claim.includes("storeForHandle")], [true, false]);
  }

  part("(c5) Checkout and other money doors: 404 before any write (source)");
  for (const [file, line] of [
    ["app/api/store/checkout/route.ts", 'if (!store) return new Response("No such store.", { status: 404 });'],
    ["app/api/store/cart/route.ts", 'if (!store) return new Response("No such store.", { status: 404 });'],
    ["app/api/store/tip/route.ts", 'if (!store) return new Response("No such store.", { status: 404 });'],
    ["app/api/store/paypal/checkout/route.ts", 'if (!store) return new Response("No such store.", { status: 404 });'],
    ["app/api/store/paypal/return/route.ts", 'if (!store) return away("/");'],
  ] as const) {
    const source = readFileSync(file, "utf8");
    is(`${file}: null store answers before anything is created or captured`, source.includes(line), true);
  }
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
