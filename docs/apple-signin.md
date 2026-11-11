# Continue with Apple — 276 [H3-1]

Dated evidence: 2026-11-05, Fortaleza. **In development, disabled, not available to customers.** `APPLE_SIGNIN_APPROVED=false`; `CURRENT_APPLE_SIGNIN_COST_REVIEW=null` separately blocks all identity/state/provider work. Keys or environment variables alone cannot enable it. No Apple account, program enrollment, app, identifier, key, agreement or payment was created or changed.

## Foundation and account meaning

The foundation requests only `email` and a code; it sends a fresh nonce and single-use browser-bound `asi.` state. Because an email scope uses `form_post`, the callback cookie is HttpOnly, Secure, SameSite=None and limited to its return path. State is provider-separated and expires in 600 seconds. The code is exchanged server-side, once; neither browser-supplied `user` nor `id_token` proves an email. A five-minute ES256 client-secret JWT is signed in memory with an owner-supplied P-256 key, using raw P1363 signature bytes. Identity JWT signatures are checked against a unique matching RSA/RS256 signing key from the fixed Apple key endpoint, followed by issuer, audience, nonce, subject, issued-at, expiry and verified-email checks. Each of at most two provider answers is capped at 16 KiB and five seconds; redirects and automatic retries are disabled.

**This is not a completed login.** The creator session/two-step/new-browser notice, page button and status messages, conditional privacy disclosures, POST callback and exact cross-site-POST exception still require coordination for occupied shared files. The start route and a native form component exist, but no customer sees the button. Buyer library and /manage are a subsequent unit.

The address Apple proves remains its own Marktmorgen account address. A private relay is not the person's underlying inbox, and is never silently linked to an existing account under another address. The form explains that distinction and offers the existing emailed link for the original account. Both `privaterelay.appleid.com` and the announced `private.icloud.com` are recognized. A real address, relay address or missing school-managed email is never invented from the subject/name/browser payload.

## Official sources and unresolved protocol evidence

All links were read or attempted on 2026-11-05; dates below distinguish publication from retrieval.

