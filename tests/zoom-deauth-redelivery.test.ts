/**
 * Zoom's "app_deauthorized" notice sent again after a first try failed, once the creator has connected Zoom again
 * (webhooks/cron audit, Claude 1, 12/11/2026). A failed try lets go of the notice's once-only mark, so Zoom's retry
 * is heard; Zoom signs each retry anew (its retries come minutes to hours later, past the five minutes a signature
 * is accepted), so the mark kept by signature never recognises it. The retry used to forget every connection of
 * that Zoom user, the one made since included: the creator's new connection gone, the owner told "disconnected",
 * and the new grant left alive at Zoom with nothing here that knows it. Now the notice's own removal time
 * (deauthorization_time) keeps a connection made after it, still in the user's index for that grant's own notice;
 * one made before it is forgotten as before.
 * Synthetic only: an in-memory Redis, no request to Zoom.
 */
import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/integrations/zoom/deauthorize/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.ZOOM_CLIENT_ID = "z-id";
process.env.ZOOM_CLIENT_SECRET = "z-secret";
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "z-token";

const USER = "zoom-user-again";
const STATS = "0123456789abcdef0123456789abcdef";
const CONN = `nl:meet:conn:${STATS}:zoom`;
const INDEX = `nl:meet:user:zoom:${createHash("sha256").update(`meet-user:zoom:${USER}`).digest("hex").slice(0, 40)}`;

let n = 0;
/** One signed app_deauthorized notice for the user, removed at `removed`; each send is signed anew, as a Zoom retry is. */
async function send(removed: number): Promise<number> {
  const body = JSON.stringify({ event: "app_deauthorized", payload: { user_id: USER, client_id: "z-id", deauthorization_time: new Date(removed).toISOString() } });
  const timestamp = String(Math.floor(Date.now() / 1000) + (n += 1));
  const signature = `v0=${createHmac("sha256", "z-token").update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const response = await POST(
    new NextRequest("https://marktmorgen.com/api/integrations/zoom/deauthorize", {
      method: "POST",
      headers: { "content-type": "application/json", "x-zm-request-timestamp": timestamp, "x-zm-signature": signature, "x-forwarded-for": `198.51.100.${n}` },
      body,
    }),
  );
  return response.status;
}

function connect(at: number): void {
  const connection = {
    provider: "zoom",
    account: { id: USER, email: "host@example.com", name: "Host" },
    access: "sealed-access",
    expires: at + 3_600_000,
    refresh: "sealed-refresh",
    scope: "meeting:write",
    connectedAt: at,
    by: "owner@example.com",
    owner: { email: "owner@example.com", handle: "zoomshop" },
    broken: "",
    brokenAt: 0,
  };
  redis.run(["SET", CONN, JSON.stringify(connection)]);
  redis.run(["SADD", INDEX, STATS]);
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const t0 = Date.now() - 3 * 3_600_000;
  const removed = t0 + 3_600_000;
  connect(t0);

  part("The notice's first try fails");
  const real = redis.pipeline.bind(redis);
  let fail = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (fail && commands.some((c) => c[0] === "SMEMBERS")) {
      fail = false;
      throw new Error("Synthetic: Redis timed out");
    }
    return real(commands);
  }) as typeof redis.pipeline;
  is("500, so Zoom sends it again", await send(removed), 500);
  redis.pipeline = real;

  part("The creator connects Zoom again, then Zoom sends the same notice again");
  connect(removed + 30 * 60_000);
  is("the retry is answered with a success", await send(removed), 200);
  is("the connection made since is kept", redis.run(["EXISTS", CONN]), 1);
  is("and stays in the user's index, for that grant's own notice", redis.run(["SISMEMBER", INDEX, STATS]), 1);

  part("Control: that grant's own removal, later, forgets it");
  is("answered", await send(removed + 60 * 60_000), 200);
  is("the connection is forgotten", redis.run(["EXISTS", CONN]), 0);
  is("and the index with it", redis.run(["EXISTS", INDEX]), 0);
  done();
}

void main();
