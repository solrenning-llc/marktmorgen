# Independent documentary review of H2 (#3041)

Reviewer: Codex T. Exact author head: bec0f5da384042b423b4997c3e8fc59f7c38f895.
Author document: docs/reviews/m-lot01-h2-triage.md, blobfe9ac66223bfc0d332ded5e644a39bcc9c9880d3,131lines.
Nominal request6701251877; claim6701512737 and channel reservationfeaf8adff9264c3edc46ce04ac106e4e7217e1fd preceded new diff/source/report work.

## Disposition

COMMENT: no demonstrated high/medium documentary finding; one LOW wording ambiguity. This is a proposed, partial contract without a media implementation. The LOW is not a runtime exploit, production privacy failure, financial loss or justification to edit author code.

## LOW: scope permission refusal to the selected device

Line67 says that refusing permission keeps both devices off. Line101 instead preserves the microphone's previous chosen state when camera permission is requested or refused. Example: a participant explicitly enabled the microphone, then requests camera permission and declines. The table permits audio to remain enabled; the unqualified earlier sentence suggests both devices must be off. Both statements are proposed requirements, so the conflict is documentary.

Suggested clarification: refusal keeps the requested device off and preserves the other device's explicitly chosen state; both stay off when neither was previously enabled. No new capture, quota, provider or financial rule is proposed. Please make that wording consistent in this SAME document and request a focused return on the published delta. Existing observations/proof should remain unchanged.

## Supporting boundaries checked

The complete131-line document and its single-file addition against main e814fe6d were read. Frozen90eca6cb RoomEmbed66-121 really starts joined=false and mounts a third-party iframe only after Join, with camera/microphone delegation. This does not establish separate in-room device controls, no permission request after Join, remote media shutdown, hand raising or recording privacy. The document qualifies this correctly rather than calling iframe entry a completed guarantee.

call-rooms47-61/98-116 constructs or retrieves external meeting links. community-events537-553/628-638 stores replay links and controls link admission; neither demonstrates native recording or control of a third-party session already opened. live-box-rules1-18 is visitor-statistics polling, not hosted media. stream25-44/75-84/116-128 concerns uploaded recorded lessons and token configuration, not live ingest or offline licenses. meet-providers746-756 sets a partial group microphone option, not a general device guarantee. These are source observations only, not executed behavior.

Frozen queue H2 and X6 excerpts preserve document-only work, unknown total funding and X6's reactivated end-of-queue position without implementation authorization. All five scenario tables and11 cost units remain proposed/unknown; remote termination and cleanup must be confirmed before a future reserve can be released. No historical free-service comment is treated as zero cost. No provider account/policy/price/capacity was tested or approved.

## Method and limits

Serial bounded documentary review. The paired reviews inspect12 cited local source paths plus author documents and Git identities/diffs, without runtime, browser/device, Redis, supplier, SDK, external contact, account or dependency action. No broad search or global absence certification. Historical live-quiz/PR inventories and every unselected cited file were not replayed; the absence/ownership conclusions remain pinned/limited. The separate H1 policy spot checks do not certify an H2 provider or legal compliance.

Targeted report personal-data scan and whitespace checks only. No runtime RED/GREEN, types/lint/build, hosted CI, margin, accessibility conformity or deployment claim. Customer steps/decisions0to0. No author source/ref/CI or foreign merge changed. Author owns the later correction and final merge gates.