- [Apple program enrollment](https://developer.apple.com/help/account/membership/program-enrollment): US$99 annual program fee, local currency/region differences. This is a published base price, not a verified all-in cost ceiling including tax, FX or other app requirements.
- [Web configuration](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web) and [environment configuration](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple): Services ID must accompany a primary Apple app enabled for Sign in with Apple; the environment article also states an existing App Store app requirement. Enrollment by itself does not establish website eligibility. Owner/app eligibility remains unverified.
- [Authorization request](https://developer.apple.com/documentation/signinwithapplerestapi/request-an-authorization-to-the-sign-in-with-apple-server.): email scope, `form_post`, nonce/state and a five-minute one-use authorization code.
- [Token validation](https://developer.apple.com/documentation/SigninwithAppleRESTAPI/Generate-and-validate-tokens?changes=_7&language=objc): server-side code exchange, client-secret JWT and registered HTTPS return URL.
- [Token verification](https://developer.apple.com/documentation/signinwithapple/verifying-a-user) and [public signing keys](https://developer.apple.com/documentation/signinwithapplerestapi/fetch-apple%27s-public-key-for-verifying-token-signature): signature and claim checks; matching `kid`, multiple rotating keys. RSA/RS256 is pinned by this implementation, never inferred from a token-controlled URL. The official [id_token Markdown](https://developer.apple.com/documentation/signinwithapplejs/authorizationi/id_token.md) was read directly after the search reader could not process Markdown; it explicitly documents string/boolean forms for `email_verified` and `is_private_email`. The official [REST API index](https://developer.apple.com/documentation/signinwithapplerestapi.md) points its client-secret topic to the shared Account & Organizational Data Sharing article; that cross-reference was read, rather than silently assuming two APIs are equivalent. The Sign-in-specific client-secret URL itself returned 404. The verification article says E256 while this implementation pins RSA/RS256; reconcile this official algorithm ambiguity before activation, never expand acceptance based only on a token header.
- [TN3107](https://developer.apple.com/documentation/technotes/tn3107-resolving-sign-in-with-apple-response-errors), revised 2024-01-16: client-secret fields/signature and raw, non-DER signature requirement.
- [Relay setup](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service): owner must register and authenticate outbound sources; SPF/DKIM requirements affect the email transport owner's lane. Relay delivery has not been configured or tested.
- [New relay domain notice](https://developer.apple.com/news/?id=1ptvdtcm), published 2026-08-24: new Sign-in relay addresses will use `private.icloud.com`; existing `privaterelay.appleid.com` addresses continue. No live rollout date or account behavior is inferred.
- [Identity token guidance](https://developer.apple.com/documentation/signinwithapple/receiving-a-users-identity-token): Apple recommends the stable team-scoped subject as the user identifier. The existing Marktmorgen account system is email-based. A complete stable-identity/migration design is an activation blocker; this foundation neither merges addresses nor persists a provider identity mapping.
- [TN3194](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple), published 2025-10-03: token retention/revocation and account-deletion flows require a dedicated implementation. This foundation discards provider tokens, has no real Apple accounts and claims no completed Apple account lifecycle. Retention, encryption, erasure, notifications and token revocation must be resolved and costed before activation.

## Costs: known base price, unknown total

| Work | Ceiling here | Status |
| --- | --- | --- |
| Apple Developer Program | Published US$99/year, region-specific local pricing | Fixed company cost, 100% Marktmorgen under FX275; tax/FX/full eligibility cost unreviewed; nothing purchased |
| Start guard | Two Redis commands; 20 starts per IP per 600 seconds | Abuse guard only; no paid global budget proven |
| OAuth state | One SET NX and one GETDEL; value <=1024 UTF-8 bytes plus key/Redis overhead; 600-second TTL | Existing provider state family from the Discord parent; no provider token or email stored |
| Token and key fetch | At most two requests, 16 KiB/five seconds each | Per-operation supplier/runtime/transfer prices unknown, never zero |
| JWT signing/verification | P-256 signing; RSA modulus 2048–4096 bits; <=8 public keys | CPU cost and full monthly exposure unreviewed |
| Session/relay/revocation/notifications/CI | Not completed or funded here | Unknown; no zero cost or finite minimum customer base claimed |

Classification in `tests/plan-cost-registry.ts` is not funding. A future activation requires dated official worst-case supplier costs and a global funded automatic ceiling before paid work, MR review, all lifecycle/privacy requirements and owner setup. The current null review has no production activation implementation.

## Owner-only checklist for a later decision

1. Decide whether to fund the Apple Developer Program and whether Marktmorgen has an eligible primary app/website relationship. Review then-current pricing/tax/FX, terms and app eligibility. No agent enrolls, accepts or pays.
2. If separately authorized, the owner configures the primary app, Services ID, domain and exact return URL `https://marktmorgen.com/api/integrations/apple/signin`. Existing apps/keys remain untouched by agents.
3. The owner supplies `APPLE_SIGNIN_CLIENT_ID`, `APPLE_SIGNIN_TEAM_ID`, `APPLE_SIGNIN_KEY_ID`, `APPLE_SIGNIN_PRIVATE_KEY` through deployment secret settings. Never put a real key or account identifier in git, logs or messages.
4. Coordinate relay outbound-source registration/authentication with the email owner. Do not assume mail reaches hidden addresses before this is proven.
5. Complete stable subject identity, consent-revoked/account-deleted/forwarding-change handling, token revocation and erasure, session integration, exact POST exception, conditional privacy and buyer integration; independently review the whole flow with simulated providers and all nine CI checks. Resolve protocol evidence gaps above.
6. Resolve complete funding/MR blockers in a separate reviewed unit. Only a later explicit owner instruction may authorize consideration of activation. This task keeps everything off.

## Tests and limits

`tests/apple-signin.test.ts` generates disposable P-256/RSA keys during the test, simulates only Apple's token/key endpoints, and verifies signatures and adverse claim/state/key cases. It makes no supplier calls and stores no private key in the repository. No real Apple sign-in, email relay delivery, accessibility certification, payment, program acceptance or complete Apple compliance is claimed.
