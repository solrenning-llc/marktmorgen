/**
 * Every function invocation a studio upload makes is priced (review of #3171 by Claude 6, LOW).
 *
 * A studio upload asks its door twice: once from askDoor (lib/upload-refusal.ts), which signs and counts the one
 * studio request, and once from the file store's own library, whose request the door answers by handing back what it
 * issued (lib/upload-hand-back.ts, handedBack). The second call counts nothing and runs no database command, but it is
 * a function invocation all the same, and unknown cost is never zero: the studio unit (tests/plan-cost-registry.ts,
 * UNIT_COST.studio) must carry it for a window spent entirely on uploads. Here the doors are stood in for, in the
 * routes' own order (handedBack first, then the signed path), and the invocations of one upload are counted.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handedBack } from "@/lib/upload-hand-back";
import { uploadThroughDoor } from "@/lib/upload-refusal";
import { done, is, part } from "./check";
import { LOCKED_UNTIL_STAR_COMMANDS, ORIGIN_PER_BYTE, TAKE_COMMANDS, UNIT_COST, request } from "./plan-cost-registry";

/** The body ceiling both doors read with (lib/request-guard.ts limited): what a hand-back can receive and send back at the most. */
const DOOR_BODY_BYTES = 16_000;
const DOORS = ["app/api/store/image/upload/route.ts", "app/api/store/file/route.ts"];

const door = { signed: 0, handedBack: 0 };
/** A synthetic delegation token in the library's own shape: a base64url JSON segment naming a store, then a signature segment. */
const delegationToken = `${Buffer.from(JSON.stringify({ storeId: "store_synthetic" })).toString("base64url")}.synthetic`;
const issued = { delegationToken, signature: "sig-synthetic", params: { pathname: "stores/f/images/a.webp", "valid-until": "1" } };

/** The doors and the file store, stood in for by one local server, so the library's own requests are the real ones. */
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/api/store/image/upload" || path === "/api/store/file") {
      // The routes' own order: a hand-back is answered before anything else; any other ask is signed and counted.
      const back = handedBack(JSON.parse(raw || "{}"));
      if (back) {
        door.handedBack += 1;
        res.end(JSON.stringify(back));
        return;
      }
      door.signed += 1;
      res.end(JSON.stringify({ type: "blob.generate-presigned-url", presignedUrlPayload: issued }));
      return;
    }
    // The file store taking the bytes.
    res.end(JSON.stringify({ url: "https://store.test/a.webp", downloadUrl: "https://store.test/a.webp?download=1", pathname: "stores/f/images/a.webp", contentType: "image/webp", contentDisposition: "inline" }));
  });
});

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  (globalThis as { location?: unknown }).location = { href: `${base}/studio/products` };
  process.env.VERCEL_BLOB_API_URL = `${base}/blob`;
  // askDoor's own request, from the browser's fetch, to the same server.
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    real(typeof input === "string" && input.startsWith("/") ? base + input : input, init)) as typeof fetch;

  part("one upload's door invocations");
  await uploadThroughDoor("stores/f/images/a.webp", new Blob(["x"], { type: "image/webp" }), {
    access: "private",
    door: "/api/store/image/upload",
    clientPayload: JSON.stringify({ productId: "p1" }),
    contentType: "image/webp",
  });
  is("the door signs and counts once per upload", door.signed, 1);
  is("and hands back what it issued once", door.handedBack, 1);
  const invocations = door.signed + door.handedBack;

  part("the hand-back runs nothing it is not priced at");
  for (const path of DOORS) {
    const source = readFileSync(path, "utf8");
    const start = source.indexOf("export async function POST");
    const end = source.indexOf("if (issued) return Response.json(issued);", start);
    const before = start >= 0 && end > start ? source.slice(start, end) : "";
    is(`${path}: answers a hand-back before anything is read or counted`, before.length > 0, true);
    is(`${path}: its only wait before the hand-back is the body, read under ${DOOR_BODY_BYTES} bytes`, before.match(/await [^;]*/g) ?? [], ["await (await limited(request, 16_000)).json()) as HandleUploadPresignedBody"]);
  }

  part("the studio unit carries every invocation of an upload");
  // The studio request the window counts, as priced before the hand-back existed.
  const studioRequest = request("studio", 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS, 50_000);
  // The hand-back: one more call at the lightest request's shape, no database command, its body received and sent back.
  const handBack = request("light", 0, 0) + 2 * DOOR_BODY_BYTES * ORIGIN_PER_BYTE;
  is(
    `UNIT_COST.studio covers ${invocations} invocations per upload (${UNIT_COST.studio} >= ${studioRequest} + ${invocations - 1} x ${handBack})`,
    UNIT_COST.studio >= studioRequest + (invocations - 1) * handBack,
    true,
  );
  server.close();
}

void main().then(done);
