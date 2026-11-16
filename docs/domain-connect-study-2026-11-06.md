# Domain Connect for creators' own domains (658 [WG18])

Date: November 6, 2026. Sources read: November 6, 2026.

**Status: Study only: nothing built, nothing changed, nothing available to customers (VR).** No template was written to any repository, no upstream Domain Connect template pull request was opened (this study itself is delivered in a Marktmorgen pull request), no DNS provider was contacted, no account was created, no terms were accepted and no key was generated. Prices, limits, commissions, flags and gates are unchanged.

## Resumo para o dono

- Domain Connect é um protocolo aberto: o criador clica "Conectar", entra no site do registrador dele, confirma, e os registros DNS são gravados lá. Nenhuma senha passa pelo Marktmorgen.
- Para isso o Marktmorgen precisa publicar um modelo (template) no repositório público do protocolo e ser aceito por cada registrador, um por um. Isso é contato com terceiros e, portanto, decisão sua.
- Suporte confirmado em fonte oficial datada: GoDaddy, IONOS, Cloudflare e Squarespace Domains (lista do rascunho IETF de 03/07/2026). Só a Cloudflare tem passo a passo de aceitação que conseguimos ler; Namecheap, Porkbun, Gandi, Hover, OVH e NameSilo ficaram sem confirmação (sites bloqueados nesta sessão).
- Nenhuma taxa foi encontrada, mas o protocolo permite que o registrador cobre ou exija contrato: custo desconhecido, nunca zero.
- A construção reaproveitaria as chamadas que já existem à API de domínios da Vercel e a prova `_marktmorgen` que já existe; o novo seria uma consulta DNS e uma leitura HTTPS por clique, com teto.
- Sem registrador compatível, o fluxo atual (copiar os registros) continua igual.
- Recomendação única (depende de você): autorizar dois modelos síncronos e assinados, um para o domínio principal (apex) e outro para subdomínios, e pedir aceitação primeiro só na Cloudflare. Um modelo só não passa no verificador oficial do repositório de modelos.
- Risco aberto que piora em relação a hoje: quem reivindica um domínio alheio pode mandar ao dono verdadeiro um link assinado, e basta um clique de consentimento no registrador. Ver seção 5 e seção 8.

## 1. How a custom domain is connected today (from the code)

Read in this worktree on November 6, 2026:

- `lib/domains.ts`: `connectDomain` claims `nl:domain:<name>` in Redis as `?<handle>` (not proved; lapses after `UNPROVED_SECONDS` = 3 days), then `POST /v10/projects/{project}/domains` at Vercel. `readDomain` calls `GET /v9/projects/{project}/domains/{name}` and `GET /v6/domains/{name}/config`, and turns Vercel's answer into the records the creator copies:
  - apex: `A @` = Vercel's `recommendedIPv4` (fallback `76.76.21.21`);
  - subdomain: `CNAME <sub>` = Vercel's `recommendedCNAME` (fallback `cname.vercel-dns.com`);
  - Vercel's own `TXT` verification records, only when Vercel reports the domain as unverified (in use elsewhere);
  - our proof: `TXT _marktmorgen.<name>` = `marktmorgen-verify=<sha256(sid, name), 32 hex>` (`proofRecord`).
  `verifyDomain` (`POST /v9/.../verify`) and `disconnectDomain` (`DELETE /v9/...`) complete the set. Every Vercel call has the `DOMAINS_TIMEOUT_MS` (15 s) ceiling.
- `lib/domain-proof.ts`: `proveDomain` resolves the `_marktmorgen` TXT (4 s DNS timeout) and only then swaps `?<handle>` to `<handle>`, so the domain starts serving.
- `lib/checkup.ts`: the studio checkup reads the domain through `domainCheckup` (two Vercel GETs, `CHECK_WAIT_MS` = 8 s), and an answer that did not come is "not checked", never "wrong".
- `app/api/store/domain/route.ts` and `components/domain-editor.tsx`: the studio card with `connect`, `check` and `remove`; the creator types the records at their DNS provider and presses "check". Nothing in Marktmorgen ever writes to the creator's DNS.
- Custom domains come with the Studio and Scale plans (`canUse(store, "domain")` → `hasPro`, `lib/plan.ts`; the public wording is in `lib/site-pages.ts`).
- 47 [H4] in `docs/codex-queue.md` is *buying* a domain inside the product (state "a fazer", document only; cancelled by LQ7 and reopened by LQ13). Domain Connect does not buy anything: it only writes records for a domain the creator already owns. This study does not cover or absorb 47 [H4].

