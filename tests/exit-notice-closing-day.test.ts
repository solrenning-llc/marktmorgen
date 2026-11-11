/**
 * A closing store's moved notice from its closing day on, while its record
 * still exists (97 [D2-OPEN-EXIT], unit 6: exitAnswerForStore in
 * lib/exit-redirect-rules.ts, app/[handle]/page.tsx).
 *
 * Between the closing day and the deletion of the store's record (within
 * ERASE_WITHIN_DAYS) the old address still finds the store. What fails here:
 *   - the notice not shown in those days, though the store has closed;
 *   - the notice shown before the closing day, after its 90 days, or from a
 *     record that does not read;
 *   - the page reading anything more for it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { done, is } from "./check";
import { EXIT_NOTICE_DAYS, exitAnswerForStore, type ExitNotice } from "@/lib/exit-redirect-rules";

const DAY = 86_400_000;
const closedAt = Date.UTC(2026, 11, 1);
const notice: ExitNotice = { to: "https://example.com/", host: "example.com", closedAt, setAt: closedAt - DAY };

const today = { day: closedAt, today: true };
is("no notice chosen: the store as always", exitAnswerForStore({}, today, closedAt + DAY), { kind: "none" });
is("before the closing day: the store as always", exitAnswerForStore({ exitNotice: notice }, { day: closedAt }, closedAt - 1), { kind: "none" });
is("on the closing day: the notice", exitAnswerForStore({ exitNotice: notice }, today, closedAt), { kind: "moved", to: notice.to, host: notice.host, until: closedAt + EXIT_NOTICE_DAYS * DAY });
is("days after it, the record not yet deleted: the notice", exitAnswerForStore({ exitNotice: notice }, today, closedAt + 10 * DAY).kind, "moved");
is("after the 90 days: gone, not the store", exitAnswerForStore({ exitNotice: notice }, today, closedAt + EXIT_NOTICE_DAYS * DAY), { kind: "gone" });
is("a record that does not read: the store as always", exitAnswerForStore({ exitNotice: { ...notice, to: "http://example.com/" } as ExitNotice }, today, closedAt + DAY), { kind: "none" });
is("an unknown clock: the store as always", exitAnswerForStore({ exitNotice: notice }, today, Number.NaN), { kind: "none" });

// Review of #3730: the notice only for a store whose closing day has really begun.
is("closing given up (closingOf null): the store as always, the old day past", exitAnswerForStore({ exitNotice: notice }, null, closedAt + DAY), { kind: "none" });
is("the closing could not be read: the store as always", exitAnswerForStore({ exitNotice: notice }, "unknown", closedAt + DAY), { kind: "none" });
is("the closing day moved later and not begun: the store as always, though the day chosen has passed", exitAnswerForStore({ exitNotice: notice }, { day: closedAt + 5 * DAY }, closedAt + DAY), { kind: "none" });
is("the day it really began counts for the 90 days", exitAnswerForStore({ exitNotice: notice }, { day: closedAt + 5 * DAY, today: true }, closedAt + 6 * DAY), { kind: "moved", to: notice.to, host: notice.host, until: closedAt + 5 * DAY + EXIT_NOTICE_DAYS * DAY });
is("a suspended store: never the notice", exitAnswerForStore({ exitNotice: notice, suspended: true }, today, closedAt + DAY), { kind: "none" });

const page = readFileSync(join(process.cwd(), "app/[handle]/page.tsx"), "utf8");
is("the page reads the closing only for a store with a notice that is not suspended", /if \(!store\.exitNotice \|\| store\.suspended\) return null;\s*const closing = await closingOf\(store\)/.test(page), true);
is("the notice page is never indexed", /closedNotice[\s\S]{0,200}robots: \{ index: false, follow: false \}/.test(page), true);

done();
