/**
 * AX274 Part A, item 5: the signed copy of an agreement is emailed as an HTML
 * file the signer opens in a browser, often on a phone. Without a viewport
 * the phone lays it out about 980px wide and shrinks it, so the text is tiny
 * and reading it means zooming and scrolling sideways (WCAG 1.4.10 Reflow,
 * 1.4.4 Resize Text). Synthetic store, agreement and signature; nothing sent.
 */
import { signedCopyHtml } from "@/lib/agreements";
import { done, is } from "./check";

const store = { handle: "harbor", name: "Harbor Studio", language: "en" } as unknown as Parameters<typeof signedCopyHtml>[0];
const agreement = { id: "a1b2c3d4e5f6", kind: "terms" } as unknown as Parameters<typeof signedCopyHtml>[1];
const version = { n: 2, title: "Coaching terms", text: "1. Sessions are 60 minutes.\n2. Cancel 24 hours ahead." } as unknown as Parameters<typeof signedCopyHtml>[2];
const signature = { name: "Maya Example", at: Date.UTC(2026, 10, 11, 15, 0), ipHash: "", consent: "I agree.", consentVersion: 1, sha256: "f".repeat(64) };

const html = signedCopyHtml(store, agreement, version, signature);
const head = html.slice(0, html.indexOf("</head>"));
is("the signed copy says how wide to lay it out on a phone (1.4.10)", head.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'), true);
is("the viewport never stops the reader zooming (1.4.4)", /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?![.\d])/.test(head), false);
is("the signed copy keeps its charset, title and language", [head.includes('<meta charset="utf-8">'), /<title>[^<]+<\/title>/.test(head), /<html lang="en"/.test(html)], [true, true, true]);
is("the text signed is kept whole and wraps", html.includes("white-space:pre-wrap") && html.includes("1. Sessions are 60 minutes."), true);

done();
