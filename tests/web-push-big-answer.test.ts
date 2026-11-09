/**
 * A push service that accepted the message (2xx) with a body above the read
 * cap is a sent message (Claude 5 outbound audit, 9 Nov 2026, MEDIUM 1, rule
 * 30: lib/web-push.ts reads only the status, like lib/webhooks.ts). Before,
 * lib/safe-fetch.ts refused the answer as too big while holding the 2xx, and
 * sendPush reported a failure for a notification that was delivered.
 *
 * Only a local server: the name lookup and the socket are redirected, and the
 * VAPID pair and the device keys are made here. No request leaves the machine.
 */
import { createECDH, createPrivateKey, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { type VapidKeys, sendPush } from "@/lib/web-push";
import { done, is, part } from "./check";

let size = 0;
let status = 201;
let declare = true;

const server = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.writeHead(status, { "Content-Type": "text/html", ...(declare ? { "Content-Length": String(size) } : {}) });
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

function vapid(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey();
  const privateKey = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: ecdh.getPrivateKey().toString("base64url"), x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33, 65).toString("base64url") },
    format: "jwk",
  });
  return { publicKey: pub.toString("base64url"), privateKey, kid: "test-kid" };
}

function device() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: "https://fcm.googleapis.com/fcm/send/device-1", p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const hooks = { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never };
  const keys = vapid();

  for (const [bytes, declared] of [[20_000, true], [200_000, false]] as const) {
    part(`201 with ${bytes} bytes ${declared ? "and" : "without"} a Content-Length`);
    size = bytes;
    declare = declared;
    status = 201;
    const sent = await sendPush(device(), "{}", { hooks, keys });
    is("the push is sent", [sent.ok, sent.status, sent.error], [true, 201, ""]);
    status = 410;
    const gone = await sendPush(device(), "{}", { hooks, keys });
    is("a 410 with a big body is still the device gone", [gone.ok, gone.status, gone.gone], [false, 410, true]);
  }

  part("A small answer, as before");
  size = 0;
  declare = true;
  status = 201;
  const small = await sendPush(device(), "{}", { hooks, keys });
  is("sent", [small.ok, small.status], [true, 201]);

  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
