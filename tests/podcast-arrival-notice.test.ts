/**
 * AX274 (WCAG 2.2 3.3.1, 4.1.3 and 2.4.3): asking for a private podcast's feed by email is a plain form answered by
 * a redirect (?status=sent, email, limited or error). The page loaded afresh with its answer in a live region that
 * was already there at load, so a screen reader was not told, and the focus started at the top. The answer is now
 * drawn by the shared ArrivalNotice (components/arrival-notice.tsx), which takes the focus once on arrival, as the
 * letters page's "?link=sent" does; and when the address was refused, the email field points at why.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const page = readFileSync("app/[handle]/podcast/[product]/page.tsx", "utf8");

part("The feed request's answer is reached");
is("imported", page.includes('import { ArrivalNotice } from "@/components/arrival-notice";'), true);
is("the answer is an ArrivalNotice", /<ArrivalNotice className="mt-5">\s*<p className="font-semibold"[^>]*>\{notice\.title\}<\/p>/.test(page), true);
is("no live region drawn at load is left", /role=\{status === "sent" \? "status" : "alert"\}/.test(page), false);
is("the refused address's field is described by why", /describedBy=\{status === "email" \? `podcast-why-\$\{product\.id\}` : undefined\}/.test(page), true);
is("…and the reason carries that id", /<p id=\{`podcast-why-\$\{product\.id\}`\} className="st-muted mt-1">\{notice\.body\}<\/p>/.test(page), true);

done();
