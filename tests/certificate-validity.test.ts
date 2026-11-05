/**
 * 639 [GL7](32): how long a course's certificates stay valid (lib/course.ts,
 * lib/certificate.ts, the certificate page, its PDF, the studio). Kept only
 * from 1 to 120 months; fixed on each certificate when it is issued; a
 * month later on a short month falls on its last day; a certificate past its
 * day says it expired and still says what it certified; LinkedIn's form gets
 * the expiration; the words exist in every buyer language; the studio's
 * field saves through the route with the very body it sends (the action
 * "cert-months" was once cut to "cert-month" and answered 400), and its
 * label says the unit (WCAG 1.3.1, 3.3.2).
 */
import { readFileSync } from "node:fs";
import { editCourse, emptyCourse, parseCourse, readCertificateMonths, readCourse } from "@/lib/course";
import { linkedInAddUrl, monthsAfter, standingOf } from "@/lib/certificate";
import { coursesWords } from "@/lib/buyer-words/courses";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { CertificateValidity } from "@/components/certificate-validity";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

part("The setting");
is("1 to 120 months, anything else none", [readCertificateMonths(1), readCertificateMonths("12"), readCertificateMonths(120), readCertificateMonths(0), readCertificateMonths(121), readCertificateMonths(1.5)], [1, 12, 120, null, null, null]);
const course = emptyCourse();
const set = editCourse(course, { op: "certificate-months", months: 24 });
is("kept on the course", set.ok ? set.course.certificateMonths : null, 24);
is("read back from storage", set.ok ? parseCourse(JSON.stringify(set.course))?.certificateMonths : null, 24);
is("out of range: refused", editCourse(course, { op: "certificate-months", months: 500 }).ok, false);
const cleared = set.ok ? editCourse(set.course, { op: "certificate-months", months: null }) : null;
is("cleared: for good again", cleared?.ok ? cleared.course.certificateMonths : "x", undefined);
is("a course saved before it existed has none", parseCourse(JSON.stringify({ id: course.id, modules: [], certificate: true, startsAt: null }))?.certificateMonths, undefined);

part("The day it ends");
const jan31 = Date.UTC(2026, 0, 31, 10) / 1000;
is("a month after 31 January is the last day of February", new Date(monthsAfter(jan31, 1) * 1000).toISOString().slice(0, 10), "2026-02-28");
is("twelve months after is the same day a year on", new Date(monthsAfter(Date.UTC(2026, 10, 3, 9) / 1000, 12) * 1000).toISOString().slice(0, 10), "2027-11-03");
is("standing: valid, expired, withdrawn", [standingOf({ withdrawnAt: 0, validUntil: 100 }, 50), standingOf({ withdrawnAt: 0, validUntil: 100 }, 101), standingOf({ withdrawnAt: 5, validUntil: 100 }, 50), standingOf({ withdrawnAt: 0 }, 10 ** 10)], ["valid", "expired", "withdrawn", "valid"]);
const url = linkedInAddUrl({ id: "abcdefgh12345678", title: "First Aid", creator: "Harbor", issuedAt: Date.UTC(2026, 10, 3) / 1000, validUntil: Date.UTC(2028, 10, 3) / 1000 }, "https://marktmorgen.com/@h/certificate/abcdefgh12345678");
is("LinkedIn's form gets the expiration", [new URL(url).searchParams.get("expirationYear"), new URL(url).searchParams.get("expirationMonth")], ["2028", "11"]);

part("Said where it is read");
const w = coursesWords("en");
is("the words", [w.validUntil("May 1, 2027"), w.expiredOn("May 1, 2027")], ["Valid until May 1, 2027.", "This certificate expired on May 1, 2027."]);
for (const lang of ["es", "fr", "de", "it", "nl", "pt"]) is(`${lang}: its own`, coursesWords(lang).expiredOn("D") !== w.expiredOn("D"), true);
const page = readFileSync("app/[handle]/certificate/[id]/page.tsx", "utf8");
is("the page says expired, in a status", page.includes('standingOf(certificate') && page.includes("w.expiredOn("), true);
is("the PDF says until when", readFileSync("app/[handle]/certificate/[id]/pdf/route.ts", "utf8").includes("w.validUntil("), true);
is("the issue fixes it from the course", readFileSync("lib/certificate.ts", "utf8").includes("certificate.validUntil = monthsAfter(certificate.issuedAt, input.course.certificateMonths)"), true);

async function main(): Promise<void> {
  part("Saved from the studio, through the route");
  const field = readFileSync("components/certificate-validity.tsx", "utf8");
  const sent = /action: "([^"]+)", months:/.exec(field)?.[1] ?? "";
  is("the field sends cert-months", sent, "cert-months");
  const owner = "validity@example.com";
  await claimHandle(owner, "firstaidpro", "First Aid Pro", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Validxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_valid", subscriptionId: "sub_valid", active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(owner);
  const post = async (body: Record<string, unknown>) => {
    const response = await courseRoute(new NextRequest("https://marktmorgen.com/api/store/course", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  const made = await addProduct(owner, "First Aid Basics", "", "40");
  const id = made.ok ? made.product.id : "";
  is("a course is made", (await post({ action: "enable", id })).body.ok, true);
  const courseId = (await readListing((await storeForEmail(owner))!, id))!.course!.id;
  // The very body components/certificate-validity.tsx sends for "12".
  const saved = await post({ id, action: sent, months: Number("12") });
  is("12 months: answered and kept", [saved.status, saved.body.ok, (await readCourse(courseId))?.certificateMonths], [200, true, 12]);
  const cleared = await post({ id, action: sent, months: null });
  is("emptied: for good again", [cleared.status, cleared.body.ok, (await readCourse(courseId))?.certificateMonths], [200, true, undefined]);
  const wrong = await post({ id, action: sent, months: 500 });
  is("out of range: the error the field explains", [wrong.status, wrong.body.error], [400, "months"]);

  const route = readFileSync("app/api/store/course/route.ts", "utf8");
  const limit = Number(/const action = text\(body\.action, (\d+)\)/.exec(route)?.[1] ?? 0);
  const actions = [...route.matchAll(/action === "([^"]+)"/g)].map((m) => m[1]);
  is("every action the route answers fits the length it reads", actions.filter((a) => a.length > limit), []);
  is("and there are actions to check", actions.includes("cert-months") && actions.length > 10, true);

  part("The field says its unit");
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {} } as never }, createElement(CertificateValidity, { productId: "p1", months: null })));
  const labelled = /<label[^>]*>([\s\S]*?)<\/label>/.exec(html)?.[1] ?? "";
  const named = labelled.replace(/<span aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, "").replace(/<[^>]+>/g, " ");
  is("the label read out names the unit, not only the hidden suffix", named.includes("Valid for, in months (optional)"), true);
  is("the input sits inside that label", /<label[^>]*>[\s\S]*<input[\s\S]*<\/label>/.test(html), true);
  done();
}

void main();
