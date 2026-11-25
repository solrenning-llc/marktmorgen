/**
 * One door protocol for every studio upload (#3171; decision of the author family, Claude 4 coordinator 3rC, 21
 * November 2026, 19:06 UTC, option (a)): main's, from ff29bd12cf. The studio asks the route for the door itself, reads
 * a refusal there, and the file store's client asks the route again with that door in `x-upload-door`, which the
 * route hands back before anything else (lib/upload-door.ts). This PR's own askDoor and hand-back
 * (lib/upload-hand-back.ts) are gone, so no route answers two protocols.
 *
 * Holds:
 *   - RED: the picture route (app/api/store/image/upload) hands back exactly the door an echo carries, with nothing
 *     read, and refuses an echo that is not a door;
 *   - RED: no route, library or form keeps the hand-back;
 *   - RED: every studio uploader this PR covers (link pictures, the page editor, the product picture editor) goes
 *     through the one protocol, whose client sends the door in `x-upload-door` (lib/upload-through-door.ts), and the
 *     sold files keep main's (lib/sold-file-upload.ts uploadSoldFile).
 */
import { existsSync, readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { POST as picturePOST } from "@/app/api/store/image/upload/route";
import { DOOR_ECHO_HEADER } from "@/lib/upload-door";
import { done, is, part } from "./check";

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

async function echo(header: string): Promise<{ status: number; body: unknown }> {
  const request = new Request("https://upload.example.test/api/store/image/upload", {
    method: "POST",
    // Same site, as the studio's browser sends it (lib/request-guard.ts fromAnotherSite reads Sec-Fetch-Site without a Host).
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", [DOOR_ECHO_HEADER]: header },
    body: JSON.stringify({ type: "blob.generate-presigned-url", payload: { pathname: "x", clientPayload: "{}", multipart: false } }),
  }) as NextRequest;
  const response = await picturePOST(request);
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function main(): Promise<void> {
  part("RED: the picture route hands back the door an echo carries, and nothing else");
  {
    const door = { delegationToken: "synthetic-token", signature: "synthetic-signature", params: { pathname: "stores/x/p/a.png" } };
    const back = await echo(JSON.stringify(door));
    is("an echo of a door: that very door, as the client reads it", [back.status, back.body], [200, { type: "blob.generate-presigned-url", presignedUrlPayload: door }]);
    const bad = await echo("not a door");
    is("an echo that is not a door is refused, never taken for a first ask", [bad.status, bad.body], [400, { ok: false, error: "invalid" }]);
  }

  part("RED: no route, library or form keeps the hand-back");
  is("lib/upload-hand-back.ts is gone", existsSync("lib/upload-hand-back.ts"), false);
  for (const file of ["app/api/store/file/route.ts", "app/api/store/image/upload/route.ts", "lib/upload-refusal.ts", "lib/sold-file-upload.ts"]) {
    is(`${file} has no hand-back`, /upload-hand-back|handedBack|HAND_BACK/.test(read(file)), false);
  }
  is("both studio upload routes answer the one echo", ["app/api/store/file/route.ts", "app/api/store/image/upload/route.ts"].map((f) => read(f).includes("doorFromHeader(echoed)")), [true, true]);

  part("RED: every studio uploader goes through the one protocol");
  const client = read("lib/upload-through-door.ts");
  is("the one client asks the route itself and sends the door back in x-upload-door", /export async function askForDoor\(/.test(client) && client.includes("[DOOR_ECHO_HEADER]: JSON.stringify(door)"), true);
  is("sold files keep main's path, through the same client", /from "@\/lib\/upload-through-door"/.test(read("lib/sold-file-upload.ts")) && read("lib/sold-file-upload.ts").includes("uploadThroughDoor(UPLOAD_ROUTE"), true);
  for (const file of ["components/link-picture.tsx", "components/page-editor.tsx", "components/product-image-editor.tsx"]) {
    const form = read(file);
    is(`${file} uploads through the one protocol, never the client's bare uploadPresigned`, form.includes("uploadThroughDoor(") && !/from "@vercel\/blob\/client"/.test(form), true);
  }
  is("lib/upload-refusal.ts keeps only the words and hands the upload to the one client", /from "@\/lib\/upload-through-door"/.test(read("lib/upload-refusal.ts")) && !/askDoor/.test(read("lib/upload-refusal.ts")), true);
  done();
}

void main();
