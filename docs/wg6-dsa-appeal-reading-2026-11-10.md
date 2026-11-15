# "Ask us to look again": what is owed and what is a courtesy (646 [WG6], step zero, 10 November 2026)

**Status: a reading, not legal advice.** It changes no price, limit, commission, flag, gate or term. It records the
step zero that queue item 646 [WG6] asks for, and the rules built in `lib/takedown-appeal-rules.ts` (unit 1, held by
`tests/wg6-appeal-rules.test.ts`). Nothing is wired to a route, a page, a store record or an email yet.

## Sources read

| Key | Text | Address read | Read on | SHA-256 of the file read |
| --- | --- | --- | --- | --- |
| S5 | Regulation (EU) 2022/2065 (Digital Services Act), as originally published | https://publications.europa.eu/resource/celex/32022R2065 (resolved to the Cellar file `3ff67256-55c4-11ed-92ed-01aa75ed71a1.0006.03/DOC_1`) | 10 November 2026 | `11b119a7d45f3a10cd41714061f9d907839ef5d1634e41774490f00b95856bbf` |
| U1 | 17 U.S.C. § 512, United States Code, 2023 edition (GovInfo) | https://www.govinfo.gov/content/pkg/USCODE-2023-title17/html/USCODE-2023-title17-chap5-sec512.htm | 10 November 2026 | `7b8e2ec70d534473028f62bb42160c6517125e3e5f0efeeed576c47d0006cba3` |

