/**
 * A sign-in link is offered, or emailed, only once Redis said it stored it
 * (rule 24; nothing false shown to a person; no paid email for nothing).
 *
 *   - signInLinkFor (lib/affiliates.ts), behind "Open your numbers" on the
 *     affiliate's page across every store (app/affiliate/page.tsx): a SET that
 *     got no answer, or an answer other than exactly "OK", gives no link, so
 *     the page says the numbers could not be opened instead of offering a link
 *     that lands on "expired";
 *   - requestHubLink (lib/affiliate-hub.ts) and invitePartner
 *     (lib/affiliates.ts) send a paid email carrying the link: with the SET
 *     unconfirmed they send nothing and leave no link behind; invitePartner
 *     answers "error", requestHubLink "sent" as for every address (its work
 *     runs after the answer: tests/hub-link-uniform-reply.test.ts);
 *   - with Redis answering "OK", all three work as before.
 */
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import AffiliateHubPage from "@/app/affiliate/page";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { invitePartner, joinAsBuyer, linkEmail, signInLinkFor } from "@/lib/affiliates";
import { requestHubLink } from "@/lib/affiliate-hub";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { runAfterTasks } from "./next-server-after-world";

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

const sent: { to: string; text: string }[] = [];
const sessions = new Map<string, Record<string, unknown>>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text: string };
    sent.push({ to: [body.to].flat()[0], text: body.text });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  const m = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/);
  const found = m ? sessions.get(m[1]) : undefined;
  return new Response(JSON.stringify(found ?? { error: { message: "No such checkout.session" } }), { status: found ? 200 : 404 });
}) as typeof fetch;

/** Runs `work` with the one-command SET of a key starting with `prefix` answered by `reply`, not applied unless `apply`. */
async function setAnswered<T>(prefix: string, reply: unknown[], work: () => Promise<T>, apply = false): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith(prefix)) {
      // With `apply`, the SET is still made and only its answer is lost.
      if (apply) await original.call(redis, commands);
      return reply;
    }
    return original.call(redis, commands);
  }) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

/** Short, empty, other-shaped and lost answers to a SET: none of them is "stored". */
const ODD: [string, unknown[]][] = [
  ["no reply at all", []],
  ["a null reply", [null]],
  ["an undefined reply", [undefined]],
  ["a reply of another word", ["QUEUED"]],
  ["two replies for one command", ["OK", "OK"]],
];

