import { isValidElement } from "react";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId } from "@/lib/store";
import StudioPage from "@/app/studio/page";
import { listPasskeys, REMOVAL_DAYS, scheduleRemoval } from "@/lib/passkeys";
import { makePasskey } from "./passkey-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_second_step_gate_only";
let mails = 0;
// This is the existing test sender seam, not a provider request. Admit its
// complete finite ceiling before either setup or page execution.
const MAX_MAILS = 8;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (!String(input).includes("resend")) throw Error("Unexpected network request in isolated proof");
  if (++mails > MAX_MAILS) throw Error("Synthetic mail ceiling exceeded");
  return new Response(JSON.stringify({ id: "synthetic_mail" }), { status: 200 });
}) as typeof fetch;

function managers(tree: unknown): Record<string, unknown>[] {
  if (Array.isArray(tree)) return tree.flatMap(managers);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  const here = typeof tree.type === "function" && tree.type.name === "PasskeyManager" ? [tree.props] : [];
  return [...here, ...managers(tree.props.children)];
}

async function main(): Promise<void> {
  const original = redis.pipeline.bind(redis);
  const MAX_COMMANDS_PER_CASE = 2000;
  let commandsUsed = 0;
  let delayed = false;
  let failingDropKey: string | null = null;
  let faulted = false;
  redis.pipeline = async (commands) => {
    // Count before every synthetic Redis invocation. Its honest finite
    // network delay changes scheduling only; no reply or state is forged.
    if (commandsUsed + commands.length > MAX_COMMANDS_PER_CASE) throw Error("Synthetic Redis ceiling exceeded");
    commandsUsed += commands.length;
    if (failingDropKey && !faulted && commands.some((command) => command[0] === "GET" && command[1] === failingDropKey)) {
      faulted = true;
      throw Error("Synthetic first cleanup read failed before execution");
    }
    if (delayed) await new Promise((resolve) => setTimeout(resolve, 5));
    return original(commands);
  };
  try {
    for (const scenario of ["active", "expired", "expired-first-read-failed"] as const) {
      const due = scenario !== "active";
      redis.clear(); commandsUsed = 0; delayed = false; failingDropKey = null; faulted = false;
      const email = scenario === "expired-first-read-failed" ? "failed-cleanup-fixture@example.test" : due ? "expired-key-fixture@example.test" : "active-key-fixture@example.test";
      const handle = scenario === "expired-first-read-failed" ? "failed-cleanup-fixture" : due ? "expired-key-fixture" : "active-key-fixture";
      await claimHandle(email, handle, "Synthetic read ordering", "");
      await ensureStatsId(email);
      const session = await openSession(email);
      const request = () => new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
      answering(request());
      await StudioPage({ searchParams: Promise.resolve({}) });
      const key = makePasskey(email, "synthetic-key");
      await key.keep();
      if (due) {
        const at = await scheduleRemoval(email, "synthetic-key", session, false, Date.now() - REMOVAL_DAYS * 86_400_000 - 60_000);
        is("the real removal writer scheduled the expired key", typeof at, "number");
      }
      is(`${handle}: fixture begins with a real stored key`, (await listPasskeys(email)).map((row) => row.id), ["synthetic-key"]);
      delayed = true;
      if (scenario === "expired-first-read-failed") {
        failingDropKey = "nl:pk:drop:" + createHash("sha256").update("nimbus-passkey-drop:" + email).digest("hex").slice(0, 40);
      }
      answering(request());
      const tree = await StudioPage({ searchParams: Promise.resolve({}) });
      delayed = false;
      const views = managers(tree);
      const stored = (await listPasskeys(email)).map((row) => row.id);
      const shown = Array.isArray(views[0]?.initial) ? views[0].initial.map((row: { id: string }) => row.id) : null;
      part(handle);
      is("the real page supplies one passkey manager", views.length, 1);
      is("the stored list applies a due removal and preserves an active key", stored, due ? [] : ["synthetic-key"]);
      is("the page supplies the exact remaining passkeys", shown, stored);
      console.log("READ_ORDER:" + JSON.stringify({ scenario, due, faulted, stored, shown, commandsUsed, syntheticMails: mails }));
    }
  } finally {
    redis.pipeline = original;
    answering(null);
  }
  done();
}
main().catch((error: unknown) => { console.error(error); process.exit(1); });
