/**
 * AX274 Part A item 5 (emails), WCAG 3.1.2 Language of Parts (AA): a message sent on to a creator
 * (lib/inbound-mail.ts) carries the sender's own HTML, in whatever language the sender wrote, with our short header
 * line above it ("From ...", "To ...", in English). That line had no `lang`, so a screen reader read our English with
 * the sender's language (or the mail app's) when they differ. Found by the 11 November email audit
 * (docs/accessibility-email-pdf-audit-2026-11-11.md, "Open") and still on main.
 *
 * The line now says it is US English. Rendered from the real builder with synthetic lines; nothing is sent.
 */
import { forwardedHeaderHtml } from "@/lib/inbound-mail";
import { done, is, part } from "./check";

const html = forwardedHeaderHtml(["From: Ana <ana@example.com>", "To: hello@shop.example"]);

part("3.1.2: our English header line says its language");
is("it is one block element", /^<div\b[^>]*>[\s\S]*<\/div>$/.test(html), true);
is("marked lang=\"en-US\"", /^<div\b[^>]*\blang="en-US"/.test(html), true);
is("each line kept, escaped, one per line", html.includes("From: Ana &lt;ana@example.com&gt;<br>To: hello@shop.example"), true);
is("its look is unchanged (13px, #555 on the mail's own background: 7.46:1 on white)", /font:13px\/1\.5 system-ui,sans-serif;color:#555/.test(html), true);

done();
