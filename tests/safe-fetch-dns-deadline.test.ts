/**
 * The deadline of safeFetch covers the name lookup too (lib/safe-fetch.ts;
 * Claude 6 audit R27, finding 2, 9 November 2026). Every caller sizes its
 * work on timeoutMs (webhooks ATTEMPT_TIMEOUT_MS, calendars FEED_TIMEOUT_MS,
 * push, source pages and outreach, all 8 s; app/api/cron/mail/route.ts
 * counts on "a webhook try can take eight more"). Before this, the timer was
 * armed only once the lookup had answered, so a name whose nameserver stays
 * silent kept safeFetch waiting as long as the resolver did, plus the
 * deadline. Now each lookup, on the first hop and on every redirect hop, is
 * raced against the time left and refused as a "timeout", the same refusal
 * as a slow answer, and no socket is opened after it. lib/domain-proof.ts
 * races its own lookup the same way.
 *
 * Synthetic only: the lookups are stand-ins (the resolve hook and, once, the
 * node:dns/promises lookup itself), and every socket goes to a local plain
 * server.
 */
import dnsPromises from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { SafeFetchError, safeFetch } from "@/lib/safe-fetch";
import { done, is, part } from "./check";

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];

let sockets = 0;
const server = http.createServer((request, response) => {
  if (request.url === "/jump") {
    response.writeHead(302, { Location: "https://silent.r27.example.net/landed" });
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/plain" });
  response.end("ok");
});
server.on("connection", () => {
  sockets += 1;
});

/** Every request leaves on a plain socket to the local server, whatever address was checked. */
class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}

const slow = (ms: number) => async () => {
  await new Promise((r) => setTimeout(r, ms));
  return PUBLIC;
};
const silent = () => new Promise<never>(() => {});

/** How the call ended and after how long, never waiting past `cap`. */
async function timed(run: () => Promise<unknown>, cap: number): Promise<{ ms: number; how: string }> {
  const started = Date.now();
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  const how = await Promise.race([
    run().then(
      (answer) => `answered:${(answer as { status: number }).status}`,
      (e) => (e instanceof SafeFetchError ? `refused:${e.problem}` : `threw:${(e as Error).message}`),
    ),
    new Promise<string>((r) => {
      capTimer = setTimeout(() => r("still waiting"), cap);
    }),
  ]);
  clearTimeout(capTimer);
  return { ms: Date.now() - started, how };
}

