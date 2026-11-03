/**
 * 630 [HN6](2), unit 3: an approved affiliate sees, on their own panel
 * (app/affiliate/page.tsx), a cut the creator announced and its day
 * (lib/affiliate-notice.ts noticeFor). Said only when something gets worse
 * for them; an affiliate with a share of their own hears only of a product
 * taken out and of the window; the panel says their terms stay until then.
 */
import { readFileSync } from "node:fs";
import { noticeFor } from "@/lib/affiliate-notice";
import { done, is, part } from "./check";

const DAY = 86_400;
const FROM = Date.UTC(2026, 11, 2) / 1000;
const current = { percent: 30, rates: { prod000001: 40 }, days: 60 };
const names = (id: string) => (id === "prod000001" ? "Knife Skills" : null);

part("What an affiliate is told");
const store = noticeFor(current, { percent: 20, rates: { prod000001: 0 }, days: 30, from: FROM }, null, names);
is("the day, in words, UTC", store?.day, "December 2, 2026");
is("the share, the window and the product taken out", store?.lines, ["Commission: 30% becomes 20%.", "Days a click counts: 60 becomes 30.", "Knife Skills: leaves the program (was 40%)."]);
const own = noticeFor(current, { percent: 20, rates: { prod000001: 0 }, days: 30, from: FROM }, 50, names);
is("with a share of their own: only the product taken out and the window", own?.lines, ["Days a click counts: 60 becomes 30.", "Knife Skills: leaves the program (was 50%)."]);
is("with a share of their own and only the store share cut: nothing to say", noticeFor(current, { percent: 20, rates: { prod000001: 40 }, days: 60, from: FROM }, 50, names), null);
is("nothing announced: nothing", noticeFor(current, null, null, names), null);
is("the day is the one kept", noticeFor(current, { percent: 10, rates: {}, days: 60, from: FROM + DAY }, null, names)?.day, "December 3, 2026");

part("The panel");
const page = readFileSync("app/affiliate/page.tsx", "utf8");
is("only for approved affiliates", page.includes('if (!pending || affiliate.status !== "approved") return null;'), true);
is("a named note with the day and a list", page.includes('role="note"') && page.includes("gave notice: on ${cut.day} (UTC), these change.") && page.includes("<ul"), true);
is("says the terms stay until then", page.includes("Until then your terms stay as they are"), true);
done();
