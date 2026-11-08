/**
 * CX-123 rule 24, app/studio/import/page.tsx: "Your last imports" says "None yet" only when the store's import list
 * was read and holds none. A list whose read fails (no reply from Redis) is unknown: the page says it could not be
 * read just now, never that there were no imports. The same holds at the ClickFunnels "funnel" step: when the store's
 * products cannot be read, the page says so and does not offer an empty product picker ("No product of yours fits
 * yet"), which would send the creator to import products they already have.
 *
 * Synthetic store and Redis (tests/redis-stub.ts); one read is made to fail on purpose.
 */
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import StudioImportPage from "@/app/studio/import/page";
import { answering } from "./security/next-headers";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "import-unknown@example.test";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

function named(node: unknown, name: string): Node | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = named(child, name);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const n = node as Node;
    return typeof n.type === "function" && n.type.name === name ? n : named(n.props?.children, name);
  }
  return undefined;
}

function words(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(words).join(" ");
  if (node && typeof node === "object") return words((node as Node).props?.children);
  return "";
}

async function funnelStep(failing: boolean) {
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    if (failing && commands.some((c) => c[0] === "HGETALL" && /^nl:catalog:.+:t$/.test(String(c[1])))) throw new Error("synthetic: no reply");
    return original(commands);
  };
  try {
    answering(new NextRequest("https://marktmorgen.com/studio/import?what=clickfunnels&step=funnel", { headers: { cookie } }));
    return await StudioImportPage({ searchParams: Promise.resolve({ what: "clickfunnels", step: "funnel" }) });
  } finally {
    redis.pipeline = original;
    answering(null);
  }
}

async function lastImports(failing: boolean): Promise<string> {
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    if (failing && commands.some((c) => c[0] === "LRANGE" && String(c[1]).startsWith("nl:imports:list:"))) throw new Error("synthetic: no reply");
    return original(commands);
  };
  try {
    answering(new NextRequest("https://marktmorgen.com/studio/import", { headers: { cookie } }));
    const page = await StudioImportPage({ searchParams: Promise.resolve({}) });
    const past = named(page, "PastImports");
    if (!past) return "";
    return renderToStaticMarkup(createElement(past.type as FunctionComponent<Record<string, unknown>>, past.props ?? {}));
  } finally {
    redis.pipeline = original;
    answering(null);
  }
}

async function main() {
  redis.clear();
  await claimHandle(OWNER, "importunknown", "Synthetic import shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);

  part("control: the list is read and holds none");
  const known = await lastImports(false);
  is("the list is shown", known.includes("Your last imports"), true);
  is("it says none yet", known.includes("None yet"), true);

  part("the list cannot be read");
  const unknown = await lastImports(true);
  is("the list is shown", unknown.includes("Your last imports"), true);
  is("it never says none yet", unknown.includes("None yet"), false);
  is("it says the list could not be read just now", unknown.includes("could not be read just now"), true);

  is("a product is added", (await addProduct(OWNER, "Synthetic funnel guide", "", "20", null)).ok, true);

  part("control: the funnel step reads the store's products");
  const read = await funnelStep(false);
  const picker = named(read, "ClickFunnelsFunnel");
  is("the product picker is shown", Boolean(picker), true);
  is("it lists the store's product", ((picker?.props?.products as { title: string }[] | undefined) ?? []).map((p) => p.title), ["Synthetic funnel guide"]);

  part("the funnel step cannot read the store's products");
  const unread = await funnelStep(true);
  is("an empty product picker is never offered", Boolean(named(unread, "ClickFunnelsFunnel")), false);
  is("it says the products could not be read just now", words(unread).includes("Your products could not be read just now"), true);
  done();
}

void main();
