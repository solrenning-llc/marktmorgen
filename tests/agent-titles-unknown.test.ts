/**
 * Rule 24 on the studio's AI proposals page (VR item 2). When the products' titles cannot be read, a proposal is
 * not labeled "a product you have since removed", which could make the creator decline a valid proposal: it says
 * the name could not be read. A product the store no longer has is still labeled removed (control).
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

async function main(): Promise<void> {
  const mod = (await import("@/lib/agent-proposal-label").catch(() => null)) as null | {
    proposalLabel: (kind: string, target: string, titles: Map<string, string> | null) => string;
  };
  const label = mod?.proposalLabel ?? (() => "missing");
  const known = new Map([["p1", "Guide"]]);
  is("control: a known product is named", label("product.description", "p1", known), "Description of Guide");
  is("control: a product the store no longer has is said removed", label("product.description", "gone", known), "Description of a product you have since removed");
  const unread = label("product.description", "p1", null);
  is("unread titles: never 'since removed'", /removed/.test(unread), false);
  is("unread titles: said in words", unread, "Description of a product whose name could not be read just now");
  is("control: another kind is shown as it is", label("store.name", "", null), "store.name");

  const page = readFileSync("app/studio/agent/page.tsx", "utf8");
  is("the page reads titles exactly and never as none", /readListingsExact\(store, targets\)\.catch\(\(\) => null\)/.test(page) && !/readListings\(store, targets\)\.catch\(\(\) => \[\]\)/.test(page), true);
  done();
}

void main();
