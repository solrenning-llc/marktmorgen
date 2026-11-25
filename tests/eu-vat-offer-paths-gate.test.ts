/**
 * EU VAT art. 9a (789 [IV1]; Claude 1 coord's MEDIUM, 6809): the three buttons that open a creator's checkout from an
 * email ask lib/eu-vat-gate.ts consumerGate before anything is counted, marked or sent to Stripe, exactly as the card
 * checkout, PayPal, the tip and the payment request do:
 *   - the welcome offer (app/api/store/welcome/open, lib/welcome-offer-send.ts openWelcome);
 *   - the come-back offer (app/api/store/come-back/open, lib/winback-send.ts openWinBack);
 *   - a member moved from another platform (app/api/store/move/open, lib/move-members.ts openMove).
 * Before, createCheckout ran the gate only from what its caller passed, and these three passed nothing: with sales
 * open, an EU or UK consumer would have paid with no VAT. A paid press from the EU or the UK goes back to its page with
 * "abroad", one with no billing country with "country", and one from outside both opens Stripe's page as before.
 *
 * And every caller of createCheckout in app/ and lib/ asks the gate before it, so a new path cannot slip past it.
 *
 * Synthetic only: Stripe and the email provider are stand-ins; nothing real is reached.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import FreePage from "@/app/[handle]/free/page";
import RenewPage from "@/app/[handle]/renew/[product]/page";
import MovePage from "@/app/[handle]/move/[product]/page";
import { answering } from "./security/next-headers";
import { addOption, addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWelcomeOffer, setWinBack, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { requestCopy } from "@/lib/free";
import { inviteMembers, readInvite } from "@/lib/move-members";
import { REFUSE_CONSUMERS_DRAFTS, REFUSE_CONSUMERS_OPEN } from "@/lib/deemed-supplier-drafts";
import { POST as welcomeRoute } from "@/app/api/store/welcome/open/route";
import { POST as comeBackRoute } from "@/app/api/store/come-back/open/route";
import { POST as moveRoute } from "@/app/api/store/move/open/route";
import { withConsent } from "./digital-consent-fixture";
import { walkCheckoutCallers } from "./checkout-gate-walk";
import { redisPipeline, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_eu_vat_offer_paths_only";
process.env.RESEND_API_KEY = "re_test_welcome_only_a_stand_in";

const DAY = 86_400;
const sent: string[] = [];
const checkouts: URLSearchParams[] = [];
/** Every request to Stripe, of any kind: a refused press asks it nothing. */
let stripeCalls = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    sent.push(String((JSON.parse(String(init?.body)) as { text?: string }).text ?? ""));
    return json({ id: "email_1" });
  }
  stripeCalls += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    const id = `cs_test_${"v".repeat(20)}${checkouts.length}`;
    return json({ id, url: `https://checkout.stripe.com/c/pay/${id}`, expires_at: Math.floor(Date.now() / 1000) + 3600 });
  }
  if (path === "/customers/search") return json({ object: "search_result", data: [], has_more: false, next_page: null });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** A press of a button on one of the pages, as the browser sends it: the form, the IP country Vercel adds. */
const press = (path: string, ip: string | null, fields: Record<string, string>, consent = true) => {
  const form = consent ? withConsent(new FormData()) : new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const headers: Record<string, string> = { host: "marktmorgen.com" };
  if (ip) headers["x-vercel-ip-country"] = ip;
  return new NextRequest(`https://marktmorgen.com${path}`, { method: "POST", body: form, headers });
};

/** Where a press went, and what Stripe was asked for it. */
async function outcome(response: Promise<Response>): Promise<{ status: number; location: string; stripe: number; checkouts: number }> {
  const calls = stripeCalls;
  const made = checkouts.length;
  const answer = await response;
  return { status: answer.status, location: answer.headers.get("location") ?? "", stripe: stripeCalls - calls, checkouts: checkouts.length - made };
}

