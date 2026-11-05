import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const storeLayout = readFileSync("app/[handle]/layout.tsx", "utf8");
const storeNotFound = readFileSync("app/[handle]/not-found.tsx", "utf8");
const siteNotFound = readFileSync("app/not-found.tsx", "utf8");
const siteNav = readFileSync("components/site-nav.tsx", "utf8");

const storeLayoutAddsSkip = /\{store\s*\?\s*<SkipLink \/>\s*:\s*null\}/.test(storeLayout);
const suspendedUsesSiteNotFound = /if \(!store \|\| store\.suspended\) return <SiteNotFound \/>/.test(storeNotFound);
const siteNotFoundUsesSiteNav = /<SiteNav \/>/.test(siteNotFound);
const siteNavAddsSkip = /href=["']#content["']/.test(siteNav);

part("A suspended creator-store fallback still exposes one route to content");
is("a resolved store receives the shared store-layout link", storeLayoutAddsSkip, true);
is("a suspended store chooses the global not-found page", suspendedUsesSiteNotFound, true);
is("the global not-found page renders the site navigation", siteNotFoundUsesSiteNav, true);
is("the site navigation owns its existing content link", siteNavAddsSkip, true);
is(
  "the composed suspended-store fallback has one content link, not two",
  Number(storeLayoutAddsSkip) + Number(suspendedUsesSiteNotFound && siteNotFoundUsesSiteNav && siteNavAddsSkip),
  1,
);
done();
