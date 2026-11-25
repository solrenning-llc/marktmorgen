/**
 * The pages of a course's certificates in the studio (#4304; Claude 5 ic5y3's LEVE 3 on #5481): the page a request
 * asks for, the address of another page (it keeps the page's other choices, writes the store once, writes `certs=`
 * only above the first page, and ends on the certificates' heading), and the page's own use of them: the two links,
 * the empty page's sentence and the heading's count. Synthetic only.
 */
import { readFileSync } from "node:fs";
import { certsHref, certsPageOf } from "@/lib/certificate-pages";
import { done, is, part } from "./check";

const store = { sid: "s1" };
const queryOf = (href: string) => new URL(href, "https://marktmorgen.com").searchParams;

part("The page asked for");
is("a whole number of up to six digits is that page", [certsPageOf("0"), certsPageOf("3"), certsPageOf("999999")], [0, 3, 999_999]);
is("anything else is the first page", [certsPageOf(undefined), certsPageOf(""), certsPageOf("-1"), certsPageOf("1.5"), certsPageOf("1000000"), certsPageOf(["2"]), certsPageOf("2x")], [0, 0, 0, 0, 0, 0, 0]);

part("The address of another page");
const older = certsHref(store, "prod1", { store: "s1", lesson: "l1", work: "all", certs: "1" }, 2);
is("on the course's own studio page, ending on the certificates' heading", [new URL(older, "https://marktmorgen.com").pathname, older.endsWith("#certificates")], ["/studio/course/prod1", true]);
is("the page's other choices are kept, the store written once, the page asked for written", [queryOf(older).get("lesson"), queryOf(older).get("work"), queryOf(older).getAll("store"), queryOf(older).getAll("certs")], ["l1", "all", ["s1"], ["2"]]);
const newest = certsHref(store, "prod1", { lesson: "l1", certs: "1" }, 0);
is("the first page writes no certs= at all", [queryOf(newest).has("certs"), queryOf(newest).get("lesson")], [false, "l1"]);
is("a list value in the query is not copied", queryOf(certsHref(store, "prod1", { work: ["a", "b"] }, 1)).has("work"), false);
is("a page that is not a whole number above 0 writes no certs=", [queryOf(certsHref(store, "prod1", {}, -1)).has("certs"), queryOf(certsHref(store, "prod1", {}, 1.5)).has("certs")], [false, false]);

part("The studio course page uses them");
const page = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
is("it reads the page asked for and builds every page link through lib/certificate-pages", [page.includes("certsPageOf(query.certs)"), page.includes("certsHref(store, product.id, query, to)"), /certsHrefTo\(certsPage - 1\)[\s\S]*Newer certificates/.test(page), /certsHrefTo\(certsPage \+ 1\)[\s\S]*Older certificates/.test(page)], [true, true, true, true]);
is("the newer link only past the first page, the older one only when more follow", [/\{certsPage > 0 \? \(\s*<Link href=\{certsHrefTo\(certsPage - 1\)\}/.test(page), /\{certificates\.more \? \(\s*<Link href=\{certsHrefTo\(certsPage \+ 1\)\}/.test(page), page.includes("{certsPage > 0 || certificates.more ? (")], [true, true, true]);
is("an empty later page says so, never the course's empty state", /certsPage > 0\s*\?\s*"No certificates on this page\. Go back to the newer ones\."/.test(page), true);
is("the heading counts the standing certificates, never the rows of one page", [page.includes("const standing = certificates ? certificates.standing : null;"), /Completions \\u00b7 \$\{standing\}/.test(page), page.includes("certificates.list.length} certificates issued")], [true, true, false]);
is("a first page that lists none with some waiting lets the note speak once, without \"older\"", [page.includes("certsPage === 0 && certificates.unlisted > 0 ? null"), page.includes('certificates.list.length === 0 && certsPage === 0 ? "" : " older"')], [true, true]);
is("the sentence for records that cannot be shown is plain and agrees in number", [page.includes("None of this course's certificates can be shown here. Their records are missing or can't be read."), page.includes("No certificate of this course can be shown here")], [true, false]);

done();
