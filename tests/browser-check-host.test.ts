/**
 * The browser check (Vercel BotID) is started on the client only on the host
 * whose answer the server reads (lib/bot-check.ts, browserProof answers
 * "human" when VERCEL is not "1"). Off that host its challenge script is pure
 * main-thread cost on every store page: on the CI's production build it ran
 * about 3 s after load for 75–330 ms and was the long task under every slow
 * tap of the mobile render check (TODOS-100, regression from #3360). The
 * build says which host it is for in NEXT_PUBLIC_BROWSER_CHECK (next.config.ts).
 */
import { readFileSync } from "node:fs";
import { startBrowserCheck } from "@/lib/browser-check-client";
import { done, is, part } from "./check";

type Env = Record<string, string | undefined>;
const env = process.env as Env;
const fakeFetch = (async () => new Response("")) as unknown as typeof fetch;

/** One start of the check, as a page would: the cases run in order, since a started check is kept for the window. */
function attempt(flag: string | undefined): { answer: "plain" | "null"; inits: number } {
  let inits = 0;
  (globalThis as { window?: unknown }).window = { fetch: fakeFetch };
  env.NODE_ENV = "production";
  if (flag === undefined) delete env.NEXT_PUBLIC_BROWSER_CHECK;
  else env.NEXT_PUBLIC_BROWSER_CHECK = flag;
  const answer = startBrowserCheck(() => {
    inits += 1;
  });
  return { answer: answer ? "plain" : "null", inits };
}

function main(): void {
  part("Off the host whose answer the server reads, the check is never started");
  is("no flag: nothing started, the beacon sends as before the check", attempt(undefined), { answer: "null", inits: 0 });
  is("flag 0: nothing started", attempt("0"), { answer: "null", inits: 0 });
  part("On it, as before");
  is("flag 1: the check is started once, and the plain fetch is answered", attempt("1"), { answer: "plain", inits: 1 });
  part("The build's flag follows the same host test as the server's reading of the answer (Claude 1 cloud on #3638)");
  // If the flag were ever "0" on Vercel, the client would stop the check while browserProof/isAutomated still demand
  // it there: store visits would read automated and sign-in would be refused, with no other test failing.
  const config = readFileSync("next.config.ts", "utf8");
  const flags = (config.match(/NEXT_PUBLIC_BROWSER_CHECK:[^,}\n]*/g) ?? []).map((flag) => flag.trim());
  is("next.config.ts sets the flag exactly once, from VERCEL being \"1\"", flags, ['NEXT_PUBLIC_BROWSER_CHECK: process.env.VERCEL === "1" ? "1" : "0"']);
  const server = readFileSync("lib/bot-check.ts", "utf8");
  is("and the server reads the answer only when VERCEL is \"1\", in both of its readers", (server.match(/if \(process\.env\.VERCEL !== "1"\) return /g) ?? []).length, 2);
  done();
}
main();
