/**
 * Claude 5 on #2971: a shared numbers link says "Opened too many times today" only when its own count of openings
 * is past the day's (MEDIUM). The store's window of public requests spent, or that count failing to be taken, is a
 * different refusal and gets a neutral sentence true in both cases, on the page and from the password form (LIGHT).
 * And the form answers a link it could not read with the page's own notice, never a bare text/plain 503 (LIGHT).
 * Synthetic data only.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import NumbersLinkPage from "@/app/numbers/[id]/page";
import { POST as passwordForm } from "@/app/api/numbers-link/route";
import { OPENS_PER_DAY, cookieName, indexLink, makeLink, passCookie } from "@/lib/numbers-links";
import { addNumbersLink, claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { answering as asRequest } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OVER = "Opened too many times";
const BUSY = "can&#x27;t be opened right now";
const UNREAD = "could not be read just now";

async function page(id: string, cookie: string, query: Record<string, string> = {}): Promise<string> {
  asRequest(new Request("https://marktmorgen.com/numbers/" + id, { headers: cookie ? { cookie } : {} }));
  try {
    return renderToStaticMarkup(await NumbersLinkPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(query) }));
  } finally {
    asRequest(null);
  }
}

/** Runs `work` with every pipeline after the first that INCRs a key starting `prefix` thrown, as a lost connection. */
async function failingAfter<T>(match: (commands: Commands) => boolean, work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  let seen = false;
  redis.pipeline = (async (commands: Commands) => {
    if (seen) throw new Error("connection reset");
    const out = await original.call(redis, commands);
    if (match(commands)) seen = true;
    return out;
  }) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

async function tryPassword(id: string, password: string): Promise<{ status: number; location: string; type: string }> {
  const response = await passwordForm(
    new NextRequest("https://marktmorgen.com/api/numbers-link", {
      method: "POST",
      headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" },
      body: new URLSearchParams({ id, password }),
    }),
  );
  return { status: response.status, location: response.headers.get("location") ?? "", type: response.headers.get("content-type") ?? "" };
}

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStoreId("owner@example.com");
  await ensureStatsId("owner@example.com");
  const made = makeLink({ label: "Acme sponsorship", password: "harbor-2026", days: 30, money: false }, now);
  if (!made.ok) throw new Error("no link");
  await addNumbersLink("owner@example.com", made.link, now);
  const store = (await storeForEmail("owner@example.com"))!;
  await indexLink(store.sid, made.link, now);
  const id = made.link.id;
  const cookie = `${cookieName(id)}=${passCookie(made.link, now)}`;
  const isOpens = (commands: Commands) => commands.some((c) => c[0] === "INCR" && String(c[1]).startsWith("nl:nlink:opens:"));

  part("Controls");
  const healthy = await page(id, cookie);
  is("with the password: the numbers open", [healthy.includes(OVER), healthy.includes(BUSY), healthy.includes(UNREAD), healthy.includes("shared with you")], [false, false, false, true]);
  const opens = `nl:nlink:opens:${id}:${new Date(now).toISOString().slice(0, 10)}`;
  await redis.pipeline([["SET", opens, String(OPENS_PER_DAY)]]);
  const over = await page(id, cookie);
  is("past the day's openings: opened too many times", over.includes(OVER), true);
  await redis.pipeline([["DEL", opens]]);

  part("The store's window not taken is never 'opened too many times' (MEDIUM)");
  const busy = await failingAfter(isOpens, () => page(id, cookie));
  is("every read after the count fails: [opened too many times, the neutral sentence]", [busy.includes(OVER), busy.includes(BUSY)], [false, true]);

  part("The password form");
  const formBusy = await failingAfter((c) => c.some((one) => one[0] === "GET" && String(one[1]).startsWith("nl:store:owner:")), () => tryPassword(id, "harbor-2026"));
  is("the window not taken: back with busy, never 'too many tries'", [formBusy.status, formBusy.location.endsWith("?busy=1")], [303, true]);
  const busyPage = await page(id, "", { busy: "1" });
  is("the page says the neutral sentence, never 'too many tries'", [busyPage.includes(BUSY), busyPage.includes("Too many tries")], [true, false]);
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => (commands[0]?.[0] === "GET" && String(commands[0]?.[1] ?? "").startsWith("nl:nlink:") ? [7] : original.call(redis, commands))) as Pipeline;
  const formOdd = await tryPassword(id, "harbor-2026").finally(() => { redis.pipeline = original; });
  is("a link not read: back to the page's own notice, never a bare text 503", [formOdd.status, formOdd.location.endsWith("?unread=1"), formOdd.type.startsWith("text/plain")], [303, true, false]);
  const unreadPage = await page(id, "", { unread: "1" });
  is("the page says the password could not be checked", unreadPage.includes("could not be checked just now"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
