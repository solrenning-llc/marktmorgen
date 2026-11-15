/**
 * MM-SA-51 (docs/security-audit-2026-10-28.md; 506 [SG1]): the address move
 * (app/api/auth/move/route.ts) wrote both addresses, the old and the new, into
 * the server log when a failed move was left in an unknown state. A log is
 * kept by the host and read by whoever operates it; a person's email address
 * does not belong there (lib/person-data.ts keeps where a person's data lives).
 * The state is already kept for repair by `broke()` (the move's own record),
 * so the log needs neither address.
 *
 * What fails here: any console call in the route that is handed `from`, `to`
 * or an object holding them.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const route = readFileSync("app/api/auth/move/route.ts", "utf8");

part("The address move logs no address");
const calls = [...route.matchAll(/console\.(?:error|warn|log|info)\(([\s\S]*?)\);/g)].map((m) => m[1]);
is("the route still logs its failures (the check reads real calls)", calls.length > 5, true);
const withAddress = calls.filter((args) => /(^|[\s,{(])(from|to)\s*[,})]|\{\s*from\b|\bto\s*\}/.test(args.replace(/"[^"]*"|`[^`]*`/g, "")));
is("no console call is handed an address", withAddress, []);
is("the unknown state is still said, with no address", /console\.error\("a failed move left in an unknown state"\);/.test(route), true);
done();
