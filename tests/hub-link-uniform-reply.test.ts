/**
 * "Email me a link" on the affiliate's page across every store
 * (requestHubLink, lib/affiliate-hub.ts) must not tell a stranger whether an
 * address is anybody's affiliate (pre-review of claude5/signin-link-set-exact,
 * MÉDIO at lib/affiliate-hub.ts:93). With the link's SET unconfirmed, or the
 * final send refused, an affiliate used to get "error" while a stranger got
 * "sent". Now the answer is "sent" for every address right after the limits,
 * and the stores, the link and its email run after it (next/server `after`,
 * held here by tests/next-server-after-world.ts): no paid email carries a link
 * Redis did not say it stored, and a link whose email did not go out is
 * removed. The same shape as requestAffiliateLink (claude5/oracle-siblings-2).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { joinAsBuyer } from "@/lib/affiliates";
import { requestHubLink } from "@/lib/affiliate-hub";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { store as redis } from "./redis-stub";
import { afterTasks, runAfterTasks } from "./next-server-after-world";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

const sent: { to: string; text: string }[] = [];
let resendDown = false;
const sessions = new Map<string, Record<string, unknown>>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    if (resendDown) return new Response(JSON.stringify({ message: "synthetic refusal" }), { status: 500 });
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text: string };
    sent.push({ to: [body.to].flat()[0], text: body.text });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  const m = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/);
  const found = m ? sessions.get(m[1]) : undefined;
  return new Response(JSON.stringify(found ?? { error: { message: "No such checkout.session" } }), { status: found ? 200 : 404 });
}) as typeof fetch;

/** Runs `work` with the one-command SET of a key starting with `prefix` answered by `reply`; with `apply`, the SET is still made. */
async function setAnswered<T>(prefix: string, reply: unknown[], work: () => Promise<T>, apply = false): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith(prefix)) {
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

const hubLinkKey = (token: string) => `nl:affhub:link:${createHash("sha256").update(`nimbus-affhub-link:${token}`).digest("hex").slice(0, 40)}`;
const stored = async (key: string) => (await redis.pipeline([["EXISTS", key]]))[0] === 1;
const hubLinks = () => [...(redis as unknown as { data: Map<string, unknown> }).data.keys()].filter((k) => k.startsWith("nl:affhub:link:")).length;

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


  const ask = async (email: string) => {
    // A fresh hour each time, so the counts never answer "limited" here.
    const data = (redis as unknown as { data: Map<string, unknown> }).data;
    for (const key of [...data.keys()]) if (key.startsWith("nl:rl:affhub-")) data.delete(key);
    return requestHubLink({ email, ip: "203.0.113.9", origin: "https://marktmorgen.com" });
  };

  part("Control: an affiliate's link is emailed after the answer, and opens the page");
  afterTasks.length = 0;
  const control = await ask("dana@example.com");
  is("the answer is \"sent\" before anything is looked up or emailed", [control, sent.length, afterTasks.length], ["sent", 0, 1]);
  await runAfterTasks();
  const hubToken = sent.at(-1)?.text.match(/token=([0-9a-f]{64})/)?.[1] ?? "";
  is("one email, to Dana, with a stored link", [sent.length, sent.at(-1)?.to, await stored(hubLinkKey(hubToken))], [1, "dana@example.com", true]);
  is("a stranger gets the same answer and no email", [await ask("nobody@example.com"), await runAfterTasks(), sent.length], ["sent", 1, 1]);

  part("PROOF: requestHubLink's answer under an unconfirmed SET must not tell an affiliate from a stranger");
  const affiliate = await setAnswered("nl:affhub:link:", [], () => ask("dana@example.com"));
  const stranger = await setAnswered("nl:affhub:link:", [], () => ask("nobody@example.com"));
  is("the same public answer for an affiliate and a stranger", affiliate, stranger);
  afterTasks.length = 0;

  part("No paid email with a link that was not stored, and no link left behind");
  for (const apply of [false, true]) {
    for (const [what, reply] of ODD) {
      const before = { emails: sent.length, links: hubLinks() };
      const answers = await setAnswered("nl:affhub:link:", reply, async () => {
        const got = [await ask("dana@example.com"), await ask("nobody@example.com")];
        await runAfterTasks();
        return got;
      }, apply);
      is(`SET ${apply ? "made" : "not made"} with ${what}: "sent" to both, no email, no link kept`, [answers, sent.length - before.emails, hubLinks() - before.links], [["sent", "sent"], 0, 0]);
    }
  }

  part("A refused final send: the same answer, and its link removed");
  resendDown = true;
  const beforeRefused = { emails: sent.length, links: hubLinks() };
  const refused = [await ask("dana@example.com"), await ask("nobody@example.com")];
  await runAfterTasks();
  resendDown = false;
  is("\"sent\" to both, nothing delivered, no link kept", [refused, sent.length - beforeRefused.emails, hubLinks() - beforeRefused.links], [["sent", "sent"], 0, 0]);
  is("and the link already emailed still opens the page", await stored(hubLinkKey(hubToken)), true);

  part("The page is honest when nothing was sent");
  // Marktmorgen's own page, in US English only.
  const notice = /sent: \{ tone: "ok", text: "([^"]+)" \}/.exec(readFileSync("app/affiliate/page.tsx", "utf8"))?.[1] ?? "";
  is("the notice is found", notice.length > 0, true);
  is("it never promises a link that may not have been sent", /on its way/i.test(notice), false);
  is("and says what to do if nothing arrives", /ask again/i.test(notice), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
