/**
 * 654 [WG14], part (b1): a step on the Path, once recorded by the store's own
 * records, gets one sober milestone card on the Path page (lib/path-milestone-rules.ts,
 * components/path-milestone.tsx). Seen once and dismissible, remembered only in
 * this browser, so it adds no read and no key on our side. Its words name the
 * mission and nothing else: no amount, no ranking, no counter. A mission the
 * records no longer show as done (a full refund takes the sale away, in
 * lib/path-facts.ts) has no card, since only done missions are handed over.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PathMilestone } from "@/components/path-milestone";
import { MILESTONE_PREFIX, MILESTONE_SEEN_MOST, markSeen, milestoneKey, nextMilestone, readSeen } from "@/lib/path-milestone-rules";
import { done, is, part } from "./check";

const SID = "0123456789abcdef0123456789abcdef";
const TITLE = { id: "title", title: "Publish your store's title and one line about it" };
const SALE = { id: "sale", title: "Make your first real sale" };

part("Where the seen marks are kept: this browser, under the store's own key");
is("one key per store", milestoneKey(SID), `${MILESTONE_PREFIX}${SID}`);
is("nothing for an id we do not make", [milestoneKey(""), milestoneKey("ABC"), milestoneKey(`${SID}x`), milestoneKey("../x")], [null, null, null, null]);

part("What was seen, read back");
is("nothing kept yet: nothing seen", readSeen(null), []);
is("a kept list read back", readSeen(JSON.stringify(["title", "sale"])), ["title", "sale"]);
is("a value changed on the device is not trusted, so nothing is shown (never shown again and again)", [readSeen("{"), readSeen("{}"), readSeen(JSON.stringify([1])), readSeen(JSON.stringify(["Title!"])), readSeen("x".repeat(5000))], [null, null, null, null, null]);

part("Which card is shown: the first recorded step not seen yet, one at a time");
is("the first done mission not seen", nextMilestone([TITLE, SALE], []), TITLE);
is("the next once the first was seen", nextMilestone([TITLE, SALE], ["title"]), SALE);
is("none once every one was seen", nextMilestone([TITLE, SALE], ["title", "sale"]), null);
is("none when what was seen could not be read", nextMilestone([TITLE, SALE], null), null);
is("none when no step is recorded (a refunded sale is no longer a done mission)", nextMilestone([], []), null);
is("an id we do not make is never shown", nextMilestone([{ id: "Bad id", title: "x" }], []), null);

part("Marking one seen");
is("added once", markSeen(["title"], "sale"), JSON.stringify(["title", "sale"]));
is("not twice", markSeen(["title"], "title"), JSON.stringify(["title"]));
const many = Array.from({ length: MILESTONE_SEEN_MOST + 5 }, (_, i) => `traffic-${i + 1}`);
is("kept to the newest MILESTONE_SEEN_MOST", JSON.parse(markSeen(many, "sale")).length, MILESTONE_SEEN_MOST);
is("the one just seen is kept", JSON.parse(markSeen(many, "sale")).includes("sale"), true);

part("The card: nothing drawn before the browser is read");
is("server markup is empty, so nothing shows that is not there", renderToStaticMarkup(createElement(PathMilestone, { sid: SID, done: [TITLE], shareHref: "#path-share-title" })), "");
const card = readFileSync("components/path-milestone.tsx", "utf8");
is("a named section with its own heading, and the words name the step", [/aria-labelledby="path-milestone-heading"/.test(card), /<h2 id="path-milestone-heading"/.test(card), /Step recorded/.test(card), /\{shown\.title\}/.test(card)], [true, true, true, true]);
const shownText = card.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/\$\{[^}]*\}/g, "");
is("no amount, ranking, counter or confetti in what it draws", /\$|%|rank|confetti|\bof \d/i.test(shownText), false);
is("dismiss and share are real controls at least 44 px tall (2.5.5)", [/<button[^>]*type="button"[^>]*className="btn btn-sm[^"]*"/.test(card), /Dismiss/.test(card), /Share a thank-you/.test(card), /href=\{shareHref\}/.test(card)], [true, true, true, true]);
is("the share link is drawn only where the page has a card to share", /shareHref \?/.test(card), true);
const css = readFileSync("app/globals.css", "utf8");
is("the drawn line uses nb-draw, once, only when motion is welcome", /@media \(prefers-reduced-motion: no-preference\) \{\s*\.mm-milestone-line \{\s*animation: nb-draw [0-9]+ms ease-out 1 both;/.test(css), true);
is("complete without motion", /\.mm-milestone-line \{[^}]*transform-origin: left;/.test(css), true);

part("The Path page hands over only recorded missions");
const page = readFileSync("app/studio/path/page.tsx", "utf8");
is("done missions only, and the share card's anchor only when there is a card", [/<PathMilestone sid=\{store\.sid\} done=\{\[\.\.\.progress\.days,\.\.\.progress\.traffic\]\.filter\(m=>m\.state==="done"\)\.map\(m=>\(\{id:m\.id,title:m\.title\}\)\)\} shareHref=\{shareable\?"#path-share-title":null\}\/>/.test(page), /const shareable=/.test(page)], [true, true]);
is("never while the Path could not be read", /\{!failed&&!returning\?<PathMilestone/.test(page), true);

done();
