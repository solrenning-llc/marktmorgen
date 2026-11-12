import { existsSync, readFileSync } from "node:fs";
import { done, is, part } from "./check";

const file = "docs/gd1-ftc-claims-sources-2026-11-10.md";
const text = existsSync(file) ? readFileSync(file, "utf8") : "";
part("GD1(d): evidence about reviews is not a certificate for advertising claims");
is("a dated source review exists", existsSync(file), true);
for (const source of [
  "https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-465",
  "https://www.ecfr.gov/current/title-16/chapter-I/subchapter-B/part-255/section-255.2",
  "https://www.ftc.gov/business-guidance/resources/consumer-reviews-testimonials-rule-questions-answers",
  "https://www.ftc.gov/business-guidance/resources/advertising-faqs-guide-small-business",
]) is(`primary source: ${source}`, text.includes(source), true);
for (const point of ["10/11/2026", "21/10/2024", "465.2(d)", "465.4", "465.5", "465.7(b)", "255.2(b)", "alegações implícitas", "não certifica", "Depende do dono", "custo desconhecido", "sem contato externo"]) {
  is(`the source review keeps ${point}`, text.includes(point), true);
}
is("no claim that a keyword detector guarantees compliance", /detector[^.\n]{0,60}garante conformidade/i.test(text), false);
done();