/** A page as the server draws it, for the address it was asked at. */
async function drawn(url: string, page: () => Promise<React.ReactElement>): Promise<string> {
  answering(new NextRequest(url));
  const stream = await renderToReadableStream(await page(), { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

/** What the billing-country field shows: the country put back, and whether it is tied to the notice that says why. */
function field(markup: string, id: string, notice: string): { chosen: string | null; invalid: boolean; noticeThere: boolean } {
  const select = new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(markup);
  const tag = select ? select[0].slice(0, select[0].indexOf(">") + 1) : "";
  return {
    chosen: /<option[^>]*value="([A-Z]{2})"[^>]*selected=""/.exec(select?.[1] ?? "")?.[1] ?? null,
    invalid: /aria-invalid="true"/.test(tag) && tag.includes(`aria-describedby="${notice}"`),
    noticeThere: markup.includes(`id="${notice}"`),
  };
}

/** Every .ts and .tsx file under a folder. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

async function main(): Promise<void> {
  redis.clear();

  part("The welcome offer's button (app/api/store/welcome/open)");
  {
    const owner = "vat-welcome@example.com";
    const shop = "vatwelcome";
    await claimHandle(owner, shop, "Welcome Kitchen", "");
    await ensureStatsId(owner);
    await setStripeAccount(owner, "acct_1TestVatWelcome", true);
    await setSubscription(owner, { customerId: "cus_VatWelcome01", subscriptionId: "sub_VatWelcome01", active: true, period: paidPeriod() });
    const free = await addProduct(owner, "Pantry Guide", "", "0", null);
    const paid = await addProduct(owner, "Knife Skills", "", "49", null);
    if (!free.ok || !paid.ok) throw new Error("no products");
    for (const made of [free, paid]) await setProductLink(owner, made.product.id, "https://example.com/file");
    await setWelcomeOffer(owner, { product: paid.product.id, percent: 25, hours: 48, coupon: "c_welcome25", remind: false, address: "1 Main St, Springfield, IL 62701" });
    const store = (await storeForEmail(owner))!;
    const copy = await requestCopy({ store, product: (await readListing(store, free.product.id))!, email: "lead@example.com", consent: true, ip: "10.0.2.1", origin: "https://marktmorgen.com" });
    if (copy !== "sent") throw new Error(`no copy: ${copy}`);
    const token = /token=([0-9a-f]{64})/.exec(sent.at(-1) ?? "")?.[1] ?? "";
    if (!token) throw new Error("no welcome token");
    const page = (status: string) => `https://marktmorgen.com/@${shop}/free?token=${token}&welcome=${status}`;
    const welcome = (ip: string | null, fields: Record<string, string> = {}) => outcome(welcomeRoute(press("/api/store/welcome/open", ip, { handle: shop, token, ...fields })));

    is("an EU buyer: back to the page with abroad, nothing asked of Stripe", await welcome("DE", { billing_country: "DE" }), { status: 303, location: page("abroad"), stripe: 0, checkouts: 0 });
    is("a UK buyer by billing country alone: abroad", await welcome(null, { billing_country: "GB" }), { status: 303, location: page("abroad"), stripe: 0, checkouts: 0 });
    is("a VPN outside with an EU billing country: abroad", await welcome("US", { billing_country: "FR" }), { status: 303, location: page("abroad"), stripe: 0, checkouts: 0 });
    is("no billing country: asked for it, nothing asked of Stripe", await welcome("US"), { status: 303, location: page("country"), stripe: 0, checkouts: 0 });
    const opened = await welcome("US", { billing_country: "US" });
    is("outside both: Stripe's page opens, as before", [opened.status, opened.location.startsWith("https://checkout.stripe.com/"), opened.checkouts], [303, true, 1]);
    // A press refused for another reason keeps the country it named (WCAG 3.3.7); one refused for where the buyer is never does.
    is("refused for the box to start at once: back with the country named, to put back in the field", await outcome(welcomeRoute(press("/api/store/welcome/open", "US", { handle: shop, token, billing_country: "US" }, false))), { status: 303, location: `${page("consent")}&from=US`, stripe: 0, checkouts: 0 });
    const freePage = (query: Record<string, string>) => drawn(`https://marktmorgen.com/@${shop}/free`, () => FreePage({ params: Promise.resolve({ handle: `@${shop}` }), searchParams: Promise.resolve({ token, ...query }) }));
    is("the page puts the country back after that refusal (WCAG 3.3.7)", field(await freePage({ welcome: "consent", from: "US" }), "bc-welcome", "welcome-country-problem"), { chosen: "US", invalid: false, noticeThere: false });
    is("after abroad: no country put back, the field tied to the notice (WCAG 3.3.1)", field(await freePage({ welcome: "abroad" }), "bc-welcome", "welcome-country-problem"), { chosen: null, invalid: true, noticeThere: true });
  }

  part("The come-back offer's button (app/api/store/come-back/open)");
  {
    const owner = "vat-comeback@example.com";
    const shop = "vatcomeback";
    await claimHandle(owner, shop, "Harbor Club", "");
    await ensureStatsId(owner);
    await setStripeAccount(owner, "acct_1TestVatBack001", true);
    await setSubscription(owner, { customerId: "cus_VatBack0001", subscriptionId: "sub_VatBack0001", active: true, tier: "pro", period: paidPeriod() });
    const club = await addProduct(owner, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
    if (!club.ok) throw new Error("no product");
    const product = club.product.id;
    await setProductLink(owner, product, "https://example.com/club");
    await setWinBack(owner, { percent: 25, months: 2, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
    const statsId = (await storeForEmail(owner))!.statsId as string;
    /** A come-back link as the daily run keeps it (lib/winback-send.ts): a fresh one for each press. */
    const link = async () => {
      const token = Math.random().toString(16).slice(2).padEnd(40, "0").slice(0, 40);
      await redisPipeline([["SET", `nl:wb:link:${token}`, JSON.stringify({ s: statsId, e: "back@example.com", p: product, o: "", c: "co_Back0001", pc: 25, m: 2 }), "EX", 14 * DAY]]);
      return token;
    };
    const comeBack = async (ip: string | null, fields: Record<string, string> = {}) => {
      const token = await link();
      const page = (status: string) => `https://marktmorgen.com/@${shop}/renew/${product}?back=${token}&status=${status}`;
      return { page, result: await outcome(comeBackRoute(press("/api/store/come-back/open", ip, { handle: shop, product, back: token, ...fields }))) };
    };

    let asked = await comeBack("DE", { billing_country: "DE" });
    is("an EU buyer: back to the page with abroad, nothing asked of Stripe", asked.result, { status: 303, location: asked.page("abroad"), stripe: 0, checkouts: 0 });
    asked = await comeBack(null, { billing_country: "GB" });
    is("a UK buyer by billing country alone: abroad", asked.result, { status: 303, location: asked.page("abroad"), stripe: 0, checkouts: 0 });
    asked = await comeBack("US");
    is("no billing country (the button's form had no field for it): asked for it, nothing asked of Stripe", asked.result, { status: 303, location: asked.page("country"), stripe: 0, checkouts: 0 });
    asked = await comeBack("US", { billing_country: "US" });
    is("outside both: Stripe's page opens, as before", [asked.result.status, asked.result.location.startsWith("https://checkout.stripe.com/"), asked.result.checkouts], [303, true, 1]);
    const unconsented = await (async () => {
      const token = await link();
      return { page: `https://marktmorgen.com/@${shop}/renew/${product}?back=${token}&status=consent&from=US`, result: await outcome(comeBackRoute(press("/api/store/come-back/open", "US", { handle: shop, product, back: token, billing_country: "US" }, false))) };
    })();
    is("refused for the box to start at once: back with the country named, to put back in the field", [unconsented.result.status, unconsented.result.location], [303, unconsented.page]);
    const renewPage = async (query: Record<string, string>) => drawn(`https://marktmorgen.com/@${shop}/renew/${product}`, async () => RenewPage({ params: Promise.resolve({ handle: `@${shop}`, product }), searchParams: Promise.resolve({ back: await link(), ...query }) }));
    is("the page puts the country back after that refusal (WCAG 3.3.7)", field(await renewPage({ status: "consent", from: "US" }), `bc-back-${product}`, `back-country-problem-${product}`), { chosen: "US", invalid: false, noticeThere: false });
    is("after abroad: no country put back, the field tied to the notice (WCAG 3.3.1)", field(await renewPage({ status: "abroad" }), `bc-back-${product}`, `back-country-problem-${product}`), { chosen: null, invalid: true, noticeThere: true });
  }

  part("A moved member's button (app/api/store/move/open)");
  {
    const owner = "vat-move@example.com";
    const shop = "vatmove";
    await claimHandle(owner, shop, "Move Club", "");
    await ensureStatsId(owner);
    await setStripeAccount(owner, "acct_1TestVatMove001", true);
    await setSubscription(owner, { customerId: "cus_VatMove0001", subscriptionId: "sub_VatMove0001", active: true, period: paidPeriod() });
    const club = await addProduct(owner, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
    if (!club.ok) throw new Error("no product");
    const product = club.product.id;
    await addOption(owner, product, "Basic", "19");
    let store = (await storeForEmail(owner))!;
    const [basic] = (await readProduct(store, product))!.options.map((o) => o.id);
    await setProductLink(owner, basic, "https://example.com/basic");
    store = (await storeForEmail(owner))!;
    const people = ["ada", "ben", "cy", "dee"];
    const nowS = Math.floor(Date.now() / 1000);
    const fields = await inviteMembers(store, "job_vatmove", people.map((name) => ({ email: `${name}@example.com`, productId: product, option: basic, renews: nowS + 20 * DAY })));
    if (!fields.every((field): field is string => typeof field === "string")) throw new Error("not invited");
    const tokens = await Promise.all(fields.map(async (field) => (await readInvite(store.statsId!, field))!.t));
    const move = (name: string, ip: string | null, fields: Record<string, string> = {}) => {
      const token = tokens[people.indexOf(name)];
      const page = (status: string) => `https://marktmorgen.com/@${shop}/move/${product}?k=${encodeURIComponent(token)}&status=${status}`;
      return outcome(moveRoute(press("/api/store/move/open", ip, { handle: shop, product, k: token, ...fields }))).then((result) => ({ page, result }));
    };

    let asked = await move("ada", "DE", { billing_country: "DE" });
    is("an EU buyer: back to the page with abroad, nothing asked of Stripe", asked.result, { status: 303, location: asked.page("abroad"), stripe: 0, checkouts: 0 });
    asked = await move("ben", null, { billing_country: "GB" });
    is("a UK buyer by billing country alone: abroad", asked.result, { status: 303, location: asked.page("abroad"), stripe: 0, checkouts: 0 });
    asked = await move("cy", "US");
    is("no billing country: asked for it, nothing asked of Stripe", asked.result, { status: 303, location: asked.page("country"), stripe: 0, checkouts: 0 });
    asked = await move("dee", "US", { billing_country: "US" });
    is("outside both: Stripe's page opens, as before", [asked.result.status, asked.result.location.startsWith("https://checkout.stripe.com/"), asked.result.checkouts], [303, true, 1]);
    const ada = tokens[people.indexOf("ada")];
    is("refused for the box to start at once: back with the country named, to put back in the field", (await outcome(moveRoute(press("/api/store/move/open", "US", { handle: shop, product, k: ada, billing_country: "US" }, false)))).location, `https://marktmorgen.com/@${shop}/move/${product}?k=${encodeURIComponent(ada)}&status=consent&from=US`);
    const movePage = (query: Record<string, string>) => drawn(`https://marktmorgen.com/@${shop}/move/${product}`, () => MovePage({ params: Promise.resolve({ handle: `@${shop}`, product }), searchParams: Promise.resolve({ k: tokens[people.indexOf("ben")], ...query }) }));
    is("the page puts the country back after that refusal (WCAG 3.3.7)", field(await movePage({ status: "consent", from: "US" }), `bc-move-${product}`, "move-country-problem"), { chosen: "US", invalid: false, noticeThere: false });
    const abroadMove = await movePage({ status: "abroad" });
    is("after abroad: no country put back, the field tied to the notice, said as an alert (WCAG 3.3.1, 4.1.3)", [field(abroadMove, `bc-move-${product}`, "move-country-problem"), /<div id="move-country-problem"[^>]*role="alert"/.test(abroadMove)], [{ chosen: null, invalid: true, noticeThere: true }, true]);
  }

  part("Every caller of createCheckout asks the EU VAT gate first, in the same function (tests/checkout-gate-walk.ts)");
  {
    const sources = [...files("lib"), ...files("app")].filter((file) => file !== join("lib", "store-checkout.ts")).map((file) => ({ file, source: readFileSync(file, "utf8") }));
    const walked = walkCheckoutCallers(sources);
    is("the callers are found: the card checkout and the three buttons", ["app/api/store/checkout/route.ts", "lib/move-members.ts", "lib/welcome-offer-send.ts", "lib/winback-send.ts"].map((file) => walked.callers.includes(join(...file.split("/")))), [true, true, true, true]);
    is("none calls createCheckout without a gate asked first, its answer used, in the same function", walked.findings, []);

    // The walk itself, on synthetic files: each way past it is named.
    const imports = `import { createCheckout } from "@/lib/store-checkout";\nimport { pressGate } from "@/lib/eu-vat-gate";\n`;
    const named = (source: string) => walkCheckoutCallers([{ file: "lib/synthetic.ts", source: imports + source }]).findings.map((f) => f.why);
    is("control: the gate asked first, its answer used", named(`export async function open(p, e) {\n  const refused = pressGate(p, e);\n  if (refused) return refused;\n  return withHold(() => createCheckout(p));\n}`), []);
    is("the gate in another function does not count", named(`function check(p, e) { return pressGate(p, e); }\nexport async function open(p) { return createCheckout(p); }`).length, 1);
    is("a gate whose answer is thrown away does not count", named(`export async function open(p, e) {\n  pressGate(p, e);\n  return createCheckout(p);\n}`).length, 1);
    is("a gate after the call does not count", named(`export async function open(p, e) {\n  const made = await createCheckout(p);\n  const refused = pressGate(p, e);\n  return refused ? null : made;\n}`).length, 1);
    is("a gate only named in a comment does not count", named(`export async function open(p) {\n  // const refused = pressGate(p, e);\n  return createCheckout(p);\n}`).length, 1);
    is("a call only named in a comment or a string is not a call", named(`export function words() {\n  // createCheckout(p)\n  return "createCheckout(p)";\n}`), []);
    is("an import under another name is named", walkCheckoutCallers([{ file: "lib/synthetic.ts", source: `import { createCheckout as open } from "@/lib/store-checkout";\nexport const x = 1;` }]).findings.map((f) => f.why), ["createCheckout imported as open"]);
    is("createCheckout passed as a value is named", named(`export async function open(p, e) {\n  const refused = pressGate(p, e);\n  return refused ? null : withHold(createCheckout, p);\n}`).length, 1);
    is("a call outside any function is named", named(`export const opened = createCheckout(p);`).length, 1);
    const wrapper = `import { createCheckout } from "@/lib/store-checkout";\nexport async function openUnlessHeld(...args: Parameters<typeof createCheckout>): ReturnType<typeof createCheckout> {\n  return createCheckout(...args);\n}`;
    const user = (gate: string) => `import { openUnlessHeld } from "@/lib/held";\nimport { pressGate } from "@/lib/eu-vat-gate";\nexport async function open(p, e) {\n${gate}  return openUnlessHeld(p);\n}`;
    is("a function that only hands its arguments on is createCheckout under another name: its callers need the gate", walkCheckoutCallers([{ file: "lib/held.ts", source: wrapper }, { file: "lib/user.ts", source: user("") }]).findings.map((f) => f.file), ["lib/user.ts"]);
    is("and with the gate in its caller, nothing is named", walkCheckoutCallers([{ file: "lib/held.ts", source: wrapper }, { file: "lib/user.ts", source: user("  const refused = pressGate(p, e);\n  if (refused) return refused;\n") }]).findings, []);
    for (const draft of REFUSE_CONSUMERS_DRAFTS) {
      is(`${draft.jurisdiction}: the drafts name the buttons' gate and this test`, [draft.implementedIn.includes("lib/eu-vat-gate.ts (pressGate"), draft.evidence.includes("tests/eu-vat-offer-paths-gate.test.ts")], [true, true]);
    }
    is("no path is left open", REFUSE_CONSUMERS_OPEN, []);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
