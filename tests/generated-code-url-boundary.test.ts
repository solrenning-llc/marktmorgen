/** GD2(c): static generated-code checks use the destination the URL parser sees. No network IO. */
import { checkGeneratedCode, outsideUrl, tagsOf } from "@/lib/generated-code-check";
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

// WHATWG URL basic parser removes leading/trailing C0 controls and space before parsing a URL.
part("Leading URL controls cannot turn an external authority into a relative path");
for (let value = 0; value <= 0x20; value += 1) {
  const control = String.fromCharCode(value);
  const external = `${control}//collector.example/p.png${control}`;
  is(`URL parser sees an external host after C0 ${value}`, new URL(external, "https://apps.store.example/").hostname, "collector.example");
  is(`outside guard sees the same host after C0 ${value}`, outsideUrl(external, allowed), true);
  is(`permitted host survives C0 ${value}`, outsideUrl(`${control}//files.store.example/p.png${control}`, allowed), false);
  is(`relative path survives C0 ${value}`, outsideUrl(`${control}/files/p.png${control}`, allowed), false);
}
is("a leading C0 cannot hide a JavaScript scheme", outsideUrl("\u0001javascript:alert(1)", allowed), true);
is("a leading C0 cannot hide an HTTP scheme", outsideUrl("\u0001https://collector.example/p.png", allowed), true);
is("a literal C0 in a script URL cannot hide its external load", checkGeneratedCode({ html: "", css: "", js: 'fetch("\u0001//collector.example/p.png")' }, { allowedHosts: allowed }).staticPass, false);

// WHATWG HTML, attribute-name state: a later duplicate is discarded, including case variants.
// https://html.spec.whatwg.org/multipage/parsing.html#attribute-name-state (read 2026-11-10).
part("A second attribute never disguises the first destination the browser uses");
for (const html of [
  '<img src="https://collector.example/p.png" src="/safe.png" alt="">',
  '<img SRC="https://collector.example/p.png" src="/safe.png" alt="">',
  '<img src="https://collector.example/p.png" src="/safe.png" SRC="/safe2.png" alt="">',
  '<img srcset="https://collector.example/p.png 2x" srcset="/safe.png 2x" alt="">',
  '<form action="https://collector.example/collect" action="/safe"><button>Send</button></form>',
  '<button formaction="https://collector.example/collect" formaction="/safe">Send</button>',
  '<div style="background:url(https://collector.example/p.png)" style="color:black">Chart</div>',
]) is(`first external attribute refused: ${html}`, checkGeneratedCode({ html, css: "", js: "" }).staticPass, false);

for (const html of [
  '<img src="/safe.png" src="https://collector.example/p.png" alt="">',
  '<img SRC="/safe.png" src="https://collector.example/p.png" alt="">',
  '<form action="/safe" action="https://collector.example/collect"><button>Send</button></form>',
]) is(`discarded attribute is not the destination: ${html}`, checkGeneratedCode({ html, css: "", js: "" }).staticPass, true);
is("first empty value also wins", tagsOf('<img src="" src="/later.png">')[0].attrs.get("src"), "");
is("three case variants keep the first", tagsOf('<img SRC="/first.png" Src="/second.png" src="/third.png">')[0].attrs.get("src"), "/first.png");
is("a first password type cannot be disguised", checkGeneratedCode({ html: '<input type="password" type="text" aria-label="Name">', css: "", js: "" }).findings.some((f) => f.rule === "sensitive_field"), true);
done();