const storeLinkKey = (token: string) => `nl:aff:link:${createHash("sha256").update(`nimbus-aff-link:${token}`).digest("hex").slice(0, 40)}`;
const hubLinkKey = (token: string) => `nl:affhub:link:${createHash("sha256").update(`nimbus-affhub-link:${token}`).digest("hex").slice(0, 40)}`;
const stored = async (key: string) => (await redis.pipeline([["EXISTS", key]]))[0] === 1;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_hub_only_a_stand_in";
  process.env.STRIPE_SECRET_KEY = "sk_test_hub_only_a_stand_in";
  for (const [email, handle, name, account] of [
    ["one@example.com", "harbor", "Harbor Kitchen", "acct_1TestHarbor0001"],
    ["two@example.com", "lantern", "Lantern Press", "acct_1TestLantern001"],
  ] as const) {
    if (!(await claimHandle(email, handle, name, "")).ok) throw new Error("no store");
    await ensureStoreId(email);
    await ensureStatsId(email);
    await setStripeAccount(email, account, true);
    await setAffiliateSetting(email, { ...NO_AFFILIATES, enabled: true, buyers: true, rates: {} });
  }
  const harbor = (await storeForEmail("one@example.com"))!;
  const lantern = (await storeForEmail("two@example.com"))!;
  for (const [id, handle] of [["cs_test_signharbor001", "harbor"], ["cs_test_signlantern01", "lantern"]] as const) {
    sessions.set(id, {
      id,
      object: "checkout.session",
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      amount_total: 2700,
      currency: "usd",
      created: Math.floor(Date.now() / 1000),
      customer_details: { email: "dana@example.com" },
      metadata: { store: handle, product: "p8w2m4q9zz" },
    });
  }
  if (!(await joinAsBuyer(harbor, "cs_test_signharbor001")).ok || !(await joinAsBuyer(lantern, "cs_test_signlantern01")).ok) throw new Error("not joined");

  part("signInLinkFor: a link only once its SET answered exactly OK");
  const healthy = await signInLinkFor(harbor, "dana@example.com", "https://marktmorgen.com");
  const healthyToken = healthy?.match(/token=([0-9a-f]{64})/)?.[1] ?? "";
  is("control: a link that was stored and opens for Dana", [Boolean(healthyToken), await stored(storeLinkKey(healthyToken)), await linkEmail(harbor, healthyToken)], [true, true, "dana@example.com"]);
  for (const [what, reply] of ODD) {
    is(`${what}: no link`, await setAnswered("nl:aff:link:", reply, () => signInLinkFor(harbor, "dana@example.com", "https://marktmorgen.com")), null);
  }

  part("The page across every store never offers a link that was not stored");
  const ask = async () => {
    // A fresh hour each time, so the counts never answer "limited" here.
    const data = (redis as unknown as { data: Map<string, unknown> }).data;
    for (const key of [...data.keys()]) if (key.startsWith("nl:rl:affhub-")) data.delete(key);
    const before = sent.length;
    const answer = await requestHubLink({ email: "dana@example.com", ip: "203.0.113.9", origin: "https://marktmorgen.com" });
    // The stores, the link and its email run after the answer (lib/after-answer.ts).
    await runAfterTasks();
    return { answer, emails: sent.length - before };
  };
  is("control: the hub link is emailed", await ask(), { answer: "sent", emails: 1 });
  const hubToken = sent.at(-1)?.text.match(/token=([0-9a-f]{64})/)?.[1] ?? "";
  const page = async () => renderToStaticMarkup(await AffiliateHubPage({ searchParams: Promise.resolve({ token: hubToken }) }));
  const offered = (html: string) => [...html.matchAll(/affiliates\?token=([0-9a-f]{64})/g)].map((m) => m[1]);
  const fine = await page();
  is("control: one stored sign-in link per store", [offered(fine).length, (await Promise.all(offered(fine).map((t) => stored(storeLinkKey(t))))).every(Boolean)], [2, true]);
  const lost = await setAnswered("nl:aff:link:", [], page);
  is("with every SET unanswered, no link is offered", offered(lost).length, 0);
  is("and no 'Open your numbers' button", lost.includes("Open your numbers"), false);
  is("the page says the numbers could not be opened, for each store", lost.split("Your numbers could not be opened just now").length - 1, 2);

  part("requestHubLink: no paid email with a link that was not stored");
  for (const [what, reply] of ODD) {
    // Rule 23: was { answer: "error", emails: 0 }. "error" only for an affiliate told a stranger apart (pre-review MÉDIO,
    // lib/affiliate-hub.ts:93); the answer is "sent" for every address now, and still no email goes out.
    is(`${what}: "sent" as for anybody, and no email`, await setAnswered("nl:affhub:link:", reply, ask), { answer: "sent", emails: 0 });
  }
  is("and the stored link the email carries opens the page", await stored(hubLinkKey(hubToken)), true);

  part("invitePartner (rule 30): no paid email with a link that was not stored");
  const invite = async (email: string) => {
    const before = sent.length;
    const answer = await invitePartner({
      store: harbor,
      email,
      share: { percent: 20, products: ["p8w2m4q9zz"] },
      titles: new Map([["p8w2m4q9zz", "Knife Skills"]]),
      origin: "https://marktmorgen.com",
    });
    return { answer, emails: sent.length - before, token: sent.at(-1)?.text.match(/token=([0-9a-f]{64})/)?.[1] ?? "" };
  };
  for (const [what, reply] of ODD) {
    const got = await setAnswered("nl:aff:link:", reply, () => invite("pat@example.com"));
    is(`${what}: "error" and no email`, { answer: got.answer, emails: got.emails }, { answer: "error", emails: 0 });
  }
  const storeLinks = () => [...(redis as unknown as { data: Map<string, unknown> }).data.keys()].filter((k) => k.startsWith("nl:aff:link:")).length;
  for (const [what, reply] of ODD) {
    const before = storeLinks();
    const got = await setAnswered("nl:aff:link:", reply, () => invite("pat@example.com"), true);
    is(`a SET made with ${what}: "error", no email, and the link removed`, { answer: got.answer, emails: got.emails, kept: storeLinks() - before }, { answer: "error", emails: 0, kept: 0 });
  }
  const invited = await invite("pat@example.com");
  is("control: the invitation is emailed with a stored link", [invited.answer, invited.emails, await stored(storeLinkKey(invited.token))], ["sent", 1, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
