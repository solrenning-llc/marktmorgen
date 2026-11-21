# Continue with Discord — 276 [H3-1]

Evidence read on 2026-11-05 (Fortaleza). **In development, disabled, not available to customers.** `DISCORD_SIGNIN_APPROVED=false`. `CURRENT_DISCORD_SIGNIN_COST_REVIEW=null` independently prevents all start/finish provider and state work; supplying environment variables cannot turn it on. No supplier account, application, secret, agreement, real authorization or setting was created or changed.

## Implemented foundation

Authorization code flow, only `identify email`, S256 PKCE with a fresh random verifier per attempt. A separate `dsi.` state and HttpOnly cookie bind the browser. Redis stores only the verifier and validated store handle for 600 seconds, with exact SET NX acknowledgement. GETDEL consumes once; no GET/DEL fallback on uncertainty. Issuer must be `https://discord.com` before code exchange. Token and profile replies must be complete; only boolean `verified:true` with a valid address can prove an identity. Access/refresh tokens, Discord ID, name, avatar and profile are never persisted or logged. Provider responses are capped at 16 KiB each and five seconds each, with redirect following disabled. No provider request retries, including 429.

The native form component and start route exist. **The shared creator session completion, page button/notices, conditional privacy sections and callback integration await coordination with the owners of #1969, #2111 and #2135. This foundation is not a completed login feature.** Buyer library and /manage are a subsequent unit. Existing Discord purchase access/guild integration remains separate.

## Dated official rules

- [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2), read 2026-11-05: authorization code flow, state, client authentication, and issuer identification. Only the requested identity scopes are used; no bot/guild/message permission is requested.
- [Discord authorization server metadata](https://discord.com/.well-known/oauth-authorization-server), read 2026-11-05: issuer `https://discord.com`, code flow, `S256`, response issuer support, token endpoint `https://discord.com/api/oauth2/token`. This is the official evidence for PKCE support; no community source is used as authority.
- [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636), September 2015, read 2026-11-05: per-attempt verifier and SHA-256 challenge.
- [Discord User Resource](https://docs.discord.com/developers/resources/user), read 2026-11-05: `identify` permits current-user identity, `email` permits the email and boolean verification fields. Missing/null/unverified addresses cannot sign in. Discord verification is not represented as current mailbox ownership guaranteed by Marktmorgen.
- [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits), read 2026-11-05: provider rate limits vary. The site's own ceiling is distinct from Discord's limits; 429 is refused without an automatic retry.

## Cost and activation blockers

| Work per attempt | Hard ceiling in this foundation | Funding evidence |
| --- | --- | --- |
| Start abuse counter | Two Redis commands before state write, 20 starts per IP / 600 seconds | Company cost classification is not a paid global budget |
| State | One SET NX, one GETDEL; value <=1024 UTF-8 bytes; 600-second TTL | Provider-separated salt inside the existing auth-link family; key/Redis overhead also costs |
| Provider exchange/profile | At most two requests, <=16 KiB each, <=5 seconds each | Discord API price/charge ceiling not established by the official pages read; **unknown, never zero** |
| Callback counter/session/browser email | Not wired in this foundation | Same account-session mechanism required before completion; underlying company funding must be reviewed |
| Runtime, CPU, transfer, logs, company base, CI | Actual totals unknown | No finite global budget, monthly exposure or MR margin is claimed |

`tests/plan-cost-registry.ts` classifies the new guard as company account work; `tests/store-data-registry.ts` records the ephemeral state family. Neither registry entry certifies funding. Before any future activation, dated official worst-case provider/runtime/Redis costs, a global funded admission ceiling **before all paid work**, company fixed-cost allocation and MR evidence are required. The current null review deliberately has no production activation implementation.

## Owner's eventual Discord Developer Portal checklist

These are instructions only. An agent must never carry them out.

1. Review the then-current official pricing, developer terms, privacy/subprocessor requirements and button branding. Record dated evidence and all costs; absent pricing is not a zero-price proof.
2. In the owner's chosen Discord application, inspect OAuth2 settings and confirm the application identity, support details, site and policy/terms URLs. Reuse only if separately approved by the owner; this login does not install a bot.
3. Register the exact return URL `https://marktmorgen.com/api/integrations/discord/signin`. Keep the existing guild/purchase integration return URL intact. Configure only `identify` and `email` for this flow.
4. The owner supplies dedicated `DISCORD_SIGNIN_CLIENT_ID` and `DISCORD_SIGNIN_CLIENT_SECRET` through the deployment's secret settings. No real identifier or secret belongs in git, screenshots, logs or this document.
5. Complete and independently review session/two-step/browser-notice/conditional-privacy and buyer integrations, synthetic adversarial tests, and all nine required CI checks. The emailed link remains available.
6. Resolve the cost/funding blockers above in a separate reviewed unit. Only an explicit later owner instruction and reviewed activation change may consider enabling; **this task enables nothing**.

## Verification limits

`tests/discord-signin.test.ts` uses the real flow and ephemeral state with an in-memory Redis and a fetch stand-in restricted to the two Discord endpoints. Test-only policy wiring permits synthetic attempts without changing the production approval or null review. No Discord account or network request is involved. No end-to-end customer login, public availability, human accessibility evaluation or full AAA compliance is claimed by the foundation.
