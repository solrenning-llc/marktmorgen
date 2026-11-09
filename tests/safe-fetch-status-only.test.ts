/**
 * The size cap of lib/safe-fetch.ts, and the answer read for its status only
 * (Claude 5 outbound audit, 9 Nov 2026).
 *
 * LOW 2: when the whole answer (headers, one piece larger than maxBytes and
 * the end) arrived in one socket read, the "data" handler destroyed the
 * request without keeping the piece, but the response's "end" resolved first:
 * the caller got the status with an EMPTY body, as if that were the whole
 * answer. An answer over the cap is refused as too big however it arrives
 * (200,000 bytes, several reads, is the control that was already refused).
 *
 * MEDIUM 1: a caller that needs only the status (webhooks, web push) says
 * statusOnly; the status and headers come back whatever the size of the body,
 * which is not read at all and the connection is closed. A caller that reads
 * the body keeps the cap.
 *
 * Only a local server; the name lookup and the socket are redirected, as in
 * tests/webhooks-delivery.test.ts. No request leaves the machine.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { safeFetch } from "@/lib/safe-fetch";
import { done, is, part } from "./check";

let size = 0;
let status = 200;
let declare = false;
let bodies = 0;

const server = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    bodies += 1;
    response.writeHead(status, { "Content-Type": "application/json", ...(declare ? { "Content-Length": String(size) } : {}) });
    response.end(Buffer.alloc(size, 120));
  });
});

class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}

async function outcome(options: Parameters<typeof safeFetch>[1]): Promise<string> {
  try {
    const answer = await safeFetch("https://hooks.example.com/in", options);
    return `resolved ${answer.status} with ${answer.body.length} bytes`;
  } catch (error) {
    return `refused: ${(error as Error).message}`;
  }
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const hooks = { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never };

  for (const [bytes, cap] of [[9_000, 8_192], [20_000, 16_384], [60_000, 16_384], [200_000, 16_384]] as const) {
    part(`${bytes} bytes in one piece against a ${cap}-byte cap, body read`);
    size = bytes;
    is("an answer larger than the cap is refused as too big, never returned as an empty 200", await outcome({ maxBytes: cap, timeoutMs: 5_000, ...hooks }), "refused: The answer is larger than we read.");
  }

  part("An answer within the cap is read whole");
  size = 4_000;
  is("4,000 bytes against 16,384", await outcome({ maxBytes: 16_384, timeoutMs: 5_000, ...hooks }), "resolved 200 with 4000 bytes");
  declare = true;
  is("with its Content-Length too", await outcome({ maxBytes: 16_384, timeoutMs: 5_000, ...hooks }), "resolved 200 with 4000 bytes");
  declare = false;

  for (const [bytes, declared] of [[20_000, true], [20_000, false], [200_000, false], [2_000_000, true]] as const) {
    part(`Status only: ${bytes} bytes ${declared ? "with" : "without"} a Content-Length`);
    size = bytes;
    declare = declared;
    status = 200;
    is("a 2xx comes back with its status, the body not read", await outcome({ method: "POST", body: "{}", maxBytes: 16_384, timeoutMs: 5_000, statusOnly: true, ...hooks }), "resolved 200 with 0 bytes");
    status = 503;
    is("so does a failure status", await outcome({ method: "POST", body: "{}", maxBytes: 16_384, timeoutMs: 5_000, statusOnly: true, ...hooks }), "resolved 503 with 0 bytes");
  }
  status = 200;

  part("Status only, small answers");
  size = 0;
  declare = true;
  is("an empty 200", await outcome({ method: "POST", body: "{}", maxBytes: 16_384, timeoutMs: 5_000, statusOnly: true, ...hooks }), "resolved 200 with 0 bytes");
  size = 10;
  declare = false;
  is("a short chunked 200", await outcome({ method: "POST", body: "{}", maxBytes: 16_384, timeoutMs: 5_000, statusOnly: true, ...hooks }), "resolved 200 with 0 bytes");

  part("Each call reached the server once");
  is("4 + 2 + 8 + 2 requests", bodies, 16);

  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