/** Timers still armed once the closed sockets have had a moment to finish closing. */
async function timers(): Promise<number> {
  await new Promise((r) => setTimeout(r, 100));
  return process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agent = new LocalAgent((server.address() as net.AddressInfo).port) as never;

  part("A lookup that takes 1.5 s, with a 200 ms deadline");
  sockets = 0;
  const a = await timed(() => safeFetch("https://hook.r27.example.net/x", { method: "POST", body: "{}", maxBytes: 1024, timeoutMs: 200, resolve: slow(1_500), agent }), 4_000);
  console.log(`        ${a.how} after ${a.ms} ms`);
  is("it is refused as a timeout", a.how, "refused:timeout");
  is("near the deadline (180 to 600 ms), not after the lookup", a.ms >= 180 && a.ms < 600, true);
  await new Promise((r) => setTimeout(r, 1_400));
  is("the late answer opens no socket", sockets, 0);

  part("A lookup that never answers (a nameserver that stays silent), with a 200 ms deadline");
  const b = await timed(() => safeFetch("https://hook.r27.example.net/x", { maxBytes: 1024, timeoutMs: 200, resolve: silent, agent }), 2_000);
  console.log(`        ${b.how} after ${b.ms} ms`);
  is("it is refused as a timeout, not left waiting", b.how, "refused:timeout");
  is("at the deadline (180 to 600 ms)", b.ms >= 180 && b.ms < 600, true);
  is("no socket was opened", sockets, 0);

  part("The production lookup (node:dns/promises, no resolve hook) is bounded the same way");
  const original = dnsPromises.lookup;
  (dnsPromises as unknown as { lookup: unknown }).lookup = () => new Promise(() => {});
  try {
    const c = await timed(() => safeFetch("https://hook.r27.example.net/x", { method: "POST", body: "{}", maxBytes: 1024, timeoutMs: 200, agent }), 2_000);
    console.log(`        ${c.how} after ${c.ms} ms`);
    is("it is refused as a timeout at the deadline", [c.how, c.ms < 600], ["refused:timeout", true]);
  } finally {
    (dnsPromises as unknown as { lookup: unknown }).lookup = original;
  }

  part("A redirect whose new name never answers");
  sockets = 0;
  const jumps = (host: string) => (host === "silent.r27.example.net" ? silent() : Promise.resolve(PUBLIC));
  const d = await timed(() => safeFetch("https://first.r27.example.net/jump", { maxBytes: 1024, timeoutMs: 400, resolve: jumps, agent }), 3_000);
  console.log(`        ${d.how} after ${d.ms} ms`);
  is("the second hop is refused as a timeout", d.how, "refused:timeout");
  is("at the deadline of the whole exchange (380 to 900 ms)", d.ms >= 380 && d.ms < 900, true);
  is("only the first hop opened a socket", sockets, 1);

  part("A redirect whose new name answers after the deadline");
  sockets = 0;
  const lateJump = (host: string) => (host === "silent.r27.example.net" ? slow(1_000)() : Promise.resolve(PUBLIC));
  const e = await timed(() => safeFetch("https://first.r27.example.net/jump", { maxBytes: 1024, timeoutMs: 400, resolve: lateJump, agent }), 3_000);
  is("refused as a timeout near the deadline", [e.how, e.ms < 900], ["refused:timeout", true]);
  await new Promise((r) => setTimeout(r, 900));
  is("the late answer opens no second socket", sockets, 1);

  part("Healthy controls");
  const before = await timers();
  const ok = await timed(() => safeFetch("https://hook.r27.example.net/x", { maxBytes: 1024, timeoutMs: 5_000, resolve: async () => PUBLIC, agent }), 4_000);
  is("a quick lookup answers as before", ok.how, "answered:200");
  const quickSlow = await timed(() => safeFetch("https://hook.r27.example.net/x", { maxBytes: 1024, timeoutMs: 2_000, resolve: slow(100), agent }), 4_000);
  is("a lookup inside the deadline still answers", quickSlow.how, "answered:200");
  const followed = await timed(() => safeFetch("https://first.r27.example.net/jump", { maxBytes: 1024, timeoutMs: 5_000, resolve: async () => PUBLIC, agent }), 4_000);
  is("a redirect to a name that answers is followed", followed.how, "answered:200");
  is("no timer is left behind after answers", await timers(), before);
  const missing = await timed(() => safeFetch("https://hook.r27.example.net/x", { maxBytes: 1024, timeoutMs: 5_000, resolve: async () => { throw new Error("ENOTFOUND"); }, agent }), 4_000);
  is("a name that is not found is still refused as dns", missing.how, "refused:dns");
  const none = await timed(() => safeFetch("https://hook.r27.example.net/x", { maxBytes: 1024, timeoutMs: 5_000, resolve: async () => [], agent }), 4_000);
  is("a name with no answers is still refused as dns", none.how, "refused:dns");
  const inside = await timed(() => safeFetch("https://hook.r27.example.net/x", { maxBytes: 1024, timeoutMs: 5_000, resolve: async () => [{ address: "10.0.0.1", family: 4 }], agent }), 4_000);
  is("a name pointing inside is still refused as private", inside.how, "refused:private");
  const lateInside = await timed(() => safeFetch("https://hook.r27.example.net/x", { maxBytes: 1024, timeoutMs: 5_000, resolve: async () => { await new Promise((r) => setTimeout(r, 50)); return [{ address: "169.254.169.254", family: 4 }]; }, agent }), 4_000);
  is("a slower name pointing inside is still refused as private", lateInside.how, "refused:private");
  is("no timer is left behind after refusals", await timers(), before);

  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
