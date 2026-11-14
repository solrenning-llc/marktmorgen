/**
 * The embedded product card reads nothing past the opens one connection gets (Claude 7, 13 November 2026; ALTO, an
 * uncapped cost). Synthetic only: the in-memory Redis, through the real app/embed/[handle]/[product]/page.tsx.
 *
 * A card pasted into a creator's site (no ?mm=) was drawn on every view with no count, no rest and no limit: each
 * view read the store, the product, its stock, keys, pre-order, extras and rating from Redis, so anybody asking for
 * /embed/<store>/<product> again and again spent our reads without end. The script's card read all of it too before
 * its own limit (lib/embed-open.ts) was asked. Now one connection's opens are counted first, with the embed-open
 * limit and its numbers (OPENS_PER_TEN_MINUTES in ten minutes, per address and store); past them the card is a plain
 * link to the store, which reads nothing.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { addProduct, claimHandle } from "@/lib/store";
import { OPENS_PER_TEN_MINUTES } from "@/lib/embed-sites";
import EmbedCard from "@/app/embed/[handle]/[product]/page";
import EmbedJoin from "@/app/embed/[handle]/join/page";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let sent: (string | number)[][] = [];
const run = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(...commands);
  return run(commands);
}) as typeof redis.pipeline;

/** The commands one view of the card sends, and what it draws. */
async function view(handle: string, product: string, ip: string, mm?: string): Promise<{ commands: (string | number)[][]; html: string }> {
  sent = [];
  answering(new Request(`https://marktmorgen.com/embed/${handle}/${product}`, { headers: { "x-forwarded-for": ip } }));
  const page = await EmbedCard({ params: Promise.resolve({ handle, product }), searchParams: Promise.resolve(mm ? { mm } : {}) });
  const commands = sent;
  let html = "";
  try {
    html = renderToStaticMarkup(page);
  } catch {
    html = "";
  }
  answering(null);
  return { commands, html };
}

/** Whether every command is the per-connection limit's own (SET NX and INCR of an nl:rl: key). */
const onlyTheLimit = (commands: (string | number)[][]) =>
  commands.length > 0 && commands.every((c) => (c[0] === "SET" || c[0] === "INCR") && String(c[1]).startsWith("nl:rl:"));

async function main(): Promise<void> {
  redis.clear();
  if (!(await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "")).ok) throw new Error("no store");
  const made = await addProduct("owner@example.com", "Knife Skills", "", "27", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;

  part("Control: a pasted card's first view is drawn as before");
  const first = await view("harbor", id, "203.0.113.7");
  is("it reads the store and the product", first.commands.length > 2, true);
  is("and draws the product", first.html.includes("Knife Skills"), true);

  part("Past the opens one connection gets, a pasted card reads nothing");
  for (let i = 1; i < OPENS_PER_TEN_MINUTES; i += 1) await view("harbor", id, "203.0.113.7");
  const past = await view("harbor", id, "203.0.113.7");
  is("only the limit's own count is sent", onlyTheLimit(past.commands), true);
  is("no store or product is read", past.commands.map((c) => String(c[1])).filter((key) => !key.startsWith("nl:rl:")), []);
  is("it is a plain link to the store, never a broken page", past.html.includes('href="/@harbor"'), true);

  part("Another connection still gets the card");
  const other = await view("harbor", id, "198.51.100.9");
  is("drawn", other.html.includes("Knife Skills"), true);

  part("The script's card is counted before anything is read, and only once");
  redis.clear();
  if (!(await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "")).ok) throw new Error("no store");
  const again = await addProduct("owner@example.com", "Knife Skills", "", "27", null);
  if (!again.ok) throw new Error("no product");
  const opened = await view("harbor", again.product.id, "203.0.113.8", "page");
  is("one count of the connection's opens", opened.commands.filter((c) => c[0] === "INCR" && String(c[1]).startsWith("nl:rl:")).length, 1);
  for (let i = 1; i < OPENS_PER_TEN_MINUTES; i += 1) await view("harbor", again.product.id, "203.0.113.8", "page");
  const pastScript = await view("harbor", again.product.id, "203.0.113.8", "page");
  is("past them, nothing is read", onlyTheLimit(pastScript.commands), true);

  part("The embedded sign-up form, the same: counted first, and past it a plain link that reads nothing");
  const join = async (ip: string) => {
    sent = [];
    answering(new Request("https://marktmorgen.com/embed/harbor/join", { headers: { "x-forwarded-for": ip } }));
    const page = await EmbedJoin({ params: Promise.resolve({ handle: "harbor" }), searchParams: Promise.resolve({ mm: "page" }) });
    const commands = sent;
    let html = "";
    try {
      html = renderToStaticMarkup(page);
    } catch {
      html = "";
    }
    answering(null);
    return { commands, html };
  };
  const firstJoin = await join("203.0.113.9");
  is("control: the first view reads the store", firstJoin.commands.some((c) => !String(c[1]).startsWith("nl:rl:")), true);
  is("and counts the connection's opens once", firstJoin.commands.filter((c) => c[0] === "INCR" && String(c[1]).startsWith("nl:rl:")).length, 1);
  for (let i = 1; i < OPENS_PER_TEN_MINUTES; i += 1) await join("203.0.113.9");
  const pastJoin = await join("203.0.113.9");
  is("past them, only the limit's own count is sent", onlyTheLimit(pastJoin.commands), true);
  is("and it is a plain link to the store", pastJoin.html.includes('href="/@harbor"'), true);
  done();
}

void main();
