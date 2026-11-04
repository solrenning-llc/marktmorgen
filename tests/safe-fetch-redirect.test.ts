/**
 * What a redirected GET carries (lib/safe-fetch.ts; security audit 506
 * [SG1], MM-SA-28, 4 November 2026). A redirect to another origin (scheme,
 * host or port) is a request to somebody else, so it never carries the
 * caller's credentials: Authorization, Proxy-Authorization, Cookie and any
 * header whose name holds "token", "secret", "key" or "signature" are left
 * behind, as browsers do with Authorization on a cross-origin redirect. A
 * redirect within the same origin keeps every header. Once left behind, a
 * credential stays behind, even if a later hop comes back.
 *
 * Synthetic only: every name resolves to one public stand-in address and
 * every socket goes to a local plain server.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { safeFetch, sensitiveHeader } from "@/lib/safe-fetch";
import { done, is, part } from "./check";

type Seen = { host: string; path: string; headers: http.IncomingHttpHeaders };
const seen: Seen[] = [];

/** Where each path sends the request next; anything else answers 200. */
const JUMPS: Record<string, string> = {
  "/cross": "https://other.example.net/landed",
  "/cross-port": "https://first.example.net:8443/landed",
  "/same": "https://first.example.net/landed",
  "/relative": "/landed",
  "/away-and-back": "https://other.example.net/back",
  "/back": "https://first.example.net/landed",
};

const server = http.createServer((request, response) => {
  const path = request.url ?? "";
  seen.push({ host: String(request.headers.host ?? ""), path, headers: request.headers });
  const next = JUMPS[path];
  if (next) {
    response.writeHead(302, { Location: next });
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/plain" });
  response.end("ok");
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

const CREDENTIALS = {
  Authorization: "Bearer synthetic-credential-0001",
  "Proxy-Authorization": "Basic c3ludGhldGlj",
  Cookie: "session=synthetic",
  "X-Api-Key": "synthetic-key-0001",
  "X-Auth-Token": "synthetic-token-0001",
  "X-Client-Secret": "synthetic-secret-0001",
  "X-Webhook-Signature": "t=1,v1=synthetic",
};
const PLAIN = { Accept: "text/calendar", "User-Agent": "Marktmorgen-test" };
const CREDENTIAL_NAMES = Object.keys(CREDENTIALS).map((name) => name.toLowerCase());

/** Which of the credential headers the last request to `path` carried. */
function carried(path: string): string[] {
  const last = [...seen].reverse().find((s) => s.path === path);
  if (!last) return ["(never asked)"];
  return CREDENTIAL_NAMES.filter((name) => name in last.headers);
}
function plainKept(path: string): boolean {
  const last = [...seen].reverse().find((s) => s.path === path);
  return Boolean(last && last.headers.accept === "text/calendar" && last.headers["user-agent"] === "Marktmorgen-test");
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const options = {
    headers: { ...CREDENTIALS, ...PLAIN },
    maxBytes: 10_000,
    timeoutMs: 5_000,
    // A public address, as a real name would resolve to; the socket goes to the local server.
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    agent: new LocalAgent(port) as never,
  };

  part("Which headers are credentials");
  for (const name of ["Authorization", "authorization", "PROXY-AUTHORIZATION", "Cookie", "X-Api-Key", "x-api-key", "X-Auth-Token", "X-Client-Secret", "Stripe-Signature", "X-Hub-Signature-256", "Private-Token", "Apikey", "X-Authorization", "X-Auth", "X-Auth-User", "X-Cookie", "X-Session-Id", "X-Csrf-Token", "X-Credential", "X-Password", "X-Amz-Security-Token"]) {
    is(`a credential: ${name}`, sensitiveHeader(name), true);
  }
  for (const name of ["Accept", "Accept-Encoding", "User-Agent", "Content-Type", "Content-Length", "Keep-Alive", "If-None-Match", "Accept-Language", "Cache-Control", "X-Request-Id"]) {
    is(`not a credential: ${name}`, sensitiveHeader(name), false);
  }

  part("The first request carries what the caller gave");
  seen.length = 0;
  await safeFetch("https://first.example.net/cross", options);
  is("the first hop carries every credential header", carried("/cross"), CREDENTIAL_NAMES);

  part("A redirect to another host");
  const cross = await safeFetch("https://first.example.net/cross", options);
  is("it was followed to the other host", [cross.status, cross.url], [200, "https://other.example.net/landed"]);
  is("the other host was the one asked", [...seen].reverse().find((s) => s.path === "/landed")?.host, "other.example.net");
  is("no credential header reaches the other host", carried("/landed"), []);
  is("the plain headers still go", plainKept("/landed"), true);

  part("A redirect to another port of the same host");
  seen.length = 0;
  await safeFetch("https://first.example.net/cross-port", options);
  is("another port is another origin: no credential header", carried("/landed"), []);

  part("A redirect within the same origin");
  seen.length = 0;
  const same = await safeFetch("https://first.example.net/same", options);
  is("it was followed", [same.status, same.url], [200, "https://first.example.net/landed"]);
  is("every credential header still goes", carried("/landed"), CREDENTIAL_NAMES);
  seen.length = 0;
  await safeFetch("https://first.example.net/relative", options);
  is("a relative redirect is the same origin: every credential header still goes", carried("/landed"), CREDENTIAL_NAMES);

  part("Away and back");
  seen.length = 0;
  await safeFetch("https://first.example.net/away-and-back", options);
  is("the other host gets none", carried("/back"), []);
  is("once left behind, a credential stays behind, even back on the first origin", carried("/landed"), []);

  part("The caller's headers are not changed");
  is("the options object still holds every header", Object.keys(options.headers), [...Object.keys(CREDENTIALS), ...Object.keys(PLAIN)]);

  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
