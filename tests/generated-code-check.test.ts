/**
 * 631 [AA1] (d), unit 4: code an AI generates for a store is refused before
 * publishing when it loads or sends anything outside the store, escapes its
 * frame, touches storage, writes or hides code, asks for a password, a card
 * or an identity number, imitates a sign-in, a checkout or Marktmorgen, or has
 * an accessibility fault the code alone shows (lib/generated-code-check.ts).
 * Synthetic code only; nothing is fetched or run.
 */
import { GENERATED_CODE_MAX_BYTES, NOT_CHECKED_HERE, type CodeRule, checkGeneratedCode, decodeEntities, outsideUrl } from "@/lib/generated-code-check";
import { SENSITIVE_WHY } from "@/lib/form-sensitive";
import { done, is, part } from "./check";

const rules = (html: string, css = "", js = "", allowedHosts: string[] = []) =>
  [...new Set(checkGeneratedCode({ html, css, js }, { allowedHosts }).findings.map((f) => f.rule))].sort();
const only = (rule: CodeRule) => [rule];

part("A clean calculator passes the static check, and says what it could not check");
const calculator = {
  html: `<section aria-labelledby="calc-title">
  <h2 id="calc-title">How many hours you save</h2>
  <label for="hours">Hours of editing a week</label>
  <input id="hours" type="number" min="0" inputmode="numeric">
  <label>Hourly rate <input id="rate" type="number" min="0"></label>
  <button type="button" id="go">Work it out</button>
  <p id="result" aria-live="polite"></p>
  <img src="/files/chart.png" alt="Hours saved each month">
  <a href="https://example.org/guide">Read the guide</a>
</section>`,
  css: `.calc { text-align: left; line-height: 1.5 }
button:focus-visible { outline: 3px solid #000 }
@media (prefers-reduced-motion: no-preference) { .calc { transition: opacity .2s } }`,
  js: `document.getElementById("go").addEventListener("click", async () => {
  const hours = Number(document.getElementById("hours").value);
  const rate = Number(document.getElementById("rate").value);
  const prices = await fetch("/api/v1/products").then((r) => r.json());
  document.getElementById("result").textContent = "You save " + hours * rate * 4 + " a month (" + prices.data.length + " products).";
});`,
};
const clean = checkGeneratedCode(calculator);
is("no findings", clean.findings, []);
is("static pass", clean.staticPass, true);
is("what only a rendered check sees is listed", clean.notChecked, NOT_CHECKED_HERE);
is("contrast and target size are among them", clean.notChecked.some((n) => n.includes("7:1")) && clean.notChecked.some((n) => n.includes("44 by 44")), true);