What Domain Connect would change: only the step "the creator copies records into their DNS panel". Claiming, Vercel registration, our ownership proof, the checkup and removal stay exactly as they are.

## 2. The protocol in plain words

- **Roles.** Marktmorgen would be a *Service Provider*; the company hosting the creator's DNS (often the registrar) is the *DNS Provider*.
- **Template.** We describe, once, the records our service needs, with variables (for example the IP Vercel gives us). DNS Providers apply only templates they have onboarded; they never accept arbitrary records.
- **Discovery.** We look up the TXT record `_domainconnect.<apex>`; its content is the provider's host, and `GET https://{that}/v2/{domain}/settings` returns `providerId`, `providerName` and the URL prefixes (`urlSyncUX`, `urlAsyncUX`, `urlAPI`). A missing URL means that flow is not offered for that domain. `GET {urlAPI}/v2/domainTemplates/providers/{providerId}/services/{serviceId}` answers 200 if our template is onboarded there, 404 if not.
- **Synchronous flow.** We send the creator's browser to `{urlSyncUX}/v2/domainTemplates/providers/{providerId}/services/{serviceId}/apply?domain=…&host=…&<variables>&redirect_uri=…&sig=…&key=…`. The creator signs in *at the provider*, the provider checks they control the zone, shows what will change and asks for consent, then writes the records. We receive no token and no credential.
- **Asynchronous flow (OAuth).** Same start, but instead of applying, the provider gives us an OAuth code, which we exchange for a token to apply templates later. Each provider must register us as an OAuth client manually and we would hold a token per creator.
- **Signing.** With `syncPubKeyDomain` in the template, we must sign every apply URL (RS256) and publish the public key as TXT at `<key>.<syncPubKeyDomain>` (for example `_dcpubkeyv1.domainconnect.marktmorgen.com`); providers reject unsigned requests. The Templates repository makes `syncPubKeyDomain` a binding rule.
- **Host/subdomain.** `domain` is the registered domain (apex); `host` is the subdomain label. Template records are relative to `host`. A `CNAME` at the template's own host (`@`) is allowed only when the template sets `hostRequired: true`, which means the template works only when both `domain` and `host` are given (S1, Template Record). So a template with a `CNAME @` cannot serve the apex.
- **Redirect.** `redirect_uri` must be in the template's `syncRedirectDomain` unless the request is signed; providers echo `state` and append `error=` on failure. Cloudflare ignores `syncRedirectDomain` and reads the `redirect_uri` of the signed URL (S6).
- **Return is not proof.** The spec says the Service Provider should verify the change in DNS, not trust the redirect. Our existing "check" already does exactly that.

### What Marktmorgen would publish (draft shape, not submitted)

Two templates, sync only, signed. One template for both cases does not work:

- The Templates repository's official linter (`Domain-Connect/dc-template-linter`, commit `6e8ca43`, `libdctlint/record.go`) rejects a `CNAME` whose host is `@` when the template's `hostRequired` is false: rule DCTL1012, at error level. The Templates README says a template pull request whose full check does not exit with code 0 cannot be merged (S5). A single template with `A @` and `CNAME @` and no `hostRequired` would therefore be refused.
- With `hostRequired: true`, providers that honor the field refuse to apply the template at the apex. Cloudflare ignores `hostRequired` and flattens a CNAME at the apex (S6), so a single template could only work at Cloudflare, and the apex would be lost at GoDaddy, IONOS and Squarespace Domains.
- Vercel's own template sets `"hostRequired": true` (S8). Its other path, `%subdomain%` inside a record's `host`, is forbidden by rule 8 of the Templates README (S5), so it is no model either.

