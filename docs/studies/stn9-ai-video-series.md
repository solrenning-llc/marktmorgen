# STN9 (item 762): AI video and series as a product — DRAFT, incomplete

Status: **draft handoff, not a finished study.** Started by Claude 1 cloud V on November 15, 2026; handed to Claude 2 on the coordinator's order (C2-209, 15/11/2026 00h25 Fortaleza). Nothing here is built, priced for sale, published or available to a customer. No account was created, no term accepted, no paid call made. Every fact below was read on **2026-11-15** from the official page named next to it, by `curl` through the session proxy; nothing is from memory.

Rules that bind the rest of the work (item 762 text): MR (positive net per unit at 100% use, worst month, monthly and annual), LC for any profit shown to the owner, unknown cost fails and is never zero, no free quota counted as zero, automatic ceiling and reserve before every spend, AX274 (captions, audio description and transcript as conditions of any future build), no change to prices, limits, commission, PLANS_ON_SALE, OPENING_REQUESTED, tax gate, art. 9a, commercial review or stripePlatformEligibilityReady. Jus IA guidance of 09/11/2026 (reported by the coordinator): no phases 2–4, no public upload without a child-abuse procedure, Terms/Privacy/credits reviewed before selling.

Duplicate check (15/11/2026): no open or merged PR or branch with STN9 besides this one; no video or voice generation provider in `lib/`, `app/` or `components/` (grep for veo, sora, runway, kling, luma, elevenlabs: only an unrelated word list hit).

## 1. Vendors read so far

### Google — Veo and Gemini Omni on Google Cloud ("Gemini Enterprise Agent Platform", formerly Vertex AI)

Source: https://cloud.google.com/vertex-ai/generative-ai/pricing (page title now "Agent Platform Pricing"), read 2026-11-15. Prices in USD "/ 1 count". **The page does not define "count"**; that Veo bills per second of output must still be confirmed on an official page before any cost figure is used (open point).

| Model | Video + audio | Video only |
| --- | --- | --- |
| Veo 3.1 | 720p/1080p $0.40; 4K $0.60 | 720p/1080p $0.20; 4K $0.40 |
| Veo 3.1 Fast | 720p $0.10; 1080p $0.12; 4K $0.30 | 720p $0.08; 1080p $0.10; 4K $0.25 |
| Veo 3.1 Lite | 720p $0.05; 1080p $0.08 | 720p $0.03; 1080p $0.05 |
| Veo 3 | 720p/1080p $0.40 | 720p/1080p $0.20 |
| Veo 3 Fast | 720p $0.10; 1080p $0.12 | 720p $0.08; 1080p $0.10 |
| Veo 2 | — | 720p $0.50 |

Gemini Omni (same page): Gemini Omni 1.2 Flash video output $12.00 per 1M tokens (Omni Flash / 1.1 Flash $17.50); "1931 tokens per second of 360p video, 5792 tokens per second of 720p video, 8688 tokens per second of 1080p video, and 17376 tokens per second of 4k video for video outputs (with audio)"; input $1.50 per 1M tokens, "up to 5792 tokens per video second for inputs". Arithmetic only (not a quote): 720p ≈ $0.0695 per output second before input tokens.

Veo 3.1 model card, https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate ("Last updated 2026-11-12 UTC"): "Video lengths: 4, 6, or 8 seconds; reference image to video only supports 8 seconds"; "Supported aspect ratios: 9:16, 16:9"; output "720p, 1080p, 4K"; "24 FPS"; "Extend videos Supported"; "Content Credentials (C2PA) Supported"; "Prompt languages: English"; "Model availability: United States: us-central1"; "Pay-as-you-go Not supported", "Fixed quota Supported", "Provisioned Throughput Supported" (how a small account would buy it is an open point); veo-3.1-generate-001 "Launch stage: GA". Gemini Omni 1.2 Flash, overview page (same date): "videos from 3 to 15 seconds in length at 360p, 720p, 1080p, or 4K".

Safety, https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/responsible-ai-and-usage-guidelines (2026-11-12): Child category "Rejects requests to generate content depicting children if personGeneration isn't set to "allow_all" or if the project isn't on the allowlist for this feature"; Celebrity "Rejects requests to generate a photorealistic representation of a prominent person"; Prohibited content "related to child safety". SynthID is not mentioned on the pages read (open point).

