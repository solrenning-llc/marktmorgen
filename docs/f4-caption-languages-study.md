# AI caption languages and AI dubbing — provider study, 9 November 2026 (queue item 35 [F4])

> **Internal study. Not for public use.** Nothing here may be shown on a page, in an
> email or in the studio as a language Marktmorgen offers. A language reaches the
> creator only when `lib/captions.ts` lists it, with a test, in a merged and published
> change (VR item 1). No price, limit, commission, flag or gate is changed by this file.

State (VR item 1): **document only**. No product change, no customer-facing change.

## Result in one paragraph

Bunny Stream's official documentation, read on 9 November 2026, lists **56 languages**
for AI transcription and caption translation. Marktmorgen's `CAPTION_LANGUAGES`
(`lib/captions.ts`, origin/main `0e8b8c6b53`) lists **28**. All 28 are in Bunny's
list, with the same ISO 639-1 codes. Bunny lists **28 more** that Marktmorgen does not
offer (table below). Bunny's price is unchanged from the figure in
`lib/auto-captions-rules.ts`: **$0.10 per language per minute** of video. Bunny's
documentation describes **no AI dubbing** (no synthetic voice, no generated audio
track); it only plays audio tracks that are already in the uploaded file.

## Sources read (9 November 2026, from this environment, HTTP 200)

| Page | URL | What it says |
| --- | --- | --- |
| Transcribing | https://bunny.net/docs/stream/transcribing (also served at https://docs.bunny.net/docs/stream-transcribing, which redirects there) | Automatic transcription; "Automatically translate your generated subtitles and captions into 56 languages"; the numbered table of 56 languages with ISO 639-1 codes; language detection from the first 30 seconds of audio. Page footer: "Last modified on October 20, 2026". |
| Pricing | https://bunny.net/docs/stream/pricing | "Transcribing is charged per language x per minute of video"; "$0.10 per language minute"; worked example 10 min × 2 languages = $2.00. Accounts also have a $1 minimum monthly usage. |
| Transcribe video (API) | https://bunny.net/docs/api-reference/stream/manage-videos/transcribe-video | `POST /library/{libraryId}/videos/{videoId}/transcribe`, body `sourceLanguage` and `targetLanguages` (ISO 639-1). `force=true` "re-queues (and re-bills) transcription". OpenAPI version 1.6.21. |
| Smart Generate | https://bunny.net/docs/stream/smart-generate | Titles, descriptions, chapters and moments from the caption track; no extra charge beyond transcribing; "Transcribing is powered by Whisper". |
| Multi-audio | https://bunny.net/docs/stream/multi-audio | Plays several audio tracks only when "your original file already contains multiple audio streams" ("different languages or dubbing options"). No generation. |
| Documentation index | https://bunny.net/docs/llms.txt | Full index of Bunny's documentation (872 lines). The word "dub" appears nowhere in it. |

The marketing pricing page https://bunny.net/pricing/stream/ also loaded (HTTP 200), but
the HTML as fetched holds no transcription price or language count (it may be drawn by a
script; not confirmed); the documentation pricing page above is the source used.

## The 28 languages Marktmorgen offers today

`en es pt fr de it nl pl sv da no fi cs ro hu el tr uk ru ar he hi id vi th ja ko zh`
(`CAPTION_LANGUAGES`, `lib/captions.ts`). Every one of these codes is in Bunny's table.
None of Marktmorgen's codes is missing from Bunny's list.

## The 28 languages Bunny lists that Marktmorgen does not offer

Source for every row: Bunny "Transcribing", table "Supported languages and ISO 639-1
language codes", read 9 November 2026.

| # in Bunny's table | Language | ISO 639-1 |
| --- | --- | --- |
| 2 | Armenian | hy |
| 3 | Azerbaijani | az |
| 4 | Belarusian | be |
| 5 | Bosnian | bs |
| 6 | Bulgarian | bg |
| 7 | Catalan | ca |
| 9 | Croatian | hr |
| 14 | Estonian | et |
| 17 | Galician | gl |
| 23 | Icelandic | is |
| 27 | Kannada | kn |
| 28 | Kazakh | kk |
| 30 | Latvian | lv |
| 31 | Lithuanian | lt |
| 32 | Macedonian | mk |
| 33 | Malay | ms |
| 34 | Maori | mi |
| 35 | Marathi | mr |
| 36 | Nepali | ne |
| 38 | Persian | fa |
| 43 | Serbian | sr |
| 44 | Slovak | sk |
| 45 | Slovenian | sl |
| 47 | Swahili | sw |
| 49 | Tagalog | tl |
| 50 | Tamil | ta |
| 54 | Urdu | ur |
| 56 | Welsh | cy |