| Template (proposed `serviceId`) | Record | Value | Why |
|---|---|---|---|
| `storefrontapex` (apex, no `host`) | `A @` | `%ip%` (Vercel's `recommendedIPv4`) | the apex points to the store |
| `storefrontapex` | `TXT _marktmorgen` | `marktmorgen-verify=%proof%` (fixed prefix) | the same proof `lib/domain-proof.ts` already checks |
| `storefront` (subdomain, `hostRequired: true`) | `CNAME @` (relative to `host`) | `%target%` (Vercel's `recommendedCNAME`) | the subdomain points to the store |
| `storefront` | `TXT _marktmorgen` (relative to `host`) | `marktmorgen-verify=%proof%` (fixed prefix) | the proof at `_marktmorgen.<host>.<domain>`, exactly where `proofRecord` puts it |

Proposed identifiers (owner to confirm; both `serviceId` values are to be checked against the repository's naming rules and the linter before any submission): `providerId` `marktmorgen.com`, `serviceId` `storefrontapex` and `storefront`, `syncPubKeyDomain` `domainconnect.marktmorgen.com`, `syncRedirectDomain` `marktmorgen.com`. File names would be `marktmorgen.com.storefrontapex.json` and `marktmorgen.com.storefront.json`. `%ip%` and `%target%` are bare variables, which the repository accepts only with a justification in the pull request (Vercel's own template does the same); the signature is what stops anyone else from filling them. Vercel's "in use elsewhere" TXT stays on the manual path: its host comes from Vercel's answer (`readDomain` uses `hostPart(item.domain, apex)`), so it is not fixed and neither template can carry it.

Fields Cloudflare ignores (S6): `hostRequired` ("Host Required: Is not supported and will be ignored"), `txtConflictMatchingMode` ("TXT Conflict Matching Mode: Is not supported and will be ignored") and `syncRedirectDomain` ("Synchronous Redirect Domains: Is not supported and will be ignored"). Neither template counts on them: an old `_marktmorgen` TXT left beside the new one does not break the proof, because `proveDomain` accepts the record when any of the TXT values matches.

## 3. Providers

"Supported" means named as a Domain Connect DNS Provider in an official source we could read today. Where the official page was blocked, the cell says so; nothing is guessed.

| Provider | Support (source) | Flow | Onboarding / approval | Cost | Creator's steps | Source, date read |
|---|---|---|---|---|---|---|
| Cloudflare | Yes | Sync only | Template merged in the public repository, then email `domain-connect@cloudflare.com` with template links, key domain, SVG logo, default proxy status; signature required; `state` ignored; `APEXCNAME` makes onboarding fail | Not stated: unknown, not zero | Connect in studio → sign in at Cloudflare → confirm → return → "check" | S6, 2026-11-06 |
| GoDaddy | Yes | Sync and async endpoints shown in the official client example (2024) | Manual, per provider (spec); GoDaddy's own terms not read | Unknown, not zero (spec allows fee or contract) | Same as above, at GoDaddy | S3, S7, 2026-11-06; own page blocked |
| IONOS (1&1) | Yes | Sync and async endpoints shown in the official client example (2024) | Manual, per provider; IONOS's own terms not read | Unknown, not zero | Same, at IONOS | S3, S7, 2026-11-06; own page blocked |
| Squarespace Domains (ex-Google Domains) | Yes | Not confirmed | Not confirmed | Unknown, not zero | Same, at Squarespace | S3, 2026-11-06; own page blocked |
| WordPress.com, Plesk | Yes (also listed) | Not confirmed | Not confirmed | Unknown, not zero | Same | S3, 2026-11-06 |
| NameSilo | Not confirmed (only a search summary, not an official page read) | — | — | — | Current flow | Gap |
| Namecheap, Porkbun, Gandi, Hover, OVH | Not confirmed | — | — | — | Current flow | Gap |
| Vercel | Publishes its own template as a *Service Provider* (`vercel.com.website.json`, signed with `domainconnect.vercel.com`, redirect `vercel.com`); we cannot use it, because only Vercel holds that key. No source read shows Vercel DNS acting as a *DNS Provider* | — | — | — | Current flow if the creator's DNS is at Vercel | S8, 2026-11-06 |

The IETF draft counts "~20 providers"; the full names are on domainconnect.org, which was blocked. Any provider not confirmed stays on the current flow by design (section 6), so an unconfirmed row costs nothing and breaks nothing.

## 4. Vercel records a template would set

Vercel's documentation pages were blocked, so the record values are not taken from them. The template does not need fixed values: the code already asks Vercel for the exact values per domain (`recommendedIPv4`, `recommendedCNAME` from `GET /v6/domains/{name}/config`) and would pass them as `%ip%` and `%target%`. Vercel's own published template does the same (`"pointsTo": "%ip%"`, `"pointsTo": "%cname%"`, TXT `_vercel` `vc-domain-verify=…`, `"hostRequired": true`), which confirms the shape. A shared third-party template (`btfs.sh.vercel.json`, added 2026-10-31) points a subdomain at the fixed `cname.vercel-dns.com`; it is signed with btfs.sh's key, so it is a precedent only, not something we could use.

## 5. Security: no password through Marktmorgen

- **Where the creator authenticates.** Only at the DNS provider's own site, in their browser, with their own password and second factor. In the sync flow Marktmorgen receives nothing but an optional redirect back. No token is issued to us, so there is no secret per creator to store or leak. The async flow would add an OAuth token per creator; it is not recommended (section 8).
- **What we sign.** Only on the server, only for the signed-in member with the `settings` permission (`guardStoreWrite`), only for the domain that store has already claimed (`nl:domain:<name>` = `?<handle>`/`<handle>`), and only with values taken from Vercel's live answer and `proofRecord`. Never from text the browser sends. This keeps us from being a signing oracle.
- **Keys.** An RSA key pair: the private key as a sensitive Vercel environment variable, the public key as TXT under `domainconnect.marktmorgen.com` (a DNS change on marktmorgen.com, which is an owner action), rotation by publishing `_dcpubkeyv2` before switching `key=`.
- **Redirect and state.** `redirect_uri` fixed to `https://marktmorgen.com/studio#domain`. The return means "look again", nothing more. Cloudflare ignores `state`, so nothing may depend on it.
- **Ownership is still proved by DNS.** `proveDomain` reads `_marktmorgen` and `domainCheckup` reads Vercel exactly as today. A forged or tampered return can at most trigger a read.
- **Discovery input is untrusted.** The `_domainconnect` TXT is controlled by whoever controls the zone. The draft requires bounding it: connect and total timeouts, maximum body size, no or limited redirects, refusing loopback, private and link-local targets.
- **Underscored hosts.** The draft warns about `host` values like `_acme-challenge`. `cleanDomain` already refuses any label with `_`, so we would never send one.
- **Residual risk (open, worse than today).** Someone could claim a domain they do not own. The sync flow builds the signed apply URL in the browser of whoever claimed it, so that person can copy it and send it to the domain's real owner. Today the real owner would have to type an A and a TXT record by hand; with Domain Connect, one click of consent on a provider screen that names "Marktmorgen" is enough. This is the case the spec describes under "Risk of phishing with open template parameters" (S1). The signature stops anyone from changing the variables; it does not stop a valid, signed link for a hostile claim, and the `%proof%` written with it is derived from the attacker's store. Keeping the link inside the studio does not help, because the attacker is the one in the studio. The claim still lapses in 3 days if the proof never appears. Possible measures, **proposals only, not built and not measured**: a limit on apply links per store and per domain, links only while the claim is fresh, and the store's public address shown beside the button so a real owner can see whose store it is. The decision is the owner's (section 8).

## 6. What it requires of Marktmorgen

1. **Contact with third parties, so an owner decision:** a public pull request to `github.com/Domain-Connect/Templates` (needs a GitHub account; the repository requires an Online Editor test link from `domainconnect.paulonet.eu`, another third-party site, and a `logoUrl`), then a separate onboarding with each DNS provider (Cloudflare by email; others by their own process, possibly a contract or fee).
2. **Key management:** generate, store and rotate one signing key; publish its public half in marktmorgen.com's DNS.
3. **Build (future, not authorized here):** in `lib/domains.ts`/route, a discovery step (1 DNS TXT lookup, 1 settings GET, optionally 1 supported-template GET), URL signing, and a "Connect at <provider>" button beside the existing record list. No new Vercel endpoint: the same `POST /v10/.../domains`, `GET /v9/...` and `GET /v6/.../config` calls, the same count per connect and check.
4. **Ceilings before any spend:** at most one discovery per "connect" press (≤ 1 DNS lookup + ≤ 2 HTTPS GETs, each ≤ 4 s and ≤ 16 KB, no redirects), inside the existing write guard; zero new Vercel calls. These numbers are proposals for the build item, not measured costs.
5. **Costs:** Domain Connect itself has no published fee in the sources read. Provider onboarding fees: unknown, not zero. Hosting compute for discovery and signing: unknown, not zero (small CPU per press, not measured). The study's own work (agent compute, CI runs and review time) was not measured: unknown, not zero.

## 7. Fallback

Without a compatible provider (no `_domainconnect` record, settings not answering, template answers 404, the creator cancels, or any error), the studio shows exactly what it shows today: the record list from `readDomain`, and the "check" button. The manual path is never removed and is always shown. Domain Connect would only add a shortcut above it.

## 8. Depende do dono

**One recommendation:** authorize two **synchronous, signed** templates (`marktmorgen.com.storefrontapex` for the apex and `marktmorgen.com.storefront` for subdomains, `hostRequired: true`; records in section 2) submitted to the public Templates repository, and request onboarding **first only with Cloudflare**. GoDaddy, IONOS and Squarespace Domains come later, only after their own onboarding terms are read from their own pages. No asynchronous/OAuth flow.

**Open risk to decide first (worse than today):** a hostile claim can turn into a phishing link that needs one click of consent from the real owner (section 5). No measure that removes it was found; the proposals in section 5 are not built. Building Domain Connect means accepting this risk or choosing measures for it.

Reasons:
- Cloudflare is the only provider whose onboarding steps, rules and requirements could be read in an official dated source today; it supports sync only, which is also the flow with no creator token to hold.
- Signed sync is mandatory in practice (Templates repository rule, Cloudflare requirement) and is the setup where no password or token reaches us.
- It reuses the Vercel calls and the `_marktmorgen` proof that already exist; the manual flow stays as the fallback.
- The repository merges quickly (average 0.9 days in October 2026, from the project's own statistics). Provider onboarding time is unknown.

What it costs: no fee found (Cloudflare's page names none; the spec allows fees, so unknown, not zero). It needs a public GitHub pull request and an email to Cloudflare from an account the owner chooses (third-party contact), one DNS TXT record on marktmorgen.com, one signing key held as a secret, and a later build item with the ceilings in section 6. **This needs the owner's decision; nothing here was done.**

## 9. Sources (all read 2026-11-06)

- **S1** Domain Connect spec, rev. 67, 3-02-2025: https://github.com/Domain-Connect/spec/blob/master/Domain%20Connect%20Spec%20Draft.adoc (commit `6a4735c`). "A DNS Provider can be selective in what templates they support, can require a contractual relationship, or even charge a fee for onboarding." / "Service providers wishing to use the OAuth flow must register as an OAuth client with each DNS provider. This is a manual process." / "it is recommend that enablement of a service be based on verification of changes to DNS."
- **S2** IETF draft-ietf-dconn-domainconnect-03, published-date 2026-07-03, source on the spec repository's release branch: https://github.com/Domain-Connect/spec/blob/ietf/release/draft-ietf-dconn-domainconnect-03/draft-ietf-dconn-domainconnect-03.adoc (commit `c4a13dd`). "The template is defined by the Service Provider and manually onboarded with the DNS Provider." / "When `"syncPubKeyDomain"` is present in the template, the Service Provider MUST sign the request and the DNS Provider MUST reject any unsigned apply request" / "Service Providers MUST treat the `"_domainconnect"` TXT record content, and the Settings End-Point response derived from it, as untrusted input."
- **S3** Same draft, Implementation Status: "~20 providers, incl. GoDaddy, IONOS, Cloudflare, Squarespace Domains (former Google), Wordpress.com or Plesk" and "35% of the .com zone (May’24)".
- **S4** IETF draft-ietf-dconn-domainconnect-async-00, published-date 2026-06-14, same branch: "Service Providers wishing to use the OAuth flow MUST register as an OAuth client with each DNS Provider."
- **S5** Templates repository README: https://github.com/Domain-Connect/Templates (commit `f5f70ed`, 2026-11-05; the full-check rule and rule 8 re-read at head `5b12fb6`). Linter: https://github.com/Domain-Connect/dc-template-linter (commit `6e8ca43`), `libdctlint/record.go` DCTL1012 "record host must not be @ when template hostRequired is false", error level (`internal/dctl.go`). "Set `syncPubKeyDomain` in every template." / "onboarding is never automatic — it requires an explicit OAuth setup with each provider." / "Pull Requests that do not include a link to editor test results will not be reviewed."
- **S6** Cloudflare, "Domain Connect" (source of developers.cloudflare.com/dns/reference/domain-connect/): https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/dns/reference/domain-connect.mdx (repository head `2a3a062`, 2026-11-06). "Note that Cloudflare only supports the Domain Connect synchronous flow." / "Send an email to `domain-connect@cloudflare.com`" / "**State**: Is not supported and will be ignored." / "**Signature**: Required. It also must be the last query parameter." / "**APEXCNAME**: Not supported, and will cause the onboarding to fail." At commit `7fc6c61` of the same file: "Host Required: Is not supported and will be ignored", "TXT Conflict Matching Mode: Is not supported and will be ignored", "Synchronous Redirect Domains: Is not supported and will be ignored" and "Cloudflare automatically applies CNAME flattening at the zone apex".
- **S7** Domain Connect Python client README: https://github.com/Domain-Connect/domainconnect_python (commit `ebf5815`, 2024-02-18). "https://domainconnect.1and1.com/sync/v2/domainTemplates/providers/…" and "api_url='https://domainconnect.api.godaddy.com'".
- **S8** Vercel's template: https://github.com/Domain-Connect/Templates/blob/master/vercel.com.website.json (version 4, last changed 2026-04-07, #955). `"syncPubKeyDomain": "domainconnect.vercel.com"`, `"syncRedirectDomain": "vercel.com"`. Also `btfs.sh.vercel.json` (2026-10-31, #2720).
- **S9** Templates statistics: https://github.com/Domain-Connect/stats/blob/main/docs/stats.json (generated 2026-11-05T04:03:45). `"total_templates": 2412`, `"total_providers": 1568` (template publishers, not DNS providers), October 2026 `"avg_days": 0.9` to merge.

The domainconnect.org, ietf.org and developers.cloudflare.com pages were not reachable. S2 to S6 were read from the public Git sources of those pages (cloned with `git`), not from the rendered sites.

## 10. Gaps (not confirmed in an official source)

- Blocked by this session's network policy: `www.domainconnect.org` (official DNS provider list and getting-started), `www.ietf.org` and `datatracker.ietf.org` (published draft text), `domain-connect.github.io`, `developers.cloudflare.com` (read via its GitHub source instead), `vercel.com` (custom-domain record docs), GoDaddy, IONOS, Squarespace, Namecheap, Porkbun, Gandi, Hover, OVH and NameSilo sites, `domainconnect.paulonet.eu`, and DNS resolution (no live `_domainconnect` lookups or settings calls were possible).
- Full current DNS provider list and the per-provider sync/async status for each provider except Cloudflare.
- Onboarding process, terms, contract and fee for GoDaddy, IONOS, Squarespace Domains, WordPress.com and Plesk.
- Whether Namecheap, Porkbun, Gandi, Hover, OVH or NameSilo support Domain Connect.
- Whether Vercel DNS acts as a Domain Connect DNS Provider, and whether a platform on Vercel may use Vercel's own template (assumed no: it is signed with Vercel's key).
- Vercel's documented A/CNAME values and its guidance on Cloudflare proxying. The default proxy status to request from Cloudflare ("DNS only" is the likely choice so Vercel sees its own records) is unverified.
- Whether a template record host of `%domain%.` (apex from a subdomain apply) is supported by each provider. Not needed by the draft templates.
- The linter was read, not run (compiling and running external code was not done); DCTL1012 and its level come from its source at commit `6e8ca43`. The linter, the Templates README at `5b12fb6` and cloudflare-docs at `7fc6c61` were read by the second review of this study (Claude 5, 2026-11-07) and are cited from that reading; they were not re-read for this revision.
- Where marktmorgen.com's own DNS is hosted (needed for the public-key TXT).
- Provider onboarding duration; the hosting compute cost of discovery and signing.

## 11. Rules kept

No price, limit, commission, flag, gate or plan entitlement was changed. No account, terms, contract, payment, template submission or contact with any third party was made by this study. No code, configuration or other document was edited. Unknown costs are recorded as unknown, never zero.