Terms, https://cloud.google.com/terms/service-terms ("Last modified November 11, 2026"), section 20:
- Output: "Generated Output is Customer Data. As between Customer and Google, Google does not assert any ownership rights in any new intellectual property created in the Generated Output."
- **20(d) Age Restrictions: "Customer will not, and will not allow End Users to, use a Generative AI Service as part of a website, Customer Application, or other online service that is directed towards or is likely to be accessed by individuals under the age of 18."** Marktmorgen Terms (`app/terms/page.tsx:61`) require users to be 18 or older; buyers who watch a series are a separate question for the design (generation only inside the creator studio; open point for the legal reading).
- 20(h): Google "will not store outside Customer's Account" prompts "for longer than is reasonably necessary to create the Generated Output, or (ii) the Generated Output."
- 20(i): Google indemnity covers "unmodified Generated Output" against third-party IP claims, except when the customer "knew or should have known was likely infringing" or disabled Google's safety tools, among other exclusions.
- Training, https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention (2026-11-12): "Google won't use your data to train or fine-tune any AI/ML models without your prior permission or instruction"; prompts may be logged for abuse monitoring under GCP Terms section 4.3.

Not yet read: the Gemini API (AI Studio) pricing and terms, which moved to aistudio.google.com (host not allowed); the Prohibited Use Policy page (downloaded only a 4 KB shell).

### OpenAI — Sora: **no longer available**

https://developers.openai.com/api/docs/models/sora-2.md: "Status: Shut down. The Sora 2 models and Videos API were shut down on September 24, 2026 and are no longer available. There is no one-to-one replacement API." Deprecations table, https://developers.openai.com/api/docs/deprecations.md: sora-2, sora-2-pro and their snapshots, shutdown "Sep 24, 2026", notice "Mar 24, 2026". Sora is out of the study.

### Runway — developer API (also resells other vendors' models)

https://docs.dev.runwayml.com/guides/pricing/: "Credits can be purchased for $0.01 per credit in the developer portal for a project" (prepaid, which is a natural hard ceiling). Credits per second, selected: gen4.5 12; gen4_turbo 5; aleph2 28 (56 minimum); act_two 5; veo3.1 audio 40 / no audio 20; veo3.1_fast audio 15 / no audio 10; kling2.5_turbo_pro 12; kling3.0_standard 9 (no audio) / 13 (audio); kling3.0_pro 12 / 17; kling_4 720p 15.7 list (12.56 with 20% off "through November 30, 2026 UTC"); gemini_omni_flash_1.2 720p 7; seedance2 720p 30; wan3 720p 10; hailuo3 768P 10. Voice on Runway: eleven_multilingual_v2 and eleven_v3 "1 credit per 50 characters"; eleven_voice_dubbing "1 credit per 2s of audio". Runway's terms and usage policy moved to runway.com (host not allowed): ownership, likeness, watermark and retention **not read**.

### Luma — Ray3.2 API

https://lumalabs.ai/api/pricing: Ray3.2, credits per clip: T2V/I2V 5 s = 20 (360p), 50 (540p), 100 (720p), 400 (1080p); 10 s = 60/150/300/1,200; "HDR output is 2× SDR pricing". **USD per credit not on the page**: unknown, so Luma fails the cost test for now. Terms, https://lumalabs.ai/legal/terms-of-service ("Last updated: May 14, 2026"): "Customer owns and retains all right, title, and interest in and to the Output"; but during paid use the customer grants Luma a perpetual license to Output to "create, test, improve, train, or otherwise develop" its models — creators' series would feed Luma's training.

### ElevenLabs — voice

https://elevenlabs.io/pricing/api: text to speech per 1,000 characters: v4 $0.08, v4 Turbo $0.04, v3 $0.08, v2 Multilingual $0.08, Flash/Turbo $0.04 (page equates 1K characters to "~1 min"; cost caps must count characters, not minutes); Dubbing v1 $0.33 per minute; Sound Effects $0.12 per minute; Music $0.15 per minute ("Commercial use licensing on Starter+ plans"). "Prices exclude all taxes".

