/**
 * 631 [AA1] (d), unit 7: AI-generated apps run on another site, sandboxed as
 * an origin of their own, with no cookies, storage, frames, forms, eval or
 * network beyond what is given, framed only by the store's own pages, in a
 * frame that has a name (lib/generated-app-policy.ts). Pure rules.
 */
import { createHash } from "node:crypto";
import { appFrameAttributes, appHeaders, appPolicy, isOrigin, scriptHash, separateSite } from "@/lib/generated-app-policy";
import { done, is, part } from "./check";

const directives = (policy: string) => new Map(policy.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)] as const));

part("Origins: https, a host, nothing else");
is("a plain origin", isOrigin("https://shop.creator-example.com"), true);
is("with a port", isOrigin("https://files.example.com:8443"), true);
is("http is refused", isOrigin("http://shop.example.com"), false);
is("a path is refused", isOrigin("https://shop.example.com/x"), false);
is("a wildcard is refused", isOrigin("https://*.example.com"), false);
is("a source keyword is refused", isOrigin("'unsafe-inline'"), false);

part("The apps domain is another site");
is("a subdomain of this site is the same site, refused", separateSite("https://apps.marktmorgen.com", "https://marktmorgen.com"), false);
is("another domain is another site", separateSite("https://marktmorgen-apps.com", "https://marktmorgen.com"), true);
is("not an origin: refused", separateSite("apps", "https://marktmorgen.com"), false);

part("The policy of an app document");
const made = appPolicy({ framedBy: ["https://marktmorgen.com", "https://shop.creator-example.com"], filesFrom: ["https://files.example.com"], inlineScripts: ["document.title = 'x';"] });
if (!made.ok) throw new Error("expected a policy");
const d = directives(made.policy);
is("nothing by default", d.get("default-src"), ["'none'"]);
is("sandboxed with scripts only: no same origin, so no cookies or storage, no forms, no popups, no top navigation", d.get("sandbox"), ["allow-scripts"]);
is("scripts: its own and the approved inline one by hash", d.get("script-src"), ["'self'", scriptHash("document.title = 'x';")]);
is("never eval, never any inline script", made.policy.includes("unsafe-eval") || (d.get("script-src") ?? []).includes("'unsafe-inline'"), false);
is("no network unless given", d.get("connect-src"), ["'none'"]);
is("pictures from itself, data and the store's files", d.get("img-src"), ["'self'", "data:", "https://files.example.com"]);
is("no frames, workers, plug-ins, manifest", [d.get("frame-src"), d.get("child-src"), d.get("worker-src"), d.get("object-src"), d.get("manifest-src")], [["'none'"], ["'none'"], ["'none'"], ["'none'"], ["'none'"]]);
is("no <base>, no form posting", [d.get("base-uri"), d.get("form-action")], [["'none'"], ["'none'"]]);
is("framed only by the store's own pages", d.get("frame-ancestors"), ["https://marktmorgen.com", "https://shop.creator-example.com"]);
const talking = appPolicy({ framedBy: ["https://marktmorgen.com"], connectTo: ["https://api.example.com"] });
is("network only to what is given", talking.ok && directives(talking.policy).get("connect-src"), ["https://api.example.com"]);
is("no store page to show it: refused", appPolicy({ framedBy: [] }), { ok: false, error: "no_frame" });
is("an http origin anywhere: refused", appPolicy({ framedBy: ["https://marktmorgen.com"], connectTo: ["http://api.example.com"] }), { ok: false, error: "bad_origin" });
is("a source keyword smuggled in as an origin: refused", appPolicy({ framedBy: ["https://marktmorgen.com"], filesFrom: ["'unsafe-inline'"] }), { ok: false, error: "bad_origin" });
is("a wildcard to frame it: refused", appPolicy({ framedBy: ["*"] }), { ok: false, error: "bad_origin" });

part("Script hashes are the browser's");
const text = "console.log(1)";
is("sha256 of the exact text, base64", scriptHash(text), `'sha256-${createHash("sha256").update(text).digest("base64")}'`);
is("one character changes it", scriptHash(text) === scriptHash(`${text} `), false);

part("Headers");
const headers = appHeaders(made.policy);
is("the policy", headers["Content-Security-Policy"], made.policy);
is("no referrer", headers["Referrer-Policy"], "no-referrer");
is("nosniff", headers["X-Content-Type-Options"], "nosniff");
is("its own window group", headers["Cross-Origin-Opener-Policy"], "same-origin");
is("every powerful feature off", ["camera=()", "microphone=()", "geolocation=()", "payment=()", "clipboard-read=()", "publickey-credentials-get=()", "usb=()"].every((f) => headers["Permissions-Policy"].includes(f)), true);

part("The frame on a store page");
const frame = appFrameAttributes({ src: "https://marktmorgen-apps.com/a/abc123/", appsOrigin: "https://marktmorgen-apps.com", title: "  Hours saved calculator " });
is("sandboxed with scripts only, no feature, no referrer, lazy", frame && [frame.sandbox, frame.allow, frame.referrerpolicy, frame.loading], ["allow-scripts", "", "no-referrer", "lazy"]);
is("named for screen readers", frame?.title, "Hours saved calculator");
is("never allow-same-origin", JSON.stringify(frame).includes("allow-same-origin"), false);
is("without a title: no frame", appFrameAttributes({ src: "https://marktmorgen-apps.com/a/", appsOrigin: "https://marktmorgen-apps.com", title: " " }), null);
is("from another origin than the apps domain: no frame", appFrameAttributes({ src: "https://marktmorgen.com/studio", appsOrigin: "https://marktmorgen-apps.com", title: "x" }), null);
is("with a user in the address: no frame", appFrameAttributes({ src: "https://u:p@marktmorgen-apps.com/a/", appsOrigin: "https://marktmorgen-apps.com", title: "x" }), null);
is("not an address: no frame", appFrameAttributes({ src: "javascript:alert(1)", appsOrigin: "https://marktmorgen-apps.com", title: "x" }), null);

done();