part("Nothing loaded or sent from outside the store");
is("a script from a URL", rules(`<script src="https://cdn.example.com/x.js"></script>`), only("outside_script"));
is("a script from the same site still is not the code shown", rules(`<script src="/x.js"></script>`), only("outside_script"));
is("an SVG script from an address", rules(`<svg><script xlink:href="https://x.example/a.js"></script></svg>`), only("outside_script"));
is("an SVG link to javascript:", rules(`<svg><a xlink:href="javascript:go()"><text>Go</text></a></svg>`), only("writes_code"));
is("a script made in JavaScript", rules("", "", `const s = document.createElement("script"); s.src = "/x.js";`), ["outside_script"]);
is("import()", rules("", "", `import("https://cdn.example.com/m.js")`), ["outside_load", "outside_script"]);
is("a frame", rules(`<iframe src="/files/a.html" title="a"></iframe>`), only("outside_load"));
is("a stylesheet link", rules(`<link rel="stylesheet" href="/a.css">`), only("outside_load"));
is("a picture from another site", rules(`<img src="https://tracker.example.com/p.gif" alt="">`), only("outside_load"));
is("…unless that host is allowed", rules(`<img src="https://files.store.example/p.png" alt="">`, "", "", ["files.store.example"]), []);
is("a protocol-relative picture", rules(`<img src="//tracker.example.com/p.gif" alt="">`), only("outside_load"));
is("a srcset entry from another site", rules(`<img src="/a.png" srcset="/a2.png 2x, https://x.example/a3.png 3x" alt="">`), only("outside_load"));
is("a CSS @import", rules("", `@import url("/other.css");`), only("outside_load"));
is("a CSS background from another site", rules("", `.a { background: url(https://x.example/a.png) }`), only("outside_load"));
is("a style attribute with an outside URL", rules(`<div style="background:url('//x.example/a.png')">a</div>`), only("outside_load"));
is("a form that posts elsewhere", rules(`<form action="https://collect.example/x"><label>Name <input name="n"></label></form>`), only("outside_send"));
is("fetch to another site", rules("", "", `fetch("https://api.example.com/x")`), ["outside_load", "outside_send"]);
is("fetch to an address built from a variable", rules("", "", `fetch(base + "/x")`), only("outside_send"));
is("fetch to a template that starts with a variable", rules("", "", "fetch(`${base}/x`)"), only("outside_send"));
is("fetch to '/' joined with '/other.site'", rules("", "", `fetch("/" + "/other.example/x")`), only("outside_send"));
is("fetch to an allowed host joined with more host", rules("", "", `fetch("https://store.example" + ".evil.example/x")`, ["store.example"]), only("outside_send"));
is("fetch to an allowed host with its path", rules("", "", `fetch("https://store.example/api/v1/products")`, ["store.example"]), []);
is("XMLHttpRequest elsewhere", rules("", "", `const r = new XMLHttpRequest(); r.open("GET", "https://x.example/a");`), ["outside_load", "outside_send"]);
is("a WebSocket", rules("", "", `new WebSocket("/live")`), only("outside_send"));
is("sendBeacon", rules("", "", `navigator.sendBeacon("/a", "x")`), only("outside_send"));
is("window.open", rules("", "", `window.open("/a")`), only("outside_send"));

part("It stays in its box and away from storage");
is("window.top", rules("", "", `window.top.location = "/"`), only("frame_escape"));
is("parent.postMessage", rules("", "", `parent.postMessage("x", "*")`), only("frame_escape"));
is("opener", rules("", "", `opener.document`), only("frame_escape"));
is("a property named top is not the window", rules("", "", `const box = el.getBoundingClientRect(); const y = box.top.toFixed(0);`), []);
is("a meta refresh", rules(`<meta http-equiv="refresh" content="0;url=https://x.example">`), only("frame_escape"));
is("a base element", rules(`<base href="https://x.example/">`), only("frame_escape"));
is("cookies", rules("", "", `const c = document.cookie;`), only("storage"));
is("localStorage", rules("", "", `localStorage.setItem("a", "1")`), only("storage"));
is("saved passwords", rules("", "", `navigator.credentials.get({ password: true })`), only("storage"));

part("No code written from text, nothing hidden");
is("eval", rules("", "", `eval("1+1")`), only("writes_code"));
is("new Function", rules("", "", `new Function("return 1")`), only("writes_code"));
is("a timer from a string", rules("", "", `setTimeout("go()", 10)`), only("writes_code"));
is("innerHTML", rules("", "", `el.innerHTML = name;`), only("writes_code"));
is("document.write", rules("", "", `document.write("<b>x</b>")`), only("writes_code"));
is("an inline handler", rules(`<button onclick="go()">Go</button>`), only("writes_code"));
is("a javascript: link", rules(`<a href="javascript:go()">Go</a>`), only("writes_code"));
is("a javascript: link hidden with tabs and entities", rules(`<a href="jav&#x09;ascript&colon;go()">Go</a>`), only("writes_code"));
is("a frame written from text is a frame, refused", rules(`<iframe srcdoc="<p>x</p>" title="x"></iframe>`), only("outside_load"));
is("atob", rules("", "", `const s = atob("ZXZhbA==");`), only("hidden_code"));
is("character codes", rules("", "", `String.fromCharCode(101, 118)`), only("hidden_code"));
is("escaped text", rules("", "", `const s = "\\x65\\x76";`), only("hidden_code"));
is("entities decode as browsers do", decodeEntities("&#106;&#x61;&amp;&colon;"), "ja&:");
is("outsideUrl: a relative path is the store", outsideUrl("files/a.png", []), false);
is("outsideUrl: a backslash host is not", outsideUrl("\\\\x.example/a", []), true);
is("outsideUrl: an unknown scheme is not", outsideUrl("ftp://x.example/a", []), true);

