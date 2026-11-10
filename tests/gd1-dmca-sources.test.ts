import { existsSync, readFileSync } from "node:fs";
import { done, is, part } from "./check";

const file = "docs/gd1-dmca-designated-agent-2026-11-10.md";
const text = existsSync(file) ? readFileSync(file, "utf8") : "";

part("GD1(h): the registration study keeps evidence and owner decisions separate");
is("the dated study exists", existsSync(file), true);
for (const source of [
  "https://www.copyright.gov/title17/92chap5.html#512",
  "https://www.copyright.gov/title37/201/37cfr201-38.html",
  "https://www.copyright.gov/title37/201/37cfr201-3.html",
  "https://www.copyright.gov/dmca-directory/faq.html",
]) is(`primary source: ${source}`, text.includes(source), true);
for (const requirement of ["10/11/2026", "512(c)(2)", "512(i)", "201.3(c)(25)", "US$ 6", "três anos", "Depende do dono", "não certifica", "desconhecido", "nenhum cadastro", "FX275"]) {
  is(`the study records ${requirement}`, text.includes(requirement), true);
}
is("no real person's contact details are filled in", /\b(?:CPF|EIN|telefone|endereço)\s*[:=]\s*\d/i.test(text), false);
done();
