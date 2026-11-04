/**
 * 631 [AA1] (f), unit 16: the pure rules OAuth for the MCP server will run on
 * (lib/mcp-oauth-rules.ts): PKCE S256 only, exact redirect URIs on https or
 * loopback, this server as the only resource, and the three agent scopes.
 */
import { createHash } from "node:crypto";
import { acceptChallenge, canonicalResource, redirectAllowed, redirectMatch, resourceIsOurs, s256, scopeOf, verifierMatches } from "@/lib/mcp-oauth-rules";
import { done, is, part } from "./check";

const SITE = "https://marktmorgen.com";

part("PKCE: S256 only");
// RFC 7636, Appendix B: the example verifier and its S256 challenge.
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
is("the RFC's own example", s256(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
is("the same as Node's sha256 in base64url", s256(verifier), createHash("sha256").update(verifier).digest("base64url"));
is("an S256 challenge is accepted", acceptChallenge("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "S256"), true);
is("plain is refused", acceptChallenge(verifier, "plain"), false);
is("no method is refused", acceptChallenge("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", undefined), false);
is("a malformed challenge is refused", acceptChallenge("short", "S256"), false);
is("the right verifier matches", verifierMatches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"), true);
is("a wrong verifier does not", verifierMatches(`${verifier.slice(0, -1)}Y`, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"), false);
is("a verifier too short does not", verifierMatches("abc", s256("abc")), false);
is("a verifier with a character outside the set does not", verifierMatches(`${verifier}!`, s256(`${verifier}!`)), false);
is("not a string does not", verifierMatches(42, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"), false);

part("Redirect URIs: exact, https or loopback");
is("https", redirectAllowed("https://claude.ai/api/mcp/auth_callback"), true);
is("localhost over http", redirectAllowed("http://localhost:6274/oauth/callback"), true);
is("127.0.0.1 over http", redirectAllowed("http://127.0.0.1:33418/callback"), true);
is("http elsewhere refused", redirectAllowed("http://example.com/callback"), false);
is("a fragment refused", redirectAllowed("https://example.com/cb#x"), false);
is("a user in it refused", redirectAllowed("https://user@example.com/cb"), false);
is("a custom scheme refused", redirectAllowed("cursor://callback"), false);
is("javascript refused", redirectAllowed("javascript:alert(1)"), false);
is("spaces refused", redirectAllowed("https://example.com/c b"), false);
const registered = ["https://claude.ai/api/mcp/auth_callback"];
is("exactly registered: matched", redirectMatch("https://claude.ai/api/mcp/auth_callback", registered), "https://claude.ai/api/mcp/auth_callback");
is("a trailing slash more: not matched", redirectMatch("https://claude.ai/api/mcp/auth_callback/", registered), null);
is("a query more: not matched", redirectMatch("https://claude.ai/api/mcp/auth_callback?x=1", registered), null);
is("another host: not matched", redirectMatch("https://claude.ai.evil.example/api/mcp/auth_callback", registered), null);
is("case changed in the path: not matched", redirectMatch("https://claude.ai/API/mcp/auth_callback", registered), null);

part("The resource is this server");
is("canonical", canonicalResource(SITE), "https://marktmorgen.com/api/mcp");
is("exactly ours", resourceIsOurs("https://marktmorgen.com/api/mcp", SITE), true);
is("host case does not matter", resourceIsOurs("https://MarktMorgen.com/api/mcp", SITE), true);
is("one trailing slash is the same", resourceIsOurs("https://marktmorgen.com/api/mcp/", SITE), true);
is("another path is not", resourceIsOurs("https://marktmorgen.com/api/v1", SITE), false);
is("another host is not", resourceIsOurs("https://marktmorgen.com.evil.example/api/mcp", SITE), false);
is("a query is not", resourceIsOurs("https://marktmorgen.com/api/mcp?x=1", SITE), false);
is("http is not", resourceIsOurs("http://marktmorgen.com/api/mcp", SITE), false);
is("nothing is not", resourceIsOurs(undefined, SITE), false);

part("Scopes: the three agent scopes, nothing else");
is("none asked: read", scopeOf(undefined), { ok: true, agent: "none", granted: ["read"] });
is("read", scopeOf("read"), { ok: true, agent: "none", granted: ["read"] });
is("draft also reads", scopeOf("read draft"), { ok: true, agent: "draft", granted: ["read", "draft"] });
is("execute also drafts and reads", scopeOf("execute"), { ok: true, agent: "execute", granted: ["read", "draft", "execute"] });
is("an unknown scope refuses it all", scopeOf("read payments"), { ok: false });
is("money is no scope", scopeOf("refund"), { ok: false });
is("not a string", scopeOf(["read"]), { ok: false });
is("too long", scopeOf("read ".repeat(20)), { ok: false });

done();
