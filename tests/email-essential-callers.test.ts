/**
 * SG2(17): every permissive counter that can admit a paid email must fail
 * closed before the delivery path. The helper's behavioral envelope is covered
 * in request-guard and essential-studio-allowance; this contract keeps the
 * remaining callers on that boundary without changing their limits.
 */
import fs from "node:fs";
import path from "node:path";
import { done, is, part } from "./check";

const root = process.cwd();
const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");

const expected = new Map<string, string[]>([
  ["lib/waitlist.ts", ["waitlist-address"]],
  ["lib/store-join.ts", ["join-address"]],
  ["lib/erasure-request.ts", ["erase-ip", "erase-address"]],
  ["lib/takedown.ts", ["report"]],
  ["lib/inbox.ts", ["inbox-new", "inbox-tell", "inbox-reply"]],
  ["app/api/store/resend/route.ts", ["resend-sale", "resend-store"]],
  ["app/api/store/address/route.ts", ["move-ask"]],
  ["app/api/auth/join/route.ts", ["join"]],
]);

part("SG2(17): the remaining paid-email callers refuse unknown counters");
for (const [file, scopes] of expected) {
  const source = read(file);
  is(`${file} imports the fail-closed allowance`, /\bwithinEssentialLimit\b/.test(source), true);
  for (const scope of scopes) {
    const strict = new RegExp(`withinEssentialLimit\\(\\s*["']${scope}["']`);
    const permissive = new RegExp(`withinLimit\\(\\s*["']${scope}["']`);
    is(`${file}: ${scope} refuses unknown evidence`, [strict.test(source), permissive.test(source)], [true, false]);
  }
}

const inbox = read("lib/inbox.ts");
is("chat start stays an ordinary non-delivery guard", /withinLimit\(\s*["']chat-start["']/.test(inbox), true);
is("chat messages stay ordinary until the separate mail admission", /withinLimit\(\s*["']chat-send["']/.test(inbox), true);

done();
