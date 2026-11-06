# Independent review: #2916 Meta requirements

Reviewed exact head: `b6437e638793a9c08f4781229d94dfbb3f8b736d`. Base: `5c07315505e1d53ee6401021601cd688fa98ecda`. Reviewer: Codex T. Claim `6697761803` and reservation `4cfb546bbd5908a808c823ffd914f8fc803a0db5` preceded source inspection. Source: entire `docs/meta-requirements.md`, blob `1f80c73a93a58b73f5954962b5b04dd905301a0c`, 18,773 characters / 166 lines.

## Conclusion and boundaries

No high or medium issue demonstrated in this document-only study. Two LOW documentary findings remain: a pricing-source reconciliation gap and an internal mismatch between the stated conservative-source rule and the future send-rate row. This is not a clean review yet. No formal PR review is submitted by this artifact; the coordinating reviewer checks it first.

The author clearly labels indexed extracts as unverified, keeps channel implementation blocked on dated primary evidence, leaves costs unknown, and reserves app creation, verification, submissions and terms to the owner. These are appropriate boundaries. Failed retrieval is not evidence that a platform statement is false. No commercial release, app approval, legal compliance, financial margin, API eligibility or runtime safety is certified here.

## LOW 1 — reconcile the WhatsApp pricing sources and narrow the utility claim

Location: source line 79, section 6; related sources S14/S18/S19.

The paragraph combines an October 1, 2026 change for utility replies and service messages, a 1,000-service-message allowance and a utility/authentication-rate description. The current primary sources accessible to this review do not form one consistent policy statement:

- The official [WhatsApp pricing page](https://whatsappbusiness.com/products/platform-pricing/), reached through listed S19, says service messages and utility responses to users are not charged (retrieved November 6, 2026, lines 128–132 and 171–172).
- The official [WhatsApp FAQ](https://whatsappbusiness.com/resources/faq/), opened as a focal check on the same date, explicitly supports the service-message change effective October 1, 2026 and the first 1,000 service messages per business phone number each month (lines 149–151). It does not establish this paragraph's complete utility-within-window/rate assertion.
- The FAQ itself still contains an older conversation-based description at line 125, reinforcing the need to distinguish versions rather than treating a page as wholly current. S14 returned a login shell; S18 returned 429, so their full text was not read.

**This is not a finding that the October date or 1,000-service allowance is fabricated or false:** the directly opened official FAQ supports them. The actionable correction is to cite that dated primary support explicitly, record the conflict with S19, and distinguish the still-unverified utility/rate clause from confirmed service text. Until a coherent dated source is obtained, keep that unresolved portion unknown and unsuitable for implementation or cost certification. Do not replace the paragraph with a claim that WhatsApp, Meta quotas, Marktmorgen processing or the creator's total cost is free.

Severity is LOW because the study is expressly provisional, no channel is activated and no actual billed operation or financial loss is demonstrated.

## LOW 2 — future rate row overstates the chosen working assumption

Locations: line 10; rate discussion line 69; implementation-gap table line 109.

Line 10 says the stricter reading is the working assumption when official pages disagree. Line 69 records 300 sends/second in an indexed changelog versus 100 in the overview. Line 109 nevertheless names only 300/second in the future counter requirement. This is an internal documentary inconsistency, independent of whether either indexed value is currently correct.

The actionable correction is to keep the row explicitly unresolved pending dated primary confirmation, or accurately describe the stated conservative provisional assumption. Do not present 300/second as a settled implementation prerequisite while simultaneously requiring the stricter source. This review does not approve a new limit, change a product allowance, or certify 100/300 as Meta's actual current rule. The relevant direct developer pages were unavailable.

No runtime counter exists in the inspected pure modules, so no live rate-limit breach is alleged. Severity is LOW, not medium.

## Primary-source access ledger

All access below was read-only on November 6, 2026. No login, account creation, accept button, submission, API call to a provider's operational endpoint, purchase or terms acceptance was performed. Retrieval timestamps are review dates, not invented content-publication dates.

Every one of the 28 listed source URLs was attempted exactly once, in three packages. Six official-domain search queries and one additional direct FAQ opening were the focal checks, within the reserved 28 + 10 ceiling. No repeated attempts were used to bypass a refusal.

| Listed sources | Result observed |
| --- | --- |
| S19 | Full readable official pricing page; redirects from business.whatsapp.com to whatsappbusiness.com; source conflict described above |
| S27 | Full readable TikTok help page; redirects to ads.tiktok.com/resources/help/article/how-to-set-up-auto-messages-for-business-accounts; page says last updated May 2026 |
| S28 | Full readable official WhatsApp Business Messaging Policy; redirects to whatsappbusiness.com/policy/; page says last updated September 23, 2026 |
| S14 | Login shell only; no pricing documentation body |
| S26 | TikTok Business Messaging API portal returned zero readable lines |
| S1, S2, S3, S6, S8, S9, S10, S15, S16, S17, S18, S20, S21 | 429 / Too Many Requests; direct primary content not verified |
| S4, S5, S7, S11, S12, S13, S22, S23, S24, S25 | URL inaccessible through the retrieval tool; direct primary content not verified |

The readable [WhatsApp policy](https://whatsappbusiness.com/policy/) supports prior opt-in, respecting opt-out, approved templates outside the customer-service window, and available escalation paths for automation. It does not certify a rate card or an integration's approval.

The readable [TikTok help page](https://ads.tiktok.com/resources/help/article/how-to-set-up-auto-messages-for-business-accounts) supports the stated Advanced Access / Verified Business Account restriction for in-app automatic messages. It is not proof that a particular third-party Business Messaging API permission, onboarding path or rate limit is available; S26 remained unreadable.

The Instagram permission combinations, Unified Login recommendation, App Review/BV specifics, HUMAN_AGENT/tag changes, private-reply age/count details, send/private-reply rate numbers, Embedded Signup version/date, deletion-callback contract and rate-card amounts remain unverified by direct developer-document access in this review. They must not be promoted from indexed observations to approved channel requirements on the strength of this report. No extra finding is fabricated solely because those pages could not be opened.

## Static repository cross-checks

These are source inspections at the exact reviewed snapshot, not tests or provider checks:

| Referenced source | Git blob | What was actually checked |
| --- | --- | --- |
| `lib/autodm-rules.ts` | `e8e625b445161f8e1519a0e0bd369a88886a2acf` | Import-free rules; AUTODM_LIVE is false at line 51; MAX_TESTERS is 3 at line 297; no channel IO |
| `lib/autodm-reply-rules.ts` | `250818890825d6e979dc03276a22da6594040170` | REPLY_MAX_CHARS is the project's 500-character cap; pure fingerprint/kept-mark contract; live decisions retain the constant gate; no persistent store or sender |
| `app/api/integrations/meta/deauthorize/route.ts` | `01a803d7f15ab4032aa4979e8c51360f74afbc57` | Existing ads callback takes signed_request and calls forgetMetaUser; comment says it is registered for ads deauthorization/deletion; no live dashboard registration or deletion behavior independently executed |
| `app/privacy/page.tsx` | `d24693d91e5382186ec5e3364d4e0a31cc584e76` | Meta-related clauses inspected: pixels/ads and ad-connection data, without a new AutoDM/WhatsApp channel privacy contract |
| `docs/us-llc-owner-roadmap-2026-10-28.md` | `73d1fc5f189b0b7829731caaa908a2f527b2b676` | Historical owner prerequisites and private evidence requirements; not proof of current company formation or Meta acceptance |

The study's code inventory is appropriately read as a description of pure decision helpers. A server-supplied fingerprint argument is not independently verified server persistence, and a decision result is not a message actually sent. No current account, app, connection, private record or business document was probed.

## Verification actually performed

- Entire study source read through fetch_blob after its SHA lookup; referenced code/owner prerequisite texts inspected statically as scoped above.
- All listed public URLs attempted; directly readable official pages distinguished from index extracts, login shells, empty pages and failures.
- Source comparison identified the two documentary findings above. No runtime RED was manufactured for a study; no app/source correction was made.
- No native execution, dependency installation, test suite, TypeScript, scanner, lint, build, browser, accessibility-conformance or CI GREEN claim.
- Only this new reviewer report is written on an isolated codex/t-* evidence branch. Author source, ref, PR head, flags, costs, limits and CI remain untouched.

G1 remains a partial study. A corrected documentary return does not authorize implementation, activation, Meta approval, owner actions or paid IO.
