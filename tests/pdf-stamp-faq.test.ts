/**
 * The questions someone starting out asks about PDF stamping (534 [FQ1],
 * unit 14, lib/pdf-stamp-faq.ts; added 2 November 2026). Checked: the box's
 * own words, read from its file, and that it shows only once the product has
 * a PDF; the largest PDF stamped; the upload policy beside it; the trial
 * question answered no while a PDF cannot be uploaded before a plan is paid; what stamping is
 * and is not, as the box and the page's note say; first in the page's own
 * Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { STAMP_WORDS, stampBeginnerQuestions } from "@/lib/pdf-stamp-faq";
import { tryBeforePaying, uploadsWait } from "@/lib/beginner-faq";
import { MAX_STAMP_BYTES, readableSize } from "@/lib/product-file";
import { AUTOMATIC_UPLOAD_CAPS } from "@/lib/upload-budget-policy";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const box = flat(read("components/pdf-stamp-toggle.tsx")).replace(/&apos;/g, "'");
is("the box's own label", box.includes(STAMP_WORDS.box), true);
is("the box shows only once the product has a PDF, or an EPUB (630 [HN6] item 30)", /if \(pdfs\.length === 0 && epubs\.length === 0 && !on\) return null;/.test(box), true);
is("the stamp line holds the email, the order's date, the order and personal use; the paid download stamps it, the free one does not", [read("lib/pdf-stamp-line.ts").includes("return `Sold to ${email} on ${day} · order …${order} · for personal use`;"), read("app/api/store/download/route.ts").includes("import { stampedCopy, wantsStamp }"), /stampedCopy|wantsStamp/.test(read("app/api/store/free/download/route.ts"))], [true, true, false]);
is("the box covers PDFs on price options too", box.includes("const files = [product.file, ...product.options.map((o) => o.file)]"), true);
is("no upload before a paid plan, setup or trial", [AUTOMATIC_UPLOAD_CAPS.setup.opens, AUTOMATIC_UPLOAD_CAPS.trial.opens], [0, 0]);
const page = JSON.stringify(findPage("platform", "pdf-stamping"));
is("the page's note: it discourages sharing, it does not stop it", page.includes("It does not stop anyone from sharing the file, and someone determined can remove the line."), true);

part("The answers");
const now = stampBeginnerQuestions(false);
const later = stampBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What is PDF stamping here?", "How do I switch on PDF stamping?", "Can I try PDF stamping before paying?", "Does stamping stop people sharing?"]);
is("switch it on: the box's words, when it shows, the upload wait from the policy, the largest PDF, damaged files and free downloads", [answer(now, "How do I switch on PDF stamping?").includes(`check “${STAMP_WORDS.box}”`), answer(now, "How do I switch on PDF stamping?").includes(`The box shows once the product has a PDF${AUTOMATIC_UPLOAD_CAPS.setup.opens === 0 && AUTOMATIC_UPLOAD_CAPS.trial.opens === 0 ? ", and a PDF can be uploaded once a paid plan starts" : ""}.`), answer(now, "How do I switch on PDF stamping?").includes(`PDFs up to ${readableSize(MAX_STAMP_BYTES)} are stamped`), answer(now, "How do I switch on PDF stamping?").includes("locked with a password or damaged"), answer(now, "How do I switch on PDF stamping?").includes("A free download is handed over as you uploaded it.")], [true, true, true, true, true]);
const apart = " Stamping itself works only on a PDF uploaded to the product.";
const waits = AUTOMATIC_UPLOAD_CAPS.setup.opens === 0 && AUTOMATIC_UPLOAD_CAPS.trial.opens === 0;
const notYet = "Not before a plan is paid: stamping works only on a PDF uploaded to the product, and a PDF can be uploaded once a paid plan starts.";
is("try before paying: no while a PDF cannot be uploaded before a plan is paid, else the shared answer said of a product with stamping said apart", [answer(now, "Can I try PDF stamping before paying?"), answer(later, "Can I try PDF stamping before paying?")], waits ? [`${notYet} Paid plans are not on sale yet.`, notYet] : [tryBeforePaying("A product", "a product", false) + apart, tryBeforePaying("A product", "a product", true, TRIAL_DAYS) + apart]);
is("sharing: said plainly that it does not stop it, in the page's own note", [answer(now, "Does stamping stop people sharing?").startsWith("No."), page.includes(answer(now, "Does stamping stop people sharing?").slice(answer(now, "Does stamping stop people sharing?").indexOf("It does not stop")))], [true, true]);
is("no answer promises stamping before a PDF can be uploaded", [waits ? answer(now, "Can I try PDF stamping before paying?").startsWith("Not before") : answer(now, "Can I try PDF stamping before paying?").includes(uploadsWait("setup")), /stamp(ing)? (can|will) be (set up|switched on|tried)/i.test([...now, ...later].map((x) => x.a).join(" "))], [true, false]);
is("one space between sentences, never two", /\s{2}/.test([...now, ...later].map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of copies or sales, no percent, no result promised", /\b\d+\s+(copies|sales|buyers|creators)|\d+%|guarantee|proven|results?\b/i.test(all), false);

part("On the PDF stamping page");
const faq = (findPage("platform", "pdf-stamping")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
