/**
 * The host's browser check is set up once per window, for every route it
 * guards (Claude 6's MEDIUM on #3360). The host's script hands its challenge
 * to one global that the first initBotId takes, so a second initBotId in the
 * same window never gets one and its requests never settle: a visitor who
 * went from a store page to sign-in by an in-app link was left on "sending".
 *
 * So the sign-in form and the store's beacon both start it through one module
 * (lib/browser-check-client.ts), which calls initBotId once with both routes,
 * and nothing else in the app calls it. A link's count needs no check
 * (app/api/store/hit), so it goes by sendBeacon, which outlives the page being
 * left, and never waits on the challenge.
 *
 * The module is exercised with a stand-in for initBotId and a synthetic window.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_CHECK_ROUTES, startBrowserCheck } from "@/lib/browser-check-client";
import { done, is, part } from "./check";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

async function main(): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const calls: unknown[] = [];
  const plain = (async () => new Response("{}")) as unknown as typeof fetch;
  (globalThis as unknown as { window: unknown }).window = { fetch: plain };

  part("One initBotId for the window, with both routes");
  is("both routes are guarded", BROWSER_CHECK_ROUTES, [
    { path: "/api/auth/request", method: "POST" },
    { path: "/api/store/hit", method: "POST" },
  ]);
  env.NODE_ENV = "production";
  const first = startBrowserCheck((options) => calls.push(options));
  const second = startBrowserCheck((options) => calls.push(options));
  is("set up once, however many parts of the page ask", calls.length, 1);
  is("with every route at once", calls[0], { protect: BROWSER_CHECK_ROUTES });
  is("each caller gets the fetch from before the check wrapped it", [first === plain, second === plain], [true, true]);

  part("Only one place in the app calls initBotId");
  const callers = [...filesUnder("app"), ...filesUnder("components"), ...filesUnder("lib")].filter((file) => /initBotId\(/.test(readFileSync(file, "utf8")));
  is("lib/browser-check-client.ts alone", callers, [join("lib", "browser-check-client.ts")]);
  const form = readFileSync("components/signin-form.tsx", "utf8");
  const beacon = readFileSync("components/store-beacon.tsx", "utf8");
  is("the sign-in form starts it through the module", /startBrowserCheck\(\)/.test(form) && !/botid\/client/.test(form), true);
  is("the store's beacon starts it through the module", /startBrowserCheck\(\)/.test(beacon) && !/botid\/client/.test(beacon), true);

  part("A link's count needs no check, so it goes by sendBeacon and never waits on the challenge");
  is("a link goes by sendBeacon", /payload\.k === "l"/.test(beacon) && /navigator\.sendBeacon\("\/api\/store\/hit"/.test(beacon), true);
  is("a visit, a page or a funnel step goes by fetch, which the check signs", /send\(fetch\)/.test(beacon), true);

  done();
}

main();
