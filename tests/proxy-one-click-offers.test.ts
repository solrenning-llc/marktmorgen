/**
 * The yearly offer's one-click stop (lib/yearly-offer.ts, List-Unsubscribe-Post to /api/store/offers?s=…&t=…,
 * RFC 8058) passes the proxy when a mail app presses it from its own page: the route checks the signed token itself,
 * and a POST there only ever stops. The route refuses its studio path (?via=studio, a session's press) from another
 * site on its own. Any other POST from another site is still refused by the proxy.
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
  part("The offers' one-click stop from a mail app's page passes the proxy");
  is("not refused", (await proxy(oneClick(`/api/store/offers?s=${"a".repeat(32)}&t=${"b".repeat(32)}`))).status !== 403, true);

  part("Any other POST from another site is still refused");
  is("a store write", (await proxy(oneClick("/api/store/product"))).status, 403);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