Terms, https://elevenlabs.io/terms-of-use ("Last Updated: 09 October 2026"): free users "may only use the Services for non-commercial purposes"; paid users "may use the Services for commercial purposes"; content may be used for training unless the account opts out ("you may opt out of our use of your Content for training at any time"). Prohibited Use Policy, https://elevenlabs.io/use-policy (09 October 2026): no voice recordings "of anyone under 18 to create or train a voice model"; no "Cloning, synthesizing, or impersonating the voice, identity, or likeness of any living individual without their explicit and informed consent"; "You must not remove, alter, or conceal ElevenLabs watermarks, metadata or other provenance signals"; account holders must be 18+. Professional Voice Cloning, https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/professional-voice-cloning: "You can only create a Professional Voice Clone of your own voice. Even with their consent, you cannot clone someone else's voice. All Professional Voice Clones require a verification process". Zero Retention Mode, https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode: "Enterprise customers can use Zero Retention Mode"; by default ElevenLabs "retains data, in accordance with the Privacy Policy".

### Not read (host not reachable): Kling direct API (moved to kling.ai), Pika (pika.art), MiniMax (platform.minimax.io). Kling and Hailuo prices are available through Runway above.

## 2. Law and platform rules read so far

- EU AI Act art. 50, Commission page https://digital-strategy.ec.europa.eu/en/policies/guidelines-transparency-ai-generated-content ("Last update 6 August 2026"): "Article 50 of the AI Act applies from 2 August 2026." Providers must "Add machine-readable marks to enable the detection of AI-generated or manipulated content"; deployers must inform people exposed to "Deepfakes". Code of Practice, https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content ("Last update 19 October 2026"): final code covers art. 50(2), (4) and (5); "adherence to the code is voluntary, the transparency requirements under article 50 of the AI Act are legal obligations"; the EU published icons deployers may use; about 190 signatories by end of July 2026. The regulation text itself (EUR-Lex) answered HTTP 202 (bot challenge) and was **not read**; the guidelines PDF (ec.europa.eu/newsroom/dae/redirection/document/...) not yet read.
- Downloaded but not yet analyzed: NCMEC CyberTipline (https://www.missingkids.org/gethelpnow/cybertipline) and CSAM issue page; US Copyright Office AI page (https://www.copyright.gov/ai/); YouTube altered/synthetic content help (support.google.com/youtube/answer/14328491); TikTok AI-generated content FAQ.
- Blocked by bot protection (HTTP 403/404/202): uscode.house.gov (18 U.S.C. §§2258A, 1466A, 2256), congress.gov (TAKE IT DOWN Act, NO FAKES Act), planalto.gov.br (ECA, Código Civil, LGPD — redirected to gov.br), ecfr.gov (16 CFR 465), leginfo.legislature.ca.gov (Civ. Code 3344.1), transparency.meta.com (400). Alternatives allowed but not tried: www.law.cornell.edu, www.govinfo.gov.

## 3–6. Still to do

3. Worst case per plan with credits, ceiling before each spend and reserve, with `lib/receiving-costs.ts` (fee max(Stripe 6.6% + 30¢, Paddle 5% + 50¢) on price + 27% buyer tax on top; remittance 1.5%; refund 1%; dispute ($30 + charged) × 1%) and LC taxes (IRPF 15% on profit, IOF 0.38% on what is remitted), positive net per unit with the spend-floor room (`COMMERCIAL_SPEND_FLOOR_ROOM_CENTS` month 25¢ / year 100¢ in `lib/commercial-margin.ts`). Not started; no figure is claimed. Likely shape to test: a prepaid credit add-on priced on its own (as the Store assistant add-on), not taken from current plan margins.
4. Design of the three uses (sales video from a product page; "Series" product with episodes; first episode as a lead magnet), with AX274 conditions (captions, transcript, audio description).
5. Risks and how to do better than Melolo and Photo AI. Melolo/Photo AI facts **not read yet** (apps.apple.com, play.google.com, trustpilot.com, photoai.com are allowed in the research environment but were only tried via WebFetch, which failed).
6. Final one-page decision in Portuguese for the owner.

## Accessibility

No interface was created or changed: 0 → 0 steps and decisions. AX274 conditions recorded for any future build: captions, full transcript and extended audio description for every generated video. No automated or human accessibility test ran.
