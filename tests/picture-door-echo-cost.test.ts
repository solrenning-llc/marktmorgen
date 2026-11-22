/**
 * The picture door's second call is priced (#3171, one door protocol for every studio upload).
 *
 * Every studio picture upload asks the picture route for its door itself (lib/upload-through-door.ts askForDoor), a
 * studio request the window counts; the file store's client then asks the route again with that door in
 * x-upload-door, and the route hands it back before anything is read, counted or signed. That call is a call: the line
 * picture-door-echo prices it once for every studio request, at the plan's studio figure, a hard ceiling.
 */
import { readFileSync } from "node:fs";
import { COST_LINES, ORIGIN_PER_BYTE, PICTURE_DOOR_ECHO, request } from "./plan-cost-registry";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { MAX_DOOR_BYTES } from "@/lib/upload-door";
import { done, is, part } from "./check";

const route = readFileSync("app/api/store/image/upload/route.ts", "utf8");
const line = COST_LINES.find((each) => each.id === "picture-door-echo");

part("What the echo does, as the line prices it");
const echo = route.indexOf("doorFromHeader(echoed)");
is("the picture route answers the echo", echo > 0, true);
is("before the studio is counted, the body read or a token signed", echo < route.indexOf("studioAccess(") && echo < route.indexOf("limited(request, 16_000)") && echo < route.indexOf("issueSignedToken("), true);
is("a first ask is read at 16_000 bytes at the most", /limited\(request, 16_000\)/.test(route), true);
is("the door's header is taken at MAX_DOOR_BYTES at the most", MAX_DOOR_BYTES, 8_000);

part("Its price: one light call, the header and a first ask's body in, the door back out");
is("PICTURE_DOOR_ECHO", Math.abs(PICTURE_DOOR_ECHO - (request("light", 0, 0) + (2 * MAX_DOOR_BYTES + 16_000 + 64) * ORIGIN_PER_BYTE)) < 1e-15, true);
is("a line of its own", Boolean(line), true);
for (const tier of ["creator", "pro", "scale"] as const) {
  is(`${tier}: once for every studio request`, Math.abs((line?.monthlyUsd(tier) ?? 0) - STORE_ALLOWANCES[tier].studio * PICTURE_DOOR_ECHO) < 1e-12, true);
}
is("the line names the echo among its sources", Boolean(line?.sources.some((source) => source.file === "app/api/store/image/upload/route.ts" && source.names.includes("doorFromHeader(echoed)"))), true);
done();
