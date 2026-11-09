/**
 * One stand-in, on this computer, for the three outside services the site
 * talks to: the database (Upstash, POST /pipeline), Stripe (/v1/…) and the
 * email sender (Resend, POST /emails). See tests/e2e/run.mjs.
 *
 * The database is the same in-memory one the unit tests use
 * (lib/redis-memory.ts), answered over HTTP in Upstash's shape. Stripe's
 * checkout is the smallest thing that lets a purchase be followed end to
 * end: a checkout that is created is at once a paid one, and its address is
 * the site's own way back, as if the buyer had typed a card and returned.
 * Emails are kept in a list for the test to read: an emailed link is how a
 * gift, or a place in a purchase for several people, is opened.
 *
 * It also serves one page that stands for a creator's own website
 * (GET /site?code=…): the code they copied from the studio, pasted into a
 * page on another address, as it would be on their blog.
 */
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function startServices(port) {
  const out = mkdtempSync(join(tmpdir(), "nimbus-e2e-"));
  const bundle = join(out, "redis-memory.mjs");
  await build({ entryPoints: [join(root, "lib/redis-memory.ts")], bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "error" });
  const { MemoryRedis } = await import(pathToFileURL(bundle).href);

  const redis = new MemoryRedis();
  const sessions = new Map();
  const emails = [];
  const coupons = [];
  const unknown = [];
  const adEvents = [];
  const writing = [];
  let counter = 0;
  /** PayPal orders opened here, by id: the amount and the payee asked for. */
  const paypalOrders = new Map();
  let paypalCounter = 0;
  const blobs = new Map();
  const subscriptionUpdates = [];
  let studioObservationReply = null;
  const studioObservationReads = [];
  const portalConfigs = [];
  // Discord: one server, its roles, and who the bot put in it (lib/discord.ts).
  const discordCalls = [];
  /** What was asked of Meta's Graph API, in order. */
  const metaCalls = [];
  const discordMembers = new Set();
  const DISCORD = { server: "910000000000000001", bot: "920000000000000001", botRole: "930000000000000001", members: "930000000000000002", buyer: "940000000000000001" };
  const discordRoles = [
    { id: DISCORD.server, name: "@everyone", color: 0, position: 0, managed: false },
    { id: DISCORD.botRole, name: "Marktmorgen", color: 0, position: 5, managed: true },
    { id: DISCORD.members, name: "Members", color: 3447003, position: 2, managed: false },
  ];
  const firstPauseSub = () => ({
    id: "sub_PauseMember0001",
    object: "subscription",
    status: "active",
    customer: "cus_PauseMember01",
    metadata: { store: "localshop", product: "club" },
    // As Stripe always sends it: a list, empty when none. Without it the discount is not known and the page offers no
    // yearly price (lib/yearly-switch-rules.ts discounted, rule 30).
    discounts: [],
    pause_collection: null,
    items: { data: [{ id: "si_PauseMember01", current_period_end: Math.floor(Date.now() / 1000) + 20 * 86_400, price: { unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
  });
  let pauseSub = {
    id: "sub_PauseMember0001",
    object: "subscription",
    status: "active",
    customer: "cus_PauseMember01",
    metadata: { store: "localshop", product: "club" },
    // As Stripe always sends it: a list, empty when none. Without it the discount is not known and the page offers no
    // yearly price (lib/yearly-switch-rules.ts discounted, rule 30).
    discounts: [],
    pause_collection: null,
    items: { data: [{ id: "si_PauseMember01", current_period_end: Math.floor(Date.now() / 1000) + 20 * 86_400, price: { unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
  };

  const readBytes = (req) =>
    new Promise((done) => {
      const parts = [];
      req.on("data", (chunk) => parts.push(chunk));
      req.on("end", () => done(Buffer.concat(parts)));
    });
  const read = (req) =>
    new Promise((done) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => done(raw));
    });
  const json = (res, status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/site") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>A creator's own website</title></head><body style="font-family:sans-serif;padding:24px"><h1>My cooking blog</h1><p>Here is the planner I use every week.</p>${url.searchParams.get("code") ?? ""}</body></html>`);
      }
      if (req.method === "GET" && path === "/fonts/mock.woff2") {
        // The one font file the build is given for every Google font (google-fonts-mock.cjs).
        res.writeHead(200, { "Content-Type": "font/woff2" });
        return res.end(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../node_modules/next/dist/next-devtools/server/font/geist-latin.woff2")));
      }
      // PayPal (lib/paypal-sales.ts, PAYPAL_API_BASE): the partner's token, an
      // order paid into the creator's account, its capture, and a capture read
      // back, as PayPal's Orders and Payments APIs answer them.
      if (path === "/v1/oauth2/token" && req.method === "POST") {
        await read(req);
        return json(res, 200, { access_token: "A21AAlocalpartner", token_type: "Bearer", expires_in: 32400 });
      }
      if (path === "/v2/checkout/orders" && req.method === "POST") {
        const body = JSON.parse(await read(req));
        paypalCounter += 1;
        const id = `5O190127TN3647${String(paypalCounter).padStart(4, "0")}`;
        paypalOrders.set(id, { amount: body.purchase_units?.[0]?.amount ?? {}, payee: body.purchase_units?.[0]?.payee?.merchant_id ?? "" });
        return json(res, 201, { id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" }] });
      }
      const ppCapture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(path)?.[1];
      if (ppCapture && req.method === "POST") {
        await read(req);
        const order = paypalOrders.get(ppCapture);
        if (!order) return json(res, 404, { name: "RESOURCE_NOT_FOUND" });
        return json(res, 201, {
          id: ppCapture,
          status: "COMPLETED",
          payer: { email_address: "paypal.buyer@example.com", payer_id: "QYR5Z8XDVJNXQ" },
          purchase_units: [{ payee: { merchant_id: order.payee }, payments: { captures: [{ id: `3C679366HH${ppCapture.slice(-6)}`, status: "COMPLETED", amount: order.amount }] } }],
        });
      }
      const ppCaptureRead = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(path)?.[1];
      if (ppCaptureRead && req.method === "GET") return json(res, 200, { id: ppCaptureRead, status: "COMPLETED" });
      // The ad platforms a creator sends conversions to from the server
      // (lib/ad-events.ts, ADS_API_BASE): Meta, TikTok, Google Analytics and
      // Pinterest, each answering as it does when it takes an event.
      if (req.method === "POST" && path.startsWith("/ads/")) {
        const [, , host, ...rest] = path.split("/");
        adEvents.push({ host, path: `/${rest.join("/")}`, query: Object.fromEntries(url.searchParams), headers: req.headers, body: JSON.parse(await read(req)) });
        if (host === "www.google-analytics.com") {
          res.statusCode = 204;
          return res.end();
        }
        return json(res, 200, host === "business-api.tiktok.com" ? { code: 0, message: "OK" } : { events_received: 1 });
      }
      // The file store (Vercel Blob), for what the server writes and deletes
      // itself: kept in memory. Reading a private file back goes to the
      // store's own host, which this does not stand in for.
      if (path.startsWith("/blob-api")) {
        if (req.method === "PUT") {
          const pathname = url.searchParams.get("pathname") ?? path.replace(/^\/blob-api\/?/, "");
          const bytes = await readBytes(req);
          blobs.set(pathname, bytes);
          return json(res, 200, { url: `https://localstore.private.blob.vercel-storage.com/${pathname}`, downloadUrl: "", pathname, contentType: req.headers["x-content-type"] ?? "application/octet-stream", contentDisposition: "inline" });
        }
        if (req.method === "POST" && path.endsWith("/delete")) {
          await read(req);
          return json(res, 200, {});
        }
        return json(res, 404, { error: { code: "not_found", message: "no such file here" } });
      }
      // Meta (lib/meta-ads.ts, META_GRAPH_BASE): its consent page agrees at once and sends the
      // person back; the Graph API answers for one person with one ad account in dollars.
      if (path === "/meta/dialog/oauth") {
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", url.searchParams.get("scope") === "ads_read" ? "code-meta" : "code-wrong");
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        res.writeHead(302, { Location: back.toString() });
        return res.end();
      }
      if (/^\/v\d+\.\d\//.test(path)) {
        const api = path.replace(/^\/v\d+\.\d/, "");
        const method = req.method ?? "GET";
        metaCalls.push(`${method} ${api}`);
        if (api === "/oauth/access_token") {
          if (url.searchParams.get("grant_type") === "fb_exchange_token") return json(res, 200, { access_token: "EAAlocallong", token_type: "bearer", expires_in: 5184000 });
          return url.searchParams.get("code") === "code-meta" ? json(res, 200, { access_token: "EAAlocalshort" }) : json(res, 400, { error: { code: 100, message: "Invalid verification code" } });
        }
        if (api === "/me/permissions" && method === "DELETE") return json(res, 200, { success: true });
        if (api === "/me/permissions") return json(res, 200, { data: [{ permission: "ads_read", status: "granted" }] });
        if (api === "/me") return json(res, 200, { id: "10150000000000009" });
        if (api === "/me/adaccounts") return json(res, 200, { data: [{ id: "act_555", account_id: "555", name: "Local Ads", currency: "USD", account_status: 1 }] });
        if (api === "/act_555/insights") {
          const day = new Date().toISOString().slice(0, 10);
          return json(res, 200, { data: [
            { campaign_id: "1", campaign_name: "October Reel", spend: "30.00", date_start: day, publisher_platform: "instagram" },
            { campaign_id: "1", campaign_name: "October Reel", spend: "12.00", date_start: day, publisher_platform: "facebook" },
          ] });
        }
        return json(res, 404, { error: { code: 803, message: "unknown" } });
      }
      // Discord's own page agrees at once and sends the person back; its API answers for one server.
      if (path === "/discord/oauth2/authorize") {
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        const install = (url.searchParams.get("scope") ?? "").split(" ").includes("bot");
        back.searchParams.set("code", install ? "code-install" : "code-join");
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        if (install) back.searchParams.set("guild_id", DISCORD.server);
        res.writeHead(302, { Location: back.toString() });
        return res.end();
      }
      if (path.startsWith("/discord/api/v10/")) {
        const api = path.slice("/discord/api/v10".length);
        const method = req.method ?? "GET";
        const body = method === "GET" || method === "DELETE" ? "" : await read(req);
        discordCalls.push(`${method} ${api}`);
        const bearer = String(req.headers.authorization ?? "").startsWith("Bearer ");
        if (method === "POST" && api === "/oauth2/token") {
          const code = new URLSearchParams(body).get("code");
          return json(res, 200, code === "code-install" ? { access_token: "a-install", guild: { id: DISCORD.server, name: "Fresh Kitchen Club" } } : { access_token: "a-join" });
        }
        if (method === "GET" && api === "/users/@me") return json(res, 200, bearer ? { id: DISCORD.buyer, username: "buyer", global_name: "Buyer" } : { id: DISCORD.bot, username: "Marktmorgen" });
        if (method === "GET" && api === `/guilds/${DISCORD.server}`) return json(res, 200, { id: DISCORD.server, name: "Fresh Kitchen Club" });
        if (method === "GET" && api === `/guilds/${DISCORD.server}/roles`) return json(res, 200, discordRoles);
        if (method === "GET" && api === `/guilds/${DISCORD.server}/members/${DISCORD.bot}`) return json(res, 200, { roles: [DISCORD.botRole] });
        if (method === "POST" && api === `/guilds/${DISCORD.server}/roles`) {
          const role = { id: `9300000000000000${10 + discordRoles.length}`, name: JSON.parse(body).name, color: 0, position: 1, managed: false };
          discordRoles.push(role);
          return json(res, 200, role);
        }
        const member = api.match(/^\/guilds\/\d+\/members\/(\d+)$/);
        if (member && method === "PUT") {
          const fresh = !discordMembers.has(member[1]);
          discordMembers.add(member[1]);
          if (fresh) return json(res, 201, { user: { id: member[1] } });
          res.writeHead(204);
          return res.end();
        }
        if (/^\/guilds\/\d+\/members\/\d+(\/roles\/\d+)?$/.test(api) || /^\/users\/@me\/guilds\/\d+$/.test(api)) {
          res.writeHead(204);
          return res.end();
        }
        return json(res, 404, { message: "Unknown", code: 0 });
      }
      if (req.method === "POST" && path === "/pipeline") {
        const results = [];
        for (const command of JSON.parse(await read(req))) {
          try {
            results.push({ result: (await redis.pipeline([command]))[0] });
          } catch (error) {
            results.push({ error: String(error?.message ?? error) });
          }
        }
        return json(res, 200, results);
      }
      if (req.method === "POST" && path === "/v1/messages") {
        // The writing model: a page's words "translated" by being written in
        // capitals, anything else answered with one plain line.
        const body = JSON.parse(await read(req));
        writing.push(body);
        const system = String(body.system ?? "");
        const text = system.startsWith("You translate the words")
          ? JSON.stringify({ t: JSON.parse(body.messages[0].content).map((s) => String(s).toUpperCase()) })
          : system.startsWith("You write three short posts")
            ? JSON.stringify({ x: "Ten short lessons on knife skills.", instagram: "Ten short lessons.\n\nThe link is in my bio.", linkedin: "I put ten short lessons together." })
          : system.startsWith("You draft the creator's public reply")
            ? JSON.stringify({ reply: "Thank you for baking along, and for saying so." })
          : system.startsWith("A visitor on a creator's store page")
            ? JSON.stringify(
                /moon/i.test(String(body.messages[0].content).split("What the visitor is looking for:").pop() ?? "")
                  ? { picks: [] }
                  : { picks: [{ n: 1, why: "It fits a busy week at home." }, { n: 2, why: "It goes well with it." }] },
              )
          : system.startsWith("You draft the questions and answers on a creator's store page")
            ? JSON.stringify({ items: [{ q: "How do the files arrive?", a: "As a download right after paying, and by email." }, { q: "How do I pay?", a: "With a card on a secure payment page." }] })
          : system.startsWith("Put the user's question into plain English")
            ? "What file can I sell, and how big?"
          : system.startsWith("You answer a creator's question about their own online store's numbers")
            ? (() => {
                // An answer that names one figure from the numbers it was handed, and one made up (lib/numbers-ask.ts drops it).
                const prompt = String(body.messages?.[0]?.content ?? "");
                const numbers = JSON.parse(prompt.slice(prompt.indexOf("{")));
                const visitors = numbers.last_30_days?.visitors ?? 0;
                return JSON.stringify({ answer: `You had ${visitors} visitors in the last 30 days.`, used: [{ label: "Visitors", value: String(visitors) }, { label: "Made up", value: "$123,456.00" }], window: "d30", section: "channels" });
              })()
          : system.startsWith("You sort what an online store's customers wrote")
            ? JSON.stringify({ themes: [{ title: "Wants it in another format", ids: [1, 2] }, { title: "Made up from 3 texts", ids: [3, 4] }] })
          : system.startsWith("You answer a creator's question about using Marktmorgen")
            ? JSON.stringify({ answer: "Up to 5 GB, in the formats the help center lists.", used: [1] })
          : system.startsWith("You draft the first version of a creator's store")
            ? JSON.stringify({ bios: ["Weeknight dinners for busy parents.", "Cook once, eat all week."], products: [{ title: "Sunday Meal Planner", summary: "A week of dinners planned on one page.", kind: "download", price: "12" }, { title: "Monthly Menu Club", summary: "A new menu every month.", kind: "membership", price: "7" }], faq: [{ q: "How do I get the planner?", a: "As a download right after paying." }] })
          : system.startsWith("You write the short introduction at the top of a creator's media kit")
            ? JSON.stringify({ pitches: ["I cook weeknight dinners for busy families, and they cook along.", "Recipes for home cooks who plan the week ahead."] })
          : /emails that go out by themselves, one after another/.test(system)
            ? JSON.stringify({
                emails: [
                  { waitDays: 0, subject: "Welcome to the kitchen", body: "Hello, and thank you for joining.\n\nI write about weeknight dinners.\n\nAna" },
                  { waitDays: 2, subject: "One trick for busy nights", body: "Cook the grains on Sunday.\n\nA free guide: https://elsewhere.example/guide\n\nAna" },
                  { waitDays: 3, subject: "What I made for you", body: "Everything I sell is here.\n\nAna" },
                ],
              })
          : system.startsWith("You write a short quiz")
            ? JSON.stringify({
                questions: [
                  { text: "What goes into a starter?", choices: ["Flour and water", "Sugar and milk", "Salt and oil"], correct: [0], explanation: "The lesson mixes equal weights of flour and water." },
                  { text: "How often is it fed?", choices: ["Every day", "Every week", "Every month"], correct: [0], explanation: "The lesson feeds it every day." },
                  { text: "When is it ready?", choices: ["When it doubles", "When it turns blue", "When it dries out"], correct: [0], explanation: "The lesson waits until it doubles." },
                ],
              })
          : system.startsWith("You write the one line")
            ? JSON.stringify({ lines: ["Weeknight dinners for busy families.", "Recipes and planners for home cooks.", "Cook once, eat all week."] })
            : "A plain line.";
        return json(res, 200, { content: [{ type: "text", text }] });
      }
      if (req.method === "POST" && path === "/emails") {
        emails.push(JSON.parse(await read(req)));
        return json(res, 200, { id: `email_${emails.length}` });
      }
      // Several at once, as an import's emails go (lib/email.ts, sendBatch): each kept as one.
      if (req.method === "POST" && path === "/emails/batch") {
        const batch = JSON.parse(await read(req));
        const ids = [];
        for (const one of Array.isArray(batch) ? batch : []) {
          emails.push(one);
          ids.push({ id: `email_${emails.length}` });
        }
        return json(res, 200, { data: ids });
      }
      if (req.method === "POST" && path === "/v1/checkout/sessions") {
        const body = new URLSearchParams(await read(req));
        const metadata = {};
        const lines = new Map();
        for (const [key, value] of body) {
          const meta = key.match(/^metadata\[(.+)\]$/);
          if (meta) metadata[meta[1]] = value;
          const line = key.match(/^line_items\[(\d+)\]\[(quantity)\]$/) ?? key.match(/^line_items\[(\d+)\]\[price_data\]\[(unit_amount)\]$/);
          if (line) lines.set(line[1], { ...(lines.get(line[1]) ?? {}), [line[2]]: Number(value) });
        }
        let amount = 0;
        for (const line of lines.values()) amount += (line.unit_amount ?? 0) * (line.quantity ?? 1);
        // A subscription whose first charge is put off is paid nothing at checkout, as on Stripe.
        const trialEnd = body.get("subscription_data[trial_end]");
        if (trialEnd || body.get("subscription_data[trial_period_days]")) amount = 0;
        // A coupon that takes a set amount off, as an introductory price does, is taken off the first payment.
        const applied = coupons.find((c) => c.id && c.id === body.get("discounts[0][coupon]"));
        const before = amount;
        if (applied?.amount_off) amount = Math.max(0, amount - Number(applied.amount_off));
        counter += 1;
        const id = `cs_test_local${String(counter).padStart(20, "0")}`;
        sessions.set(id, {
          id,
          object: "checkout.session",
          status: "complete",
          payment_status: "paid",
          mode: body.get("mode") ?? "payment",
          created: Math.floor(Date.now() / 1000),
          amount_total: amount,
          amount_subtotal: before,
          // What the coupon took off, as Stripe records it on the checkout (lib/discount-impact.ts).
          total_details: { amount_discount: before - amount, amount_tax: 0, amount_shipping: 0 },
          currency: body.get("line_items[0][price_data][currency]") ?? "usd",
          payment_intent: `pi_local${String(counter).padStart(16, "0")}`,
          metadata,
          // The phone, as Stripe's own phone box would have taken it, only where it was asked for.
          customer_details: { email: body.get("customer_email") ?? "buyer@example.com", ...(body.get("phone_number_collection[enabled]") === "true" ? { phone: ("+" + "15125550142") } : {}) },
          // The address Stripe's own page would have taken, where one was asked for (lib/shipping.ts).
          ...(body.get("shipping_address_collection[allowed_countries][0]")
            ? { collected_information: { shipping_details: { name: "Ana Souza", address: { line1: "1 Main St", line2: null, city: "Austin", state: "TX", postal_code: "78701", country: "US" } } }, shipping_cost: { amount_total: Number(body.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]") ?? 0) } }
            : {}),
          customer_email: null,
          // What a real checkout would take off, kept for the test to read.
          discount_coupon: body.get("discounts[0][coupon]"),
          // And when its first charge was put off to, for a membership that moved here.
          trial_end: trialEnd,
          // And the language Stripe's page was asked to speak.
          locale: body.get("locale"),
          subscription: null,
          customer: null,
        });
        return json(res, 200, { id, url: (body.get("success_url") ?? "").replace("{CHECKOUT_SESSION_ID}", id) });
      }
      if (req.method === "POST" && path === "/v1/coupons") {
        const body = new URLSearchParams(await read(req));
        coupons.push(Object.fromEntries(body));
        return json(res, 200, { id: body.get("id") ?? `coupon_${coupons.length}`, object: "coupon", percent_off: Number(body.get("percent_off")) });
      }
      const one = path.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/);
      if (req.method === "GET" && one) {
        const session = sessions.get(one[1]);
        if (!session) return json(res, 404, { error: { type: "invalid_request_error", message: "No such checkout.session" } });
        const whole = url.searchParams.getAll("expand[]").some((name) => name.startsWith("payment_intent"));
        const intent = { id: session.payment_intent, status: "succeeded", latest_charge: { id: "ch_local", refunded: false, amount_refunded: 0, payment_method_details: { type: "card", card: { brand: "visa" } } } };
        return json(res, 200, whole ? { ...session, payment_intent: intent } : session);
      }
      if (req.method === "GET" && path === "/v1/checkout/sessions") {
        const email = url.searchParams.get("customer_details[email]");
        return json(res, 200, { object: "list", data: [...sessions.values()].filter((s) => !email || s.customer_details.email === email), has_more: false });
      }
      // Everything else Stripe is asked for while a page is drawn is a list with nothing on it.
      // The connected account, as a reminder's switch reads its country (lib/checkout-recovery.ts).
      if (req.method === "GET" && path === "/v1/account") return json(res, 200, { id: "acct_fixture005", object: "account", country: "IE" });
      // A membership of the local store renewed yesterday, on the creator's own account, as Stripe lists paid invoices:
      // paid on Stripe's third try, so "Payments that failed and came back" counts it (lib/payment-recovery-report.ts).
      if (req.method === "GET" && path === "/v1/invoices" && req.headers["stripe-account"] && new URL(req.url, "http://x").searchParams.get("status") === "paid") {
        return json(res, 200, {
          object: "list",
          has_more: false,
          data: [{ id: "in_local_renewal_0001", object: "invoice", status: "paid", billing_reason: "subscription_cycle", amount_paid: 2000, currency: "usd", created: Math.floor(Date.now() / 1000) - 86_400, attempt_count: 3, status_transitions: { paid_at: Math.floor(Date.now() / 1000) - 86_400 }, subscription_details: { metadata: { store: "localshop", product: "club" } } }],
        });
      }
      // One member of the local store, on the creator's own account, who pauses and comes back (lib/membership-pause.ts).
      if (req.method === "GET" && path === "/v1/customers" && url.searchParams.get("email") === "pause.member@example.com") {
        return json(res, 200, { object: "list", has_more: false, data: [{ id: "cus_PauseMember01", object: "customer" }] });
      }
      if (req.method === "GET" && path === "/v1/subscriptions/sub_StudioObservation01" && !req.headers["stripe-account"]) {
        studioObservationReads.push(path);
        return json(res, 200, studioObservationReply);
      }
      if (req.method === "GET" && path === "/v1/customers/cus_PauseMember01") return json(res, 200, { id: "cus_PauseMember01", object: "customer", email: "pause.member@example.com" });
      if (req.method === "GET" && path === "/v1/subscriptions" && url.searchParams.get("customer") === "cus_PauseMember01") {
        return json(res, 200, { object: "list", has_more: false, data: [pauseSub] });
      }
      // Stripe's own page for a member, as a cancel opens it (lib/membership-manage.ts).
      if (req.method === "POST" && path === "/v1/billing_portal/configurations") {
        portalConfigs.push(Object.fromEntries(new URLSearchParams(await read(req))));
        return json(res, 200, { id: `bpc_LocalPortal${String(portalConfigs.length).padStart(4, "0")}`, object: "billing_portal.configuration" });
      }
      if (req.method === "POST" && path === "/v1/billing_portal/sessions") {
        return json(res, 200, { id: "bps_LocalPortal0001", object: "billing_portal.session", url: "https://billing.stripe.com/p/session/test_local" });
      }
      // A move to the same membership's yearly price (lib/yearly-switch.ts): the price made
      // for it, and Stripe's preview, the month's unused part back and the year from now.
      if (req.method === "POST" && path === "/v1/prices" && req.headers["stripe-account"]) {
        await read(req);
        return json(res, 200, { id: "price_LocalYearly0001", object: "price" });
      }
      if (req.method === "POST" && path === "/v1/invoices/create_preview" && req.headers["stripe-account"]) {
        const at = Number(new URLSearchParams(await read(req)).get("subscription_details[proration_date]"));
        return json(res, 200, {
          object: "invoice",
          currency: "usd",
          starting_balance: 0,
          lines: { data: [
            { amount: -667, parent: { subscription_item_details: { proration: true } }, period: { start: at } },
            { amount: 20000, parent: { subscription_item_details: { proration: false } }, period: { start: at } },
          ] },
        });
      }
      if (req.method === "POST" && path === "/v1/subscriptions/sub_PauseMember0001") {
        const body = new URLSearchParams(await read(req));
        subscriptionUpdates.push(Object.fromEntries(body));
        if (body.get("items[0][price]")) {
          return json(res, 200, { ...pauseSub, pending_update: null, latest_invoice: { id: "in_LocalYearly0001", status: "paid", total: 19333, amount_paid: 19333, currency: "usd" } });
        }
        const metadata = { ...pauseSub.metadata };
        for (const [key, value] of body) {
          const field = key.match(/^metadata\[(.+)\]$/);
          if (field) metadata[field[1]] = value;
        }
        pauseSub = {
          ...pauseSub,
          metadata,
          pause_collection: body.has("pause_collection") ? null : body.get("pause_collection[resumes_at]") ? { behavior: "void", resumes_at: Number(body.get("pause_collection[resumes_at]")) } : pauseSub.pause_collection,
        };
        return json(res, 200, pauseSub);
      }
      // The local store's memberships, as the membership numbers read them (lib/membership-numbers.ts):
      // seven paying, two who canceled on Stripe's page and said why, one ended by a payment that failed.
      if (req.method === "GET" && path === "/v1/subscriptions" && url.searchParams.get("status") === "all" && !url.searchParams.get("customer") && req.headers["stripe-account"]) {
        const now = Math.floor(Date.now() / 1000);
        const day = 86_400;
        const member = (id, over = {}) => ({
          id,
          object: "subscription",
          status: "active",
          currency: "usd",
          start_date: now - 120 * day,
          ended_at: null,
          trial_end: null,
          canceled_at: null,
          cancellation_details: { reason: null, feedback: null, comment: null },
          metadata: { store: "localshop", product: "club", channel: "instagram" },
          items: { data: [{ quantity: 1, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] },
          // As the member scores read it, with the address (lib/member-health.ts).
          customer: { id: `cus_${id.slice(-4)}`, object: "customer", email: `member${id.slice(-4)}@example.com` },
          ...over,
        });
        return json(res, 200, {
          object: "list",
          has_more: false,
          data: [
            ...[1, 2, 3, 4, 5, 6].map((n) => member(`sub_LocalMember000${n}`)),
            member("sub_LocalMember0007", { start_date: now - 20 * day }),
            member("sub_LocalMember0008", { status: "canceled", canceled_at: now - 10 * day, ended_at: now - 3 * day, cancellation_details: { reason: "cancellation_requested", feedback: "too_expensive", comment: "Love it, but money is tight this month." } }),
            member("sub_LocalMember0009", { status: "canceled", canceled_at: now - 5 * day, ended_at: now - 2 * day, cancellation_details: { reason: "cancellation_requested", feedback: "unused", comment: null } }),
            member("sub_LocalMember0010", { status: "canceled", canceled_at: now - 8 * day, ended_at: now - 8 * day, cancellation_details: { reason: "payment_failed", feedback: null, comment: null } }),
          ],
        });
      }
      if (req.method === "GET" && path.startsWith("/v1/")) return json(res, 200, { object: "list", data: [], has_more: false });
      unknown.push(`${req.method} ${path}`);
      return json(res, 404, { error: { type: "invalid_request_error", message: `no stand-in for ${req.method} ${path}` } });
    } catch (error) {
      unknown.push(`${req.method} ${path}: ${error}`);
      return json(res, 500, { error: { message: String(error) } });
    }
  });
  await new Promise((ready) => server.listen(port, "127.0.0.1", ready));
  return {
    emails: () => [...emails],
    checkouts: () => [...sessions.values()],
    /** Local-only fulfillment row; no checkout or payment is submitted. */
    seedShipment: (handle,product) => {
      const id="cs_test_shipmentproof000001";
      sessions.set(id,{id,object:"checkout.session",status:"complete",payment_status:"paid",livemode:true,amount_total:1000,currency:"usd",created:Math.floor(Date.now()/1000),metadata:{store:handle,product,title:"Synthetic shipment",ship:"yes"},customer_details:{email:"shipment-buyer@example.test"},collected_information:{shipping_details:{name:"Synthetic buyer",address:{line1:"1 Synthetic Street",city:"Example City",state:"NY",postal_code:"10001",country:"US"}}}});
      return id;
    },
    /** Local-only synthetic list evidence, added after unrelated checkout assertions. */
    seedPathGrowth: (handle,product) => {
      for(let n=1;n<=2;n++){
        const id="cs_live_pathgrowth00000"+n;
        sessions.set(id,{id,object:"checkout.session",status:"complete",payment_status:"paid",livemode:true,amount_total:1000,currency:"usd",created:Math.floor(Date.now()/1000)-n,payment_intent:"pi_pathgrowth00000"+n,metadata:{store:handle,product},customer_details:{email:"repeat-path@example.test"}});
      }
    },
    coupons: () => [...coupons],
    unknown: () => [...unknown],
    adEvents: () => [...adEvents],
    writing: () => [...writing],
    subscriptionUpdates: () => [...subscriptionUpdates],
    setStudioObservation: (reply) => { studioObservationReply = reply; studioObservationReads.length = 0; },
    studioObservationReads: () => [...studioObservationReads],
    /** The pause member's membership on another product, and back as it was. */
    setPauseProduct: (product) => {
      pauseSub = { ...firstPauseSub(), metadata: { store: "localshop", product } };
    },
    resetPauseSub: () => {
      pauseSub = firstPauseSub();
    },
    portalConfigs: () => [...portalConfigs],
    /** What Discord was asked, and its ids. */
    discord: () => ({ calls: [...discordCalls], members: new Set(discordMembers), ids: DISCORD }),
    meta: () => [...metaCalls],
    /** What was written to the file store, by its path. */
    blobs: () => new Map(blobs),
    /** The database itself, for a test to read or set what only time or many buyers would make. */
    redis: (commands) => redis.pipeline(commands),
    close: () => new Promise((closed) => server.close(closed)),
  };
}
