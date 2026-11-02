# OAuth for the Marktmorgen MCP server: the plan (631 [AA1] (f), unit 15)

Why: connector directories list a server only with OAuth. Anthropic's Connectors Directory asks for "OAuth 2.0 for authenticated services" (claude.com/docs/connectors/building/submission, read in full on 2 November 2026, no date shown); OpenAI's seems to ask the same (search summaries only, not confirmed). Today the server takes the creator's static API key (`Authorization: Bearer nl_live_…`), which stays for the REST API, the command line and Cursor.

Source of every requirement below: the MCP specification, version **2026-07-28**, `docs/specification/2026-07-28/basic/authorization/` in github.com/modelcontextprotocol/modelcontextprotocol, read at commit `d0e246e` (31 October 2026). The site modelcontextprotocol.io could not be opened from this session (network policy); the repository is the same text. The RFCs it names (OAuth 2.1 draft 13, RFC 9728, 8414, 8707, 9207, 7591, Client ID Metadata Documents draft) are cited as the specification cites them; their own pages were not read here.

## What the specification asks of us

As the MCP server (resource server):

- Implement OAuth 2.0 Protected Resource Metadata (RFC 9728), listing our authorization server, and make it discoverable either by `resource_metadata` in `WWW-Authenticate` on a 401, or at `/.well-known/oauth-protected-resource/api/mcp` (or the root well-known path). (authorization-server-discovery.mdx, lines 13–45)
- **SHOULD** put a `scope` in `WWW-Authenticate` (index.mdx, line 99).
- Validate access tokens as OAuth 2.1 §5.2 says, and that each was issued for us as its audience (RFC 8707); invalid or expired tokens get 401; accept no other token and pass none on (index.mdx, lines 283–295).

As the authorization server (we are our own; nothing outside is contracted):

- OAuth 2.1 (index.mdx, line 62), with PKCE: clients must use `S256`, and our metadata must list `code_challenge_methods_supported`, or clients refuse to go on (security-considerations.mdx, lines 50–61).
- Authorization server metadata (RFC 8414) or OpenID discovery (index.mdx, line 76).
- Exact redirect URI match against what was registered; redirect URIs only `localhost` or https; every endpoint over https; show the redirect URI's host on the consent screen (security-considerations.mdx, lines 42–43, 71–101).
- **SHOULD** support Client ID Metadata Documents, fetching the client's metadata from its `client_id` URL and validating redirect URIs against it (client-registration.mdx, lines 22–51).
- **SHOULD** send `iss` in authorization responses, error responses included (RFC 9207); expected to become a MUST (index.mdx, lines 194–209).
- Rotate refresh tokens for public clients (security-considerations.mdx, line 34).

## How it fits Marktmorgen

- **Consent in the studio.** The creator signs in as today, picks which store and what the assistant may do: read, prepare drafts, or prepare drafts and changes that reach people — the same three scopes as agent keys (`lib/api-key-rules.ts`, unit 3). Nothing is ever carried out on a token alone: the agent prepares, the creator confirms (`lib/agent-proposal-rules.ts`, unit 2). Money is never in any scope.
- **The resource** is `https://marktmorgen.com/api/mcp`, canonical, lowercase host, no trailing slash; a token for anything else is refused.
- **Tokens** are kept like API keys: only their SHA-256, belonging to the store by its permanent id, short-lived access tokens, refresh tokens rotated at every use, all revocable at once from the studio's key panel, and all revoked with the store. Each request still counts in the store's API requests and waits while the plan is unpaid, through the same door as keys (`lib/api-guard.ts`).
- **Privacy** is unchanged: no tool returns anybody's name, address or words.

## Units

1. This plan. Tested in a PR when its PR runs.
2. **Pure rules** (no storage, no route): PKCE `S256` verification, exact redirect URI match with the https/localhost rule, the canonical resource, scope parsing onto the three agent scopes, token format. Can be built now.
3. **Storage** of clients, codes and tokens: needs new key families in `tests/store-data-registry.ts` and `lib/data-families.ts`, today held by open Codex PRs (#1491, #1502). Waits.
4. **The consent screen** in the studio, WCAG 2.2 AAA, with the redirect host shown.
5. **Endpoints**: authorization, token, metadata (RFC 8414) and protected resource metadata (RFC 9728). Published only together with units 3 and 4, so nothing advertises a door that does not open (rule VR).
6. **The MCP route** accepts a valid token beside the static key, answers 401 with `WWW-Authenticate: Bearer resource_metadata=…, scope=…`.
7. **The listing package** of 631 (f), and only then the owner's submission, with the owner's own accounts.

Nothing here creates an account, accepts terms or contacts anyone. No price, limit, commission, flag or gate changes.
