/**
 * A compressed answer that safeFetch cannot unpack (lib/safe-fetch.ts), read
 * from a local stand-in server; no real address is asked.
 *
 *   - unpacked past the size read: too_big with the status it answered, so a
 *     caller may judge a long page by it (479 [SB2]: a long 404 is gone);
 *   - not a compressed body at all (corrupt): too_big with no status, so a
 *     link whose page cannot be read is never said to answer
 *     (lib/delivery-check.ts reads it as not checked).
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { gzipSync } from "node:zlib";
import { SafeFetchError, safeFetch } from "@/lib/safe-fetch";
import { done, is, part } from "./check";

const MAX = 10_000;
const ANSWERS: Record<string, { status: number; body: Buffer }> = {
  "/long": { status: 200, body: gzipSync(Buffer.alloc(MAX * 3, "a")) },
  "/long-gone": { status: 404, body: gzipSync(Buffer.alloc(MAX * 3, "a")) },
  "/corrupt": { status: 200, body: Buffer.from("this is not a gzip stream at all") },
  "/fine": { status: 200, body: gzipSync(Buffer.from("small page")) },
};

const server = http.createServer((request, response) => {
  const answer = ANSWERS[request.url ?? ""] ?? { status: 404, body: Buffer.from("") };
  response.writeHead(answer.status, { "Content-Type": "text/html", "Content-Encoding": "gzip", "Content-Length": String(answer.body.length) });
  response.end(answer.body);
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

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const options = { maxBytes: MAX, timeoutMs: 5_000, resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never };
  const read = async (path: string) => {
    try {
      const answer = await safeFetch(`https://pages.example.net${path}`, options);
      return { status: answer.status, bytes: answer.body.length };
    } catch (error) {
      return error instanceof SafeFetchError ? { problem: error.problem, status: error.status ?? null } : { thrown: String(error) };
    }
  };

  part("Unpacked past the size read: the status it answered goes with it");
  is("a long 200 page", await read("/long"), { problem: "too_big", status: 200 });
  is("a long 404 page", await read("/long-gone"), { problem: "too_big", status: 404 });

  part("A body that is not compressed at all: no status, so it is never read as an answer");
  is("a corrupt body", await read("/corrupt"), { problem: "too_big", status: null });

  part("Control");
  is("a small compressed page reads", await read("/fine"), { status: 200, bytes: "small page".length });

  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