## Price compared with Marktmorgen's

| | Bunny (provider cost) | Marktmorgen (what the creator pays) |
| --- | --- | --- |
| Per minute, per language | $0.10 (docs pricing page, 9 Nov 2026) | $6.00 (`CENTS_PER_MINUTE = 600`) |
| Minimum | none per request; $1 minimum monthly usage per account | $35.00 per request (`MIN_CENTS = 3_500`) |
| Languages per request | not limited in the docs | up to 3 (`MAX_AUTO_LANGUAGES`), up to 12 tracks per video (`MAX_CAPTION_TRACKS`) |
| Longest video | not stated in the pages read | 240 minutes (`MAX_AUTO_MINUTES`) |

The per-minute provider price did not change since the figure written in
`lib/auto-captions-rules.ts` (read 11 October 2026). The 28 extra languages are listed on
the same page and the pricing page states one rate per language with no exception, so the
documentation gives no reason to expect a different price for them. This study does not
recompute any margin; MR, TX and FX275 calculations stay with their own items.

## What could not be confirmed

- **Quality per language.** Bunny states that transcription uses Whisper. The pages read
  give no accuracy figure per language. Nothing here says that captions in any of the 28
  extra languages are good enough to sell; that needs a synthetic sample per language
  before any of them is offered.
- **Spoken language vs. translation target.** The table is titled for both transcription
  and translation. The pages do not say whether every one of the 56 works equally as the
  *spoken* (source) language and as a *translation* target. Not confirmed.
- **Whether the spoken language is billed as a separate language** when it is not in
  `targetLanguages`. Not stated. `lib/auto-captions-rules.ts` already prices the worst
  case (one more language billed) and this study does not change that.
- **The marketing pricing page's figure**: not present in the HTML as fetched, so not read.
- **Any account-specific price** (contract, partner pricing): not read; no account was
  opened or contacted.

## Observation on the current code (no change made)

`lib/auto-captions.ts` calls `.../transcribe?force=true`. Bunny's API page says `force=true`
re-bills transcription. Marktmorgen charges the creator before that call for each request
(`chargeNow`), so each billed run is paid; this is recorded only so that a future change
does not add a second call for the same paid request.

## AI dubbing — a money proposal for the owner, not a plan to build

Bunny Stream, as documented on 9 November 2026, **does not offer AI dubbing**. Its
multi-audio feature only plays audio tracks that already exist in the uploaded file.

What AI dubbing would need, before anything is built or any price is shown:

1. **A provider that generates translated speech**, chosen by the owner. No provider was
   read for this study, and no dubbing price is given here because no official source for
   one was read. Unknown cost is not zero (MR, "custo desconhecido reprova").
2. **An official, dated per-minute price per language** from that provider, its most
   expensive tier, and its terms on voice rights and on cloning a creator's voice (which
   would need the creator's explicit consent and must never be the default).
3. **A way to store and play the track**: Bunny's multi-audio plays extra audio streams
   that are in the uploaded file, so a dubbed track would need to be muxed into a new
   upload (new encoding and storage, both billed by Bunny per its pricing page) or played
   by another mechanism. Neither path is confirmed by the pages read.
4. **The same protections as AI captions**: price shown before the button, charged on the
   plan's card before the provider is called, a ceiling per request (minutes and
   languages), refund of what is not delivered, and a cost line in
   `tests/plan-cost-registry.ts` for every new call.
5. **Accessibility (AX274)**: a dubbed track is not a substitute for captions or a
   transcript; it is labeled as AI-generated in the player's audio menu, drawn by the code.
6. **The owner's price decision.** Until the owner approves a price, dubbing stays in
   "Depende do dono" and nothing is offered.

## Next step (not started)

If the owner wants the 28 extra languages: one unit adds them to `CAPTION_LANGUAGES` with a
test that every code is in the list recorded here, and a synthetic sample per language
before any is shown to a creator. No price change. `lib/auto-captions.ts` is in open pull
requests by other units and is not touched by that change.
