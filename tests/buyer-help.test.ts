/**
 * 630 [HN6](34): help for buyers on marktmorgen.com. Every answer points to
 * a page that exists today, says what Marktmorgen cannot do, and is written
 * in plain words; the page is reachable from the help center and the sitemap.
 */
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BUYER_HELP } from "@/lib/buyer-help";
import BuyerHelpPage from "@/app/help/buyers/page";
import { done, is, part } from "./check";

part("What a buyer asks");
is("the five things of 630 (34), and two more", BUYER_HELP.map((i) => i.id), ["find", "receipt", "cancel", "refund", "contact", "charge", "us"]);
is("each question once, each id once", [new Set(BUYER_HELP.map((i) => i.q)).size, new Set(BUYER_HELP.map((i) => i.id)).size], [BUYER_HELP.length, BUYER_HELP.length]);
is("every page an answer sends to exists", BUYER_HELP.flatMap((i) => i.routes).filter((r) => !existsSync(r)), []);
const all = BUYER_HELP.flatMap((i) => i.a).join(" ");
const paths = [...all.matchAll(/marktmorgen\.com(\/[a-z@/-]*)/g)].map((m) => m[1]);
const routeOf = (path: string) => (path === "/library" ? "app/library/page.tsx" : path.replace(/^\/@[a-z-]+/, "app/[handle]").replace(/\/?$/, "/page.tsx"));
is("every address written in an answer is a page that exists", paths.filter((p) => !existsSync(routeOf(p))), []);
is("refunds: the store decides and the money went to the creator", /Each store decides its own refunds/.test(all) && /does not hold your payment/.test(all), true);
is("what we cannot do is said plainly", /cannot see your card, change an order or send a refund/.test(all), true);
is("no promise we cannot keep", /\b(guarantee|always refund|we will refund|instantly|24\/7)\b/i.test(all), false);
const sentences = all.split(/(?<=[.!?])\s+/);
is("short sentences: none over 30 words", sentences.filter((s) => s.split(/\s+/).length > 30), []);

part("The page");
const html = renderToStaticMarkup(createElement(BuyerHelpPage));
is("one h1, an h2 per question", [(html.match(/<h1/g) ?? []).length, (html.match(/<h2/g) ?? []).length], [1, BUYER_HELP.length]);
is("every answer is open, not folded away", html.includes("<details"), false);
is("each question has its own anchor, listed at the top", BUYER_HELP.every((i) => html.includes(`id="${i.id}"`) && html.includes(`href="#${i.id}"`)), true);
is("a breadcrumb back to the help center", /aria-label="Breadcrumb"/.test(html) && html.includes('aria-current="page"'), true);
is("the date it was checked against the product", html.includes("Checked against the product on November 3, 2026."), true);

part("Where it is found");
is("linked from the help center", readFileSync("app/help/page.tsx", "utf8").includes('<Link href="/help/buyers" className="link font-medium">Help for buyers</Link>'), true);
is("in the sitemap", readFileSync("app/sitemap.ts", "utf8").includes('{ path: "/help/buyers", priority: 0.5 }'), true);

done();
