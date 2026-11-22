/**
 * The three defects of the store's profiles editor seen on 30 October 2026
 * in the demo store, from 571 [VS1]'s completeness complement of 5 November
 * 2026, part (2):
 *
 *   1. The screen says "paste the address of your profile: the network is
 *      picked for you", but a pasted web address on no known network stayed on
 *      the box's network and was shown as wrong. It now goes to "Website", as
 *      lib/store-socials.ts's networkFor already says it is, unless another
 *      box holds the website; a handle is never taken for a website.
 *   2. "This is not a Instagram handle or a Instagram address": the sentence
 *      no longer puts an article before the network's name.
 *   3. The note under each box broke words in the middle (break-all): it now
 *      breaks only where a long address has to.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SocialsEditor, networkPicked, problem } from "@/components/socials-editor";
import { SOCIAL_NETWORKS, SOCIALS, socialUrl } from "@/lib/store-socials";
import { done, is, part } from "./check";

part("1. A pasted web address on no known network is the website");
is("an https address on no network goes to Website", networkPicked("instagram", "https://marktmorgen.com", false), "website");
is("and it makes the address the store will link", socialUrl("website", "https://marktmorgen.com/@pia"), "https://marktmorgen.com/@pia");
is("an address on a known network still goes to it", [networkPicked("instagram", "https://www.youtube.com/@youtube", false), networkPicked("instagram", "https://www.tiktok.com/@pia", false)], ["youtube", "tiktok"]);
is("and a website box keeps any web address, as before", networkPicked("website", "https://www.tiktok.com/@pia", false), "website");
is("a box whose words already make its address keeps its network", [networkPicked("instagram", "@pia.bakes", false), networkPicked("website", "https://marktmorgen.com", true)], ["instagram", "website"]);
is("a handle is never taken for a website, nor a half-typed address", [networkPicked("instagram", "@pia", false), networkPicked("tiktok", "pia", false), networkPicked("instagram", "https://", false), networkPicked("instagram", "https://localhost", false)], ["instagram", "tiktok", "instagram", "instagram"]);
is("not when another box already holds the website: the box says what is wrong instead", networkPicked("instagram", "https://marktmorgen.com", true), "instagram");
is("an http address is not linked, so it is not moved either", networkPicked("instagram", "http://marktmorgen.com", false), "instagram");
const source = readFileSync("components/socials-editor.tsx", "utf8").replace(/\s+/g, " ");
is("the box's typing goes through it, with the website of the other boxes", source.includes('row.network = networkPicked(row.network, part.typed, rows.some((other) => other.key !== key && other.network === "website"));'), true);

part("2. No \"a Instagram\"");
const networks = SOCIAL_NETWORKS.filter((n) => n !== "email" && n !== "website" && SOCIALS[n].profile);
is("for every network with handles, the sentence has no article before the name", networks.filter((n) => /\ban? [A-Z]/.test(problem(n))).map((n) => problem(n)), []);
is("and says it plainly", problem("instagram"), "This is not a handle or an address on Instagram. Only addresses on Instagram itself are linked.");
const shown = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { push() {}, refresh() {}, prefetch() {} } as never }, createElement(SocialsEditor, { socials: [] })));
is("the editor still draws", shown.length > 0, true);

part("3. No word broken in the middle");
is("the note breaks only where an address has to", [source.includes('className={`mt-1.5 break-words text-xs'), source.includes("break-all")], [true, false]);

done();