S5 is the same file, with the same hash, as `docs/eu-dsa-readiness-2026-11-06.md` and
`docs/eu-consumer-audit-2026-11-06.md` read on 6 November 2026. U1 is the 2023 edition: amendments after it were not
checked (the US Code site's own page for the section answered 404 from this machine on 10 November 2026). Corrigenda
and consolidated versions of S5 were not checked. The Whop pages named in item 646 were read by Claude 4 on
5 November 2026 and were not read again here.

## What the texts say (short quotes)

- **Art. 17 applies to every hosting provider, whatever its size** (Chapter III, Section 2; the micro and small
  exclusion of Art. 19(1) covers Section 3 only). Art. 17(1): "a clear and specific statement of reasons to any
  affected recipients" for (a) restrictions of visibility, (b) restrictions of monetary payments, (c) suspension or
  termination of the service, (d) suspension or termination of the account. Art. 17(2): it applies "at the latest
  from the date that the restriction is imposed". Art. 17(3)(f): the statement includes redress, "in particular,
  where applicable through internal complaint-handling mechanisms, out-of-court dispute settlement and judicial
  redress".
- **Art. 20 (internal complaint-handling) is in Section 3**, which "shall not apply to providers of online platforms
  that qualify as micro or small enterprises" (Art. 19(1), quoted in `docs/eu-dsa-readiness-2026-11-06.md`). When it
  applies: "for a period of at least six months following the decision" (Art. 20(1)), the period starting "on the
  day on which the recipient of the service is informed about the decision" (Art. 20(2)); "electronically and free
  of charge" (Art. 20(1)); reverse "without undue delay" when the complaint has sufficient grounds (Art. 20(4));
  inform complainants of "their reasoned decision" and other redress (Art. 20(5)); decisions "under the supervision
  of appropriately qualified staff, and not solely on the basis of automated means" (Art. 20(6)).
- **17 U.S.C. § 512(g)(2) [U1]**: the provider's protection for a good-faith takedown holds for subscriber material
  only if, on a counter-notification, it "replaces the removed material and ceases disabling access to it not less
  than 10, nor more than 14, business days following receipt of the counter notice", unless the notifier has gone to
  court (§ 512(g)(2)(C)).

## Owed now, and a courtesy until the size trigger

| Part of 646 [WG6] | Owed now? | Why | State on `origin/main` (6847758ca) |
| --- | --- | --- | --- |
| Statement of reasons for each takedown and suspension, with redress | **Owed** (Art. 17, no size exclusion) | Art. 17(1)–(4) | Built: the email in `lib/takedown.ts` (`complete`), held element by element by `tests/eu-dsa-statement.test.ts`. Not changed here. |
| The same statement shown in the studio | Not required by Art. 17 beyond the email; useful | Art. 17(4) asks that it reasonably allow redress | The studio shows a short notice (`app/studio/page.tsx`, "taken down from your store after notices"); the full lines are in `decisionNotice` (unit 1), not shown yet |
| "Ask us to look again" with a number, states and a reasoned answer | **Courtesy** while Marktmorgen is a micro or small enterprise (Art. 19(1)); owed from the end of the exclusion | Art. 20 | Rules built in unit 1, to Art. 20's shape, so nothing changes when it becomes owed |
| Six months to ask | Courtesy now; Art. 20(1)–(2) minimum later | Art. 20(1)–(2) | `appealDeadline`: to the end of the day six calendar months after the creator was told, in every time zone (UTC-12), a missing day rolled forward. Whop's 30 days would be shorter than Art. 20 allows |
| Only a person decides; the final answer carries its reason | Courtesy now; Art. 20(5)–(6) later | Art. 20(5)–(6) | `moveAppeal`: only `operator` moves a request; `upheld` and `reversed` need a reason |
| Out-of-court dispute settlement named | Not now ("where applicable": Art. 21 is Section 3) | Art. 17(3)(f), Art. 21 | The email names the courts (judicial redress), not a settlement body; the notice does the same |
| Notifiers may also complain | Courtesy now; Art. 20(1) "including individuals or entities that have submitted a notice" later | Art. 20(1) | **Gap**: by design the notifier is emailed nothing (`lib/takedown.ts`, header). Not covered by unit 1 |

## A finding for the coordinator (not fixed here)

A link taken down by a notice is deleted with its file (`lib/takedown.ts`, `apply` and `stillUp`: "How long: for good.
The link and its file are deleted, so there is nothing to put back."). The same email, for a copyright notice,
tells the creator that on a counter-notice "we pass it to them, and put the content back in 10 to 14 business days".
For a link, nothing can be put back, so § 512(g)(2)(C) [U1] cannot be met for it, and the email says two things that
cannot both be true. The fix (keep the link and its file hidden instead of deleted, until the notice is settled, at a
bounded storage cost) belongs in `lib/takedown.ts`, which open PR #3382 changes; it is left to whoever holds that file.
Unit 1 does not promise what the code cannot do: `restorable("link")` is false, and the notice and the "Reversed"
words say the link cannot be put back.

## Cost, worst case, before anything is spent

Unit 1 is pure code: no request, write, email or file. Its cost on every plan is nothing new by construction; it adds
no plan line. The ceilings for the next units are fixed now, before any spend:

- **Stored per request**: at most `appealStoredBytesCeiling()` = 12,604,448 bytes (text 3,000 characters and reason
  1,000 at four bytes each, three files of at most 4 MiB with names, 4,096 bytes of record). One request per
  decision, so per store at most that times its decisions (the store keeps at most 50, `parseStrikes`).
- **Emails per request**: at most 3 (`APPEAL_EMAILS`: received, under review, final answer), on Marktmorgen's own
  transport, metered as the company's (`meter: { by: "company" }`, as the takedown emails are).
- **Who pays**: the company, not a plan: every decision is Marktmorgen's own act, paced by a person pressing a
  button. These are fixed costs under FX275, priced by the next unit against the dearest file-storage figure in the
  code (`HELD_FILE_MICRO_USD_PER_GB_MONTH`, US$0.023 per GB-month) and the email figure in force, with a daily ceiling
  checked before each send.
- **Unknown, never zero**: the owner's time to decide each request (Art. 20(6) needs a person). It is a fixed cost
  with no figure until volume is measured.

## Next units (not built)

1. Storage: one request per decision under the store (`lib/store-data.ts` family), number taken only when missing,
   files under the ceilings above, kept like the notice (400 days), deleted with the store's data.
2. Studio: the notice's lines next to each decision, the "Ask us to look again" form and the request's state, with
   the AX274 checks of a form (labels, errors, review before sending).
3. Operator: the states on `app/takedown/[token]`, the reason field, the reversal through the existing switches,
   the emails with their daily ceiling.
4. Notifiers' complaints (Art. 20(1)), once the owner decides how a notifier is reached.
