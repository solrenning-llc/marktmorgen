/**
 * The waitlist launch email's one-click stop (lib/waitlist.ts, List-Unsubscribe-Post to /api/store/waitlist/leave?t=…,
 * RFC 8058) is let through the proxy when a mail app presses it from its own page, as /api/mail/unsubscribe is. The
 * route itself already takes a one-click POST with its token whatever site it comes from (the token is the whole key and
 * it only ever takes somebody off the waitlist), but proxy.ts answered 403 before the route was reached. Any other POST
 * from another site is still refused, the waitlist page's own button included (no token in the address).
 */
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { done, is, part } from "./check";

const HOST = "marktmorgen.com";
const oneClick = (path: string) => new NextRequest(`https://${HOST}${path}`, {
  method: "POST",
  headers: { host: HOST, origin: "https://mail.example.net", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded", "content-length": "26" },
  body: "List-Unsubscribe=One-Click",
});

async function main(): Promise<void> {
  part("Control: the list's one-click stop from a mail app's page passes the proxy");
  is("not refused", (await proxy(oneClick(`/api/mail/unsubscribe?t=${"a".repeat(32)}`))).status !== 403, true);

  part("The waitlist launch's one-click stop from a mail app's page passes too");
  is("not refused", (await proxy(oneClick(`/api/store/waitlist/leave?t=${"a".repeat(32)}`))).status !== 403, true);

  part("Any other POST from another site is still refused");
  is("joining a waitlist", (await proxy(oneClick("/api/store/waitlist/join"))).status, 403);
  is("a store write", (await proxy(oneClick("/api/store/product"))).status, 403);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
