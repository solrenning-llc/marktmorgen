/** GD2(c): static generated-code checks use the destination the URL parser sees. No network IO. */
import { checkGeneratedCode, outsideUrl } from "@/lib/generated-code-check";
import { done, is, part } from "./check";

const allowed = ["files.store.example"];
const refused = [
  "//files.store.example@collector.example/pixel.png",
  "//user:pass@collector.example/pixel.png",
  "///collector.example/pixel.png",
  "////collector.example/pixel.png",
  "//collector.example:bad/pixel.png",
  "//[not-an-ip]/pixel.png",
  "//files.store.example:99999/pixel.png",
  "//files.store.example .collector.example/pixel.png",
  "//files.store.example\u0000/pixel.png",
  "//%63ollector.example/pixel.png",
  "/\\collector.example/pixel.png",
  "\\\\collector.example/pixel.png",
  "https://collector.example/pixel.png",
  "javascript:alert(1)",
];

part("An unknown or external authority is never a relative file");
for (const url of refused) {
  is(`outside: ${JSON.stringify(url)}`, outsideUrl(url, allowed), true);
  const html = `<img src="${url}" alt="">`;
  const checked = checkGeneratedCode({ html, css: "", js: "" }, { allowedHosts: allowed });
  is(`image refused: ${JSON.stringify(url)}`, checked.staticPass, false);
  is(`image explains refusal: ${JSON.stringify(url)}`, checked.findings.some((f) => f.rule === "outside_load"), true);
}

part("A browser URL parser confirms which successful attacks cross the boundary");
for (const url of refused.slice(0, 4)) {
  is(`actual destination: ${url}`, new URL(url, "https://apps.store.example/").hostname, "collector.example");
}

part("The same guard covers form actions, CSS and fetch");
const address = "//files.store.example@collector.example/collect";
for (const code of [
  { html: `<form action="${address}"><button>Send</button></form>`, css: "", js: "" },
  { html: "", css: `.photo { background: url("${address}"); }`, js: "" },
  { html: "", css: "", js: `fetch("${address}")` },
]) is("external destination refused", checkGeneratedCode(code, { allowedHosts: allowed }).staticPass, false);

part("Existing relative and permitted destinations remain available");
for (const url of ["", "#chart", "/files/chart.png", "files/chart.png", "./chart.png", "../chart.png", "/files/my chart.png", "//files.store.example/p.png", "https://files.store.example/p.png", "https://FILES.STORE.EXAMPLE:443/p.png", "http://files.store.example:8080/p.png", "wss://files.store.example/live", "data:image/png;base64,AAAA"]) {
  is(`permitted: ${url}`, outsideUrl(url, allowed), false);
}
is("the caller must permit the host", outsideUrl("//files.store.example/p.png", []), true);
done();
