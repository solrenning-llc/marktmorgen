/**
 * A normal connection whose provider did not confirm the revoke (G review 5815300198, disposition A): the record is
 * still forgotten here, since the creator asked to disconnect, but the answer says the provider's access was not
 * confirmed removed, the routes pass that on, and the studio says it plainly. A confirmed revoke adds nothing.
 * Synthetic only: fetch is mocked, no provider is called, every token is made up here.
 */
import { readFileSync } from "node:fs";
import { disconnect } from "@/lib/meet-connect";
import * as setup from "@/lib/call-setup";
import * as notice from "@/lib/account-notice";
import { seal } from "@/lib/secret-box";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SID = "s0000000000000000-c3121";
const HOST = "0123456789abcdef01234567";
let answer: "refuse" | "throw" | "ok" = "ok";
let revoked = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(String(input));
  if (init?.method !== "POST" || !u.pathname.endsWith("/revoke")) throw Error("Unexpected synthetic provider request");
  const token = u.searchParams.get("token") ?? new URLSearchParams(String(init.body ?? "")).get("token");
  if (token !== "synthetic-grant") throw Error("Unexpected synthetic token");
  if (answer === "throw") throw new TypeError("synthetic network failure");
  if (answer === "refuse") return Response.json({ error: "invalid_request", error_description: "synthetic refusal" }, { status: 400 });
  revoked++;
  return new Response("{}", { status: 200 });
}) as typeof fetch;

type Outcome = { view: Record<string, unknown> | null; kept: boolean; revoked: number };
async function run(provider: "google" | "zoom", host: string, how: typeof answer): Promise<Outcome> {
  const ctx = (which: string) => (host ? `meet|hosts|${provider}|h:${host}|${which}` : `meet|${SID}|${provider}|${which}`);
  const key = host ? `nl:meet:conn:hosts:${provider}:h:${host}` : `nl:meet:conn:${SID}:${provider}`;
  const record = {
    provider,
    account: { id: "synthetic-account", email: "creator@example.test", name: "" },
    refresh: seal("synthetic-grant", ctx("refresh")),
    access: seal("synthetic-grant", ctx("access")),
    expires: 0,
    scope: "",
    connectedAt: 1,
    by: "creator@example.test",
    owner: { email: "creator@example.test", handle: "fixture" },
    broken: "",
    brokenAt: 0,
  };
  redis.clear();
  revoked = 0;
  answer = how;
  await redisPipeline([["SET", key, JSON.stringify(record)]]);
  const view = (await disconnect(SID, provider, host)) as Record<string, unknown> | null;
  const kept = (await redisPipeline([["GET", key]]))[0] !== null;
  return { view, kept, revoked };
}

async function main() {
  for (const [label, provider, host] of [
    ["Google store", "google", ""],
    ["Google host", "google", HOST],
    ["Zoom store", "zoom", ""],
  ] as const) {
    part(`${label}: provider refuses the revoke (400 invalid_request)`);
    const refused = await run(provider, host, "refuse");
    is("the connection is still forgotten here", [refused.view !== null, refused.kept], [true, false]);
    is("the answer says the provider's access was not confirmed removed", refused.view?.providerAccessRemoved, false);

    part(`${label}: the revoke throws (network failure)`);
    const thrown = await run(provider, host, "throw");
    is("the connection is still forgotten here", [thrown.view !== null, thrown.kept], [true, false]);
    is("the answer says the provider's access was not confirmed removed", thrown.view?.providerAccessRemoved, false);

    part(`${label}: the provider confirms (200)`);
    const confirmed = await run(provider, host, "ok");
    is("revoked once and forgotten", [confirmed.view !== null, confirmed.kept, confirmed.revoked], [true, false, 1]);
    is("nothing is added to the answer", confirmed.view ? Object.prototype.hasOwnProperty.call(confirmed.view, "providerAccessRemoved") : "no view", false);
  }

  part("The words the studio and the email use");
  const words = (setup as Record<string, unknown>).meetAccessUnconfirmedWords as ((p: "google" | "zoom") => string) | undefined;
  is("a shared sentence exists for each provider", typeof words, "function");
  is(
    "Google",
    words?.("google"),
    "We disconnected your Google account here, but Google did not confirm that it removed our access. You can remove it yourself: in your Google Account, open Security, then the list of third-party apps and services, and remove Marktmorgen.",
  );
  is(
    "Zoom",
    words?.("zoom"),
    "We disconnected your Zoom account here, but Zoom did not confirm that it removed our access. You can remove it yourself: sign in at marketplace.zoom.us, open Manage, then Added Apps, and click Remove next to Marktmorgen.",
  );
  const describe = (notice as Record<string, unknown>).accountChangeWords as ((c: unknown) => { subject: string; line: string }) | undefined;
  is("the disconnect email's words can be read", typeof describe, "function");
  const unconfirmedLine = describe?.({ kind: "meeting-disconnected", name: "Zoom", account: "creator@example.test", provider: "zoom", providerAccessRemoved: false }).line ?? "";
  is("the email does not say the access was given back when the provider did not confirm it", unconfirmedLine.includes("access was given back"), false);
  is(
    "the email says so, and how to remove it",
    [unconfirmedLine.includes("Zoom did not confirm that it removed our access"), unconfirmedLine.includes("Added Apps")],
    [true, true],
  );
  const confirmedLine = describe?.({ kind: "meeting-disconnected", name: "Zoom", account: "creator@example.test" }).line ?? "";
  is("a confirmed disconnect's email keeps its words", confirmedLine.includes("access was given back"), true);

  part("The routes pass it on, and the studio shows it in a live region");
  const meetRoute = readFileSync("app/api/integrations/meetings/route.ts", "utf8");
  is("the store route answers providerAccessRemoved false only when unconfirmed", /providerAccessRemoved === false \? \{ providerAccessRemoved: false \}/.test(meetRoute), true);
  const hostRoute = readFileSync("app/api/store/host-calendar/route.ts", "utf8");
  is("the host route answers providerAccessRemoved false only when unconfirmed", /removed === false \? \{ providerAccessRemoved: false \}/.test(hostRoute), true);
  const meetings = readFileSync("components/meeting-connections.tsx", "utf8");
  const hostCal = readFileSync("components/host-calendar.tsx", "utf8");
  is("the meeting connections screen reads it", meetings.includes("data.providerAccessRemoved === false"), true);
  is("the host calendar screen reads it", hostCal.includes("data.providerAccessRemoved === false"), true);
  is("the notice is a status live region drawn from the shared words", /export function ProviderAccessNotice[\s\S]*role="status"[\s\S]*meetAccessUnconfirmedWords|export function ProviderAccessNotice[\s\S]*role="status"/.test(meetings) && meetings.includes("MEET_ACCESS_UNCONFIRMED"), true);
  is("the host calendar screen shows the same notice", hostCal.includes("<ProviderAccessNotice"), true);

  done();
}
void main();
