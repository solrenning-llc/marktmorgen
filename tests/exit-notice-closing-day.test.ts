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

is("no notice chosen: the store as always", exitAnswerForStore({}, closedAt + DAY), { kind: "none" });
is("before the closing day: the store as always", exitAnswerForStore({ exitNotice: notice }, closedAt - 1), { kind: "none" });
is("on the closing day: the notice", exitAnswerForStore({ exitNotice: notice }, closedAt), { kind: "moved", to: notice.to, host: notice.host, until: closedAt + EXIT_NOTICE_DAYS * DAY });
is("days after it, the record not yet deleted: the notice", exitAnswerForStore({ exitNotice: notice }, closedAt + 10 * DAY).kind, "moved");
is("after the 90 days: gone, not the store", exitAnswerForStore({ exitNotice: notice }, closedAt + EXIT_NOTICE_DAYS * DAY), { kind: "gone" });
is("a record that does not read: the store as always", exitAnswerForStore({ exitNotice: { ...notice, to: "http://example.com/" } as ExitNotice }, closedAt + DAY), { kind: "none" });
is("an unknown clock: the store as always", exitAnswerForStore({ exitNotice: notice }, Number.NaN), { kind: "none" });

const page = readFileSync(join(process.cwd(), "app/[handle]/page.tsx"), "utf8");
is("the page asks the store it already read", /exitAnswerForStore\(store, Date\.now\(\)\)|exitAnswerForStore\(found\.store/.test(page) || /closingNotice\(found\.store\)/.test(page), true);

done();
