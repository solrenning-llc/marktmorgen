/**
 * A feed's address with anything after "?" is sent to the feed's own address (audit of private podcasts, 9 November
 * 2026, L1).
 *
 * The CDN keeps a feed under its exact address for FEED_SHARED_SECONDS, and a feed may be put together only
 * FEED_READS_A_DAY times a day (lib/podcast-access.ts, feedReadAllowed). Whoever has a feed's address could add
 * "?x=<anything>", miss the CDN's copy every time and spend the day's count in eight requests: the subscriber's own app
 * then got "Too many requests" for hours. The proxy now answers any such GET with a permanent redirect to the address
 * without the query, before the route runs: nothing is counted or read, and the CDN's copy answers the app.
 *
 * Synthetic only: the proxy is called with requests built here.
 */
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { done, is, part } from "./check";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const BASE = `https://marktmorgen.com/api/store/podcast/feed/${TOKEN}.xml`;
const get = (url: string, method = "GET") => proxy(new NextRequest(url, { method, headers: { host: "marktmorgen.com" } }));

async function main(): Promise<void> {
  part("A feed asked for with a query");
  const asked = await get(`${BASE}?x=123`);
  is("sent on for good (308)", asked.status, 308);
  is("to the feed's own address, with no query", asked.headers.get("Location"), BASE);
  const many = await get(`${BASE}?a=1&b=2`);
  is("whatever the query", many.headers.get("Location"), BASE);
  const head = await get(`${BASE}?x=1`, "HEAD");
  is("a HEAD too", head.status, 308);

  part("Left alone");
  const plain = await get(BASE);
  is("the feed's own address goes on to the route", plain.status, 200);
  is("with no redirect", plain.headers.get("Location"), null);
  const episode = await get(`https://marktmorgen.com/api/store/podcast/play/${TOKEN}/aaaaaaaaaaa1.mp3?x=1`);
  is("an episode's address is not the feed's", episode.headers.get("Location"), null);
  done();
}

void main();
