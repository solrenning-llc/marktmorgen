/**
 * The address a link or redirect is built from (lib/request-origin.ts) takes
 * x-forwarded-proto and x-forwarded-host only when each is one plain value:
 * a protocol of http or https, and one host name with an optional port.
 * Anything else (a protocol carrying a URL, a list of hosts, a host with a
 * path, a user part or spaces) is never pasted into a link: the request's own
 * URL is used instead. Synthetic requests only.
 */
import { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { done, is, part } from "./check";

const at = (headers: Record<string, string>, url = "https://marktmorgen.com/api/library") => new NextRequest(url, { headers });

part("Healthy forwarded headers, as before");
is("a custom domain with its protocol", originFrom(at({ "x-forwarded-host": "shop.example", "x-forwarded-proto": "https" })), "https://shop.example");
is("this site, no protocol header: https", originFrom(at({ host: "marktmorgen.com" })), "https://marktmorgen.com");
is("localhost with a port, no protocol header: http", originFrom(at({ host: "localhost:3000" }, "http://localhost:3000/x")), "http://localhost:3000");
is("an explicit http protocol is kept", originFrom(at({ host: "localhost:3000", "x-forwarded-proto": "http" }, "http://localhost:3000/x")), "http://localhost:3000");
is("no host header: the request's own URL", originFrom(at({}, "https://marktmorgen.com/x")), "https://marktmorgen.com");

part("A protocol header that is not exactly http or https is never pasted");
is("a protocol carrying another site's address", originFrom(at({ host: "marktmorgen.com", "x-forwarded-proto": "https://evil.example/x?" })), "https://marktmorgen.com");
is("the emailed link for this site, under that protocol", linkOrigin(at({ host: "marktmorgen.com", "x-forwarded-proto": "https://evil.example/x?" })), "https://marktmorgen.com");
is("a list of protocols takes the first plain one", originFrom(at({ host: "marktmorgen.com", "x-forwarded-proto": "https, http" })), "https://marktmorgen.com");
is("javascript is not a protocol for a link", originFrom(at({ host: "marktmorgen.com", "x-forwarded-proto": "javascript" })), "https://marktmorgen.com");

part("A host header that is not one plain host is never pasted");
is("a list of hosts takes the first", originFrom(at({ "x-forwarded-host": "marktmorgen.com, evil.example", "x-forwarded-proto": "https" })), "https://marktmorgen.com");
is("the emailed link under that list", linkOrigin(at({ "x-forwarded-host": "marktmorgen.com, evil.example", "x-forwarded-proto": "https" })), "https://marktmorgen.com");
is("a host with a path", originFrom(at({ "x-forwarded-host": "marktmorgen.com/evil", "x-forwarded-proto": "https" })), "https://marktmorgen.com");
is("a host with a user part", originFrom(at({ "x-forwarded-host": "marktmorgen.com@evil.example", "x-forwarded-proto": "https" })), "https://marktmorgen.com");
is("a host with a space", originFrom(at({ "x-forwarded-host": "marktmorgen.com evil.example", "x-forwarded-proto": "https" })), "https://marktmorgen.com");

part("A host the URL parser refuses is never pasted (Codex M, review 5821099238)");
is("a malformed IPv6 address", originFrom(at({ "x-forwarded-host": "[:::]", "x-forwarded-proto": "https" })), "https://marktmorgen.com");
is("a bracketed number that is not an IPv6 address", originFrom(at({ "x-forwarded-host": "[1]", "x-forwarded-proto": "https" })), "https://marktmorgen.com");
is("a port above 65535", originFrom(at({ "x-forwarded-host": "marktmorgen.com:65536", "x-forwarded-proto": "https" })), "https://marktmorgen.com");
is("the emailed link under a port above 65535 on a platform host", linkOrigin(at({ "x-forwarded-host": "demo.vercel.app:99999", "x-forwarded-proto": "https" })), "https://marktmorgen.com");
is("a healthy IPv6 address with a port is kept", originFrom(at({ host: "[::1]:3000", "x-forwarded-proto": "http" }, "http://[::1]:3000/x")), "http://[::1]:3000");
is("port 65535 is kept", originFrom(at({ "x-forwarded-host": "shop.example:65535", "x-forwarded-proto": "https" })), "https://shop.example:65535");

done();
