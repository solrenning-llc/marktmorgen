/**
 * CX-123 rule 24, app/studio/import/page.tsx: "Your last imports" says "None yet" only when the store's import list
 * was read and holds none. A list whose read fails (no reply from Redis) is unknown: the page says it could not be
 * read just now, never that there were no imports.
 *
 * Synthetic store and Redis (tests/redis-stub.ts); one read is made to fail on purpose.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import StudioImportPage from "@/app/studio/import/page";
import { answering } from "./security/next-headers";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId } from "@/lib/store";
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
    return renderToStaticMarkup(createElement(past.type as (props: never) => never, past.props as never));
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
  done();
}

void main();
