/**
 * AX274 (WCAG 2.2 3.3.1, 4.1.3 and 2.4.3 Focus Order): after posting, commenting, voting in a poll, sending a
 * message or answering an event, a community page loads afresh with a notice ("Posted.", or why it was refused),
 * and the focus started at the top of the new page: a screen reader user had no word of what happened. Each of
 * those notices is now drawn by the shared ArrivalNotice (components/arrival-notice.tsx), which takes the focus
 * once when the page arrives and is read where it stands, as the letters page already does.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const pages = [
  "app/[handle]/community/page.tsx",
  "app/[handle]/community/post/[post]/page.tsx",
  "app/[handle]/community/you/page.tsx",
  "app/[handle]/community/search/page.tsx",
  "app/[handle]/community/events/page.tsx",
  "app/[handle]/community/events/[event]/page.tsx",
  "app/[handle]/community/messages/page.tsx",
  "app/[handle]/community/messages/[pair]/page.tsx",
];

part("A notice after a form takes the focus once");
for (const path of pages) {
  const source = readFileSync(path, "utf8");
  is(`${path}: drawn by ArrivalNotice`, /<ArrivalNotice className=\{`cm-flash [^`]*`\}>\{notice\.text\}<\/ArrivalNotice>/.test(source), true);
  is(`${path}: no unfocused notice left`, /role="status">\{notice\.text\}<\/p>/.test(source), false);
  is(`${path}: imports it`, source.includes('import { ArrivalNotice } from "@/components/arrival-notice";'), true);
}

const notice = readFileSync("components/arrival-notice.tsx", "utf8");
is("the shared notice is a status that takes focus once", notice.includes('role="status"') && notice.includes("tabIndex={-1}") && notice.includes("}, []);"), true);

done();