part("Never a password, a card or an identity number (568 [GD2] (c), the same rules)");
is("a password field", rules(`<label for="p">Choose a word</label><input id="p" type="password">`), only("sensitive_field"));
is("a password field made in JavaScript", rules("", "", `input.type = "password";`), only("sensitive_field"));
is("a card number by its label", rules(`<label>Card number <input name="n"></label>`), only("sensitive_field"));
is("a security code by its placeholder", rules(`<label>Code <input placeholder="CVV"></label>`), only("sensitive_field"));
is("a card field by its autocomplete", rules(`<label>Number <input autocomplete="cc-number"></label>`), only("sensitive_field"));
is("an identity number by its name", rules(`<label>Number <input name="social_security_number"></label>`), only("sensitive_field"));
const card = checkGeneratedCode({ html: `<label>Card number <input name="n"></label>`, css: "", js: "" }).findings[0];
is("the reason is the forms' own, said of generated code", card.why, SENSITIVE_WHY.card.replace(/^A form never/, "Generated code never"));
is("a gift card question is an ordinary question", rules(`<label>Which gift card would you like? <input name="g"></label>`), []);

part("No imitation of signing in, a checkout or Marktmorgen");
is("the Marktmorgen name", rules(`<h2>Pay with Marktmorgen</h2>`), only("imitation"));
is("a secure checkout", rules(`<h2>Secure checkout</h2>`), only("imitation"));
is("confirm your card", rules("", "", `msg.textContent = "Confirm your card to continue";`), only("imitation"));
is("sign in to your account", rules(`<p>Sign in to your account</p>`), only("imitation"));

part("Accessibility faults the code alone shows (AX274, WCAG 2.2 AAA)");
is("a picture without alt", rules(`<img src="/a.png">`), only("image_text"));
is("a decorative picture with alt=\"\" is fine", rules(`<img src="/a.png" alt="">`), []);
is("a field without a name", rules(`<input id="x" type="text">`), only("field_name"));
is("a field named by aria-label", rules(`<input type="text" aria-label="Your city">`), []);
is("a button without words", rules(`<button type="button"></button>`), only("button_name"));
is("a button with only an icon described", rules(`<button type="button"><img src="/i.png" alt="Close"></button>`), []);
is("tabindex above 0", rules(`<button type="button" tabindex="2">Go</button>`), only("focus_order"));
is("outline hidden with no focus style", rules("", `button { outline: none }`), only("focus_hidden"));
is("outline hidden with a focus style", rules("", `button { outline: none } button:focus-visible { outline: 3px solid #000 }`), []);
is("justified text", rules("", `p { text-align: justify }`), only("justified"));
is("zoom blocked", rules(`<meta name="viewport" content="width=device-width, user-scalable=no">`), only("zoom_blocked"));
is("maximum-scale=1", rules(`<meta name="viewport" content="width=device-width, maximum-scale=1">`), only("zoom_blocked"));
is("animation without reduced motion", rules("", `.a { animation: spin 1s infinite } @keyframes spin { to { transform: rotate(1turn) } }`), only("motion"));
is("animation inside a reduced-motion query", rules("", `@media (prefers-reduced-motion: no-preference) { .a { animation: spin 1s } }`), []);
is("marquee", rules(`<marquee>Sale</marquee>`), only("motion"));
is("JavaScript animation without asking", rules("", "", `requestAnimationFrame(step)`), only("motion"));
is("JavaScript animation that asks", rules("", "", `if (!matchMedia("(prefers-reduced-motion: reduce)").matches) requestAnimationFrame(step)`), []);
is("autoplaying video", rules(`<video src="/v.mp4" autoplay controls></video>`), only("autoplay"));

part("Bounded");
const big = checkGeneratedCode({ html: "x".repeat(GENERATED_CODE_MAX_BYTES + 1), css: "", js: "" });
is("past the size it is refused before reading", [big.staticPass, big.findings.map((f) => f.rule)], [false, ["too_big"]]);
is("every finding says why in words", checkGeneratedCode({ html: `<img src="//x.example/a">`, css: "p{text-align:justify}", js: "eval(1)" }).findings.every((f) => f.why.length > 30 && f.at.length > 0), true);

done();
