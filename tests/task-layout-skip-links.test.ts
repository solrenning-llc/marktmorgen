/**
 * 310 [AX2]: task pages expose one native skip link from their shared layout.
 *
 * This source-level contract is part of `npm test`. It keeps the server-rendered
 * link ahead of each layout's children and prevents a nested page from adding a
 * second, competing route to the same main landmark.
 */
import { existsSync, readFileSync } from "node:fs";
import { done, is, part } from "./check";

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const skip = read("components/skip-link.tsx");
const signIn = read("app/signin/layout.tsx");
const studio = read("app/studio/layout.tsx");
const refund = read("app/studio/refund/page.tsx");

const beforeChildren = (source: string) => {
  const link = source.indexOf("<SkipLink />");
  const children = source.indexOf("{children}");
  return link >= 0 && children >= 0 && link < children;
};

part("The shared link is a native route to the central landmark");
is("the shared component exists", skip.length > 0, true);
is("it is an ordinary in-page link", /<a\s+href=["']#content["']/.test(skip), true);
is("its purpose is visible when focused", /Skip to the page content/.test(skip) && /focus:not-sr-only/.test(skip), true);

part("Each task family renders it once, before its page");
is("sign-in imports the shared link", /import \{ SkipLink \} from ["']@\/components\/skip-link["'];/.test(signIn), true);
is("sign-in places the link before its children", beforeChildren(signIn), true);
is("studio imports the shared link", /import \{ SkipLink \} from ["']@\/components\/skip-link["'];/.test(studio), true);
is("studio places the link before its children", beforeChildren(studio), true);
is("the refund page leaves the layout as the only owner", /href=["']#content["']/.test(refund), false);

done();
