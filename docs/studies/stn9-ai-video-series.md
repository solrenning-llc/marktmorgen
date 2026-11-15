# STN9 (item 762): AI video and series as a product — DRAFT, incomplete

Status: **study in progress; sections 1–2 from Claude 1 cloud V, sections 3–6 by Claude 2 (continuing Claude 1 cloud V) on 15/11/2026; five cost points still open, so the decision is "not yet".** Started by Claude 1 cloud V on November 15, 2026; handed to Claude 2 on the coordinator's order (C2-209, 15/11/2026 00h25 Fortaleza). Nothing here is built, priced for sale, published or available to a customer. No account was created, no term accepted, no paid call made. Every fact below was read on **2026-11-15** from the official page named next to it, by `curl` through the session proxy; nothing is from memory.

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

### 2a. Law research subagent report (arrived after the handoff, 15/11/2026)

Read by a research subagent with WebFetch on 2026-11-15; **not re-read by Claude 1 cloud V**. Claude 2 should confirm each quote before relying on it. Only items marked READ came from the page itself; everything else came from search summaries and is **NOT CONFIRMED (official)**.

READ (European Commission AI Act Service Desk, consolidated text "as at 27 July 2026", with Digital Omnibus changes marked):
- Art. 50(2), https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-50: outputs "are marked in a machine-readable format and detectable as artificially generated or manipulated". Art. 50(4): for "evidently artistic, creative, satirical, fictional or analogous" works, obligations "are limited to disclosure of the existence of such generated or manipulated content". Art. 50(5): "at the latest at the time of the first interaction or exposure".
- Art. 113 (…/article-113): "It shall apply from 2 August 2026"; the new art. 5 prohibitions "shall apply from 2 December 2026".
- Art. 111(4), new (…/article-111): systems "placed on the market before 2 August 2026" have until "2 December 2026" for art. 50(2). A feature launched now gets no such delay.
- Art. 5, new (b a)/(b b) (…/article-5), from 2 December 2026: no systems that generate intimate or sexual images of an identifiable person "without that person's freely-given, specific, informed, unambiguous and explicit consent", and none for CSAM; art. 5(1a)(a) reaches the provider when the result is "a reasonably foreseeable and reproducible outcome" without adequate safeguards.
- Art. 99(4) (…/article-99): up to "EUR 15 000 000" or 3% of worldwide annual turnover; point (g) covers art. 50.
- Art. 3(3)/(4) (…/article-3): provider and deployer definitions. Art. 25 is about high-risk systems only.
- Commission guidelines C(2026) 5054 final, 20/7/2026, https://ai-act-service-desk.ec.europa.eu/sites/default/files/2026-07/guidelines_on_the_implementation_of_the_transparency_obligations_for_certain_ai_systems_under_article_50_of_the_ai_act_bzptwqhk0ikg1dtlddap41psfy_131215.pdf: §11, whoever offers a generator "under its own name or trademark… is a provider responsible for compliance with the transparency obligations in Article 50(1) and/or (2)"; §10, non-EU providers are covered when output is used in the EU; §16, pure hosts "are not deployers" but are "strongly encouraged to preserve the marking"; §12–13, a non-EU deployer is reached "including by posting deep fakes on the globally accessible internet"; §122, content "exclusively informative or commercial" is outside the creative exception, with a teleshopping-style video with synthetic humans "with the aim of persuading viewers to buy the product" as an example.
- FAQ, https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act ("Last update: 24 July 2026"): "Article 50 of the AI Act applies as from 2 August 2026"; Omnibus "entered into force on 27 July 2026" (https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai).
- Reading for this study (deduction, not a legal opinion): Marktmorgen would be the provider (machine-readable marking from launch); the creator the deployer (visible notice at first exposure); a sales video gets no creative exception.

NOT CONFIRMED (official), to read on the official page: Omnibus act number (search: Regulation (EU) 2026/1744); YouTube, TikTok and Meta rules; Tennessee ELVIS Act; California Labor Code §927 and Civil Code §§3344, 3344.1; New York GOB §5-302; NO FAKES Act (search: introduced 9/4/2025, not law); TAKE IT DOWN Act (search: FTC enforcement since 19/5/2026, 48-hour removal, includes AI "digital forgeries"; https://www.ftc.gov/business-guidance/resources/complying-take-it-down-act); Brazil CF art. 5 X, Código Civil art. 20, LGPD arts. 5 II and 11; GDPR art. 9; Copyright Office Part 2 (29/1/2025) and Thaler v. Perlmutter (D.C. Cir. 18/3/2025); Lei 9.610/98 art. 11; 18 U.S.C. §2258A(h) (search: REPORT Act, Pub. L. 118-59, preservation 1 year), §§2258B, 1466A, 2256(8)(B); NCMEC ESP registration and hash sharing (search: https://www.missingkids.org/cybertiplinedata); **Brazil Lei 15.487/2026 rewrote ECA arts. 241-B and 241-C, art. 241-C citing "inteligência artificial" (search only; do not use the old wording)**; **EU Reg. 2021/1232 expired 3/4/2026 per a Council document of 30/6/2026 (search only)**; 16 CFR Part 465 (in force 21/10/2024) and Part 255.

## 3. Worst case per plan: a prepaid video credit, priced on its own (Claude 2, continuing Claude 1 cloud V, 15/11/2026)

**Shape.** Video generation cannot ride inside the current plans: every plan's margin is already sized without it, and a creator could spend any amount. The only shape that keeps MR is a **prepaid credit pack sold on its own**, like the Store assistant add-on: the creator pays first, each generation reserves its worst cost from the pack before the provider is called, and an empty pack stops generation (the no-AI path stays). Nothing from a plan subsidizes it, and commission counts as zero.

**Method.** `receivingOf` from `lib/receiving-costs.ts` at `MOST_CORRECT_READING`: the dearer provider fee on the price plus the buyer's tax on top at 27%, remittance 1.5%, refund reserve 1%, dispute reserve. Then the LC taxes: IRPF 15% on the profit and IOF 0.38% on what is remitted, both rounded up. The pack must keep at least 1¢ net plus the add-on room `ADD_ON_ROOM_CENTS` (25¢, `lib/store-assistant-rules.ts`). The table gives the **most the provider may cost** for each pack price, and how many seconds of output that buys at each candidate rate. The calculation ran on this branch's tree on 15/11/2026, in a throwaway script that was not committed.

| Pack price | Revenue | Fees and reserves | Most provider cost | Net at that cost (after IRPF and IOF) |
| --- | --- | --- | --- | --- |
| $19 | $19.00 | $2.95 | $15.73 | $0.26 |
| $29 | $29.00 | $4.15 | $24.53 | $0.26 |
| $49 | $49.00 | $6.60 | $42.08 | $0.26 |
| $99 | $99.00 | $12.66 | $86.02 | $0.26 |

Seconds of output that the most provider cost buys (rounded down):

| Rate (source, read 15/11/2026) | $19 | $29 | $49 | $99 |
| --- | --- | --- | --- | --- |
| Runway `veo3.1` with audio, 40 credits/s = $0.40/s | 39 | 61 | 105 | 215 |
| Runway `veo3.1_fast` with audio, 15 credits/s = $0.15/s | 104 | 163 | 280 | 573 |
| Runway `gemini_omni_flash_1.2` 720p, 7 credits/s = $0.07/s | 224 | 350 | 601 | 1,228 |
| Google Veo 3.1 Fast 1080p with audio, $0.12 per "count" | 131 | 204 | 350 | 716 |
| Google Veo 3.1 Lite 1080p with audio, $0.08 per "count" | 196 | 306 | 526 | 1,075 |

These are break-even ceilings, not proposed prices. They are the line the code may never cross. Pricing for profit (the owner's rule: the price that maximizes profit) gives fewer seconds per pack, and that choice is the owner's.

**Costs that still have no bound, so the pack fails today:**
1. **Google's unit.** The pricing page bills "per count" without saying what a count is; the Google rows hold only if a count is one second of output. Not confirmed.
2. **Failed or refused generations.** Neither Runway's nor Google's page read says whether a blocked or failed generation is billed. Until an official page says it, every attempt is reserved and charged to the pack in full, whatever comes back.
3. **The accessibility the build needs (AX274).** A generated video would need captions, a transcript and extended audio description before it can be published.
   - **Captions and transcript:** the existing AI captions add-on is sold at $6 a minute a language (`lib/plan.ts`), a separate purchase. Inside the pack, the cost per output second must be added from the captions supplier's own rate.
   - **Audio description:** a written description of what is on screen, read by a voice. The voice part is about 900 characters a minute at ElevenLabs v3, $0.08 per 1,000 characters, which is about $0.072 a minute. The text part (a model describing each scene) has no bound yet.
4. **Hosting.** A generated video is stored and streamed like any other product video, so it must count against the plan's existing storage and video-hour limits; the build may not add a new hosting cost. This needs a test before any build.
5. **Google's Veo has no pay-as-you-go option** ("Pay-as-you-go Not supported"; fixed quota or provisioned throughput only). Buying a fixed quota is a fixed cost that belongs to FX275 and the minimum customer base, and its price was not read. Runway is prepaid at $0.01 a credit, so it is the only path read that has a natural hard ceiling.

## 4. Design of the three uses (study only; nothing is built)

All three are generated **only inside the creator's studio**, by the creator, for their own store, from a prepaid pack, with a ceiling reserved before every call. Every generated video carries:
- the provider's machine-readable marking, which must be kept, never stripped (C2PA on Veo; AI Act art. 50(2) as Marktmorgen is the provider of the generator);
- a visible "Made with AI" label, drawn by the page and not by the model, shown from the first frame (art. 50(5); the creator is the deployer);
- captions, a transcript and audio description before it can be published (AX274). Publishing stays disabled while any of the three is missing.

1. **Sales video from the product page.** The input is the product's own published title, description and pictures, never a person's face or voice. The script is held to the product's published facts, like the Store assistant's `heldToFacts`: no figures, deals, urgency or testimonials the creator did not publish. No synthetic person speaks as a real one. The Commission's guidelines (§122) put a sales video outside the creative exception, so it gets the full deepfake notice.
2. **"Series" product.** This is a product type whose episodes are videos the creator uploads or generates, released on a schedule. It reuses the existing course and drip mechanisms (lessons as episodes), not a new player. Buyers watch; they never generate. That keeps generation away from buyers who may be under 18 (Google's terms, 20(d)).
3. **First episode as a lead magnet.** The first episode is free behind the existing email sign-up with consent, and the rest are paid. It uses the existing lead-magnet flow; generation cost is the creator's pack, never a free quota.

Steps and decisions for the creator (target): pick the product, then "Make a video", then review the script, then generate, then review captions, transcript and description, then publish. That is 5 steps, with 2 decisions (the script and the final review).

## 5. Risks, and how to do better than Melolo and Photo AI

Melolo (vertical AI drama series) and Photo AI were **not read**: their pages were not reachable from this session (see the "Sources" note below). No claim about them is made here.

| Risk | Where it comes from | What the design does |
| --- | --- | --- |
| Child safety | Generated images of minors; creators are adults, buyers may not be | No people generation by default (Google's `personGeneration`), no upload of a real person's face, provider safety filters kept on. A reporting path to NCMEC must exist before any public generation, the Jus IA condition of 09/11/2026. The law texts (18 U.S.C. §2258A and the others) are still to read. |
| A real person's face or voice without consent | ElevenLabs' policy, AI Act art. 5 (from 02/12/2026), TAKE IT DOWN Act (not confirmed) | Voice only from the provider's stock voices or the creator's own verified clone (ElevenLabs Professional Voice Cloning is own voice only). No likeness of a real person. |
| Copyright in the output | Copyright Office (not yet read), Lei 9.610/98 | Tell creators plainly that AI output may not be protected by copyright. Google indemnifies unmodified output; Runway's terms were not read. |
| Provider trains on creators' content | Luma trains on output even on paid plans; ElevenLabs unless the account opts out | Luma excluded. ElevenLabs only with opt-out, which zero retention requires (Enterprise). Google does not train without permission. |
| Provider disappears | Sora 2 shut down on 24/09/2026 with six months' notice | Stored output is the creator's file in our storage, never a link to the provider. One provider behind one interface, so a switch changes no page. |
| Unbounded spend | Retries and failures not stated | Prepaid pack, reservation before each call, every attempt charged in full until a page says otherwise. |
| Buyers under 18 | Google's terms, 20(d) | Generation only in the studio (18+). Whether a series watched by buyers counts as a service "likely to be accessed" by minors is an open legal question for the owner. |

## 6. Para o dono: a decisão (uma página, em português)

**O que é.** Vender vídeo por IA como pacote pré-pago, separado dos planos: o criador compra créditos, cada vídeo reserva o custo antes de chamar o fornecedor, e com o pacote vazio a geração para.

**Número (pior caso, regra LC, IRPF 15% e IOF 0,38%).** O fornecedor pode custar no máximo isto, por pacote, sem prejuízo:

| Pacote | Custo máximo do fornecedor |
| --- | --- |
| US$19 | US$15,73 |
| US$29 | US$24,53 |
| US$49 | US$42,08 |
| US$99 | US$86,02 |

Exemplo com um modelo de qualidade média e preço confirmado por segundo (Runway veo3.1_fast com áudio): o pacote de US$49 dá no máximo 280 segundos (4 min 40 s) de vídeo. Isso é o limite de não ter prejuízo, não o preço que maximiza o lucro.

**Por que ainda reprova (custo desconhecido nunca é zero):**
1. O Google não diz na página de preços que a cobrança é por segundo.
2. Nenhum fornecedor diz se tentativa recusada ou falha é cobrada.
3. Falta o custo da audiodescrição (o texto da descrição) e das legendas por segundo, exigidos pela acessibilidade.
4. O Veo do Google não tem pagamento por uso: exige cota fixa, com preço não lido (custo fixo).
5. Os termos do Runway, do Kling, do Pika e do MiniMax não foram lidos, e as leis dos EUA e do Brasil sobre abuso infantil e uso de imagem ainda estão sem o texto oficial.

**O que precisa do senhor:**
- **(a)** Decidir se quer continuar o estudo até fechar os 5 pontos acima. Já existe o ambiente "Marktmorgen research", com os 20 sites oficiais liberados, para uma sessão que comece nele.
- **(b)** Se quiser, decidir o formato: só no estúdio, pacote pré-pago, sem rosto ou voz de pessoa real.

**Sem o seu "sim", nada é construído.**

## Sources this session could not reach (15/11/2026)

This session's network policy refused every host outside its list (proxy answered 403). A personal environment "Marktmorgen research" was created with the 20 official hosts the remaining reads need (Google Cloud and AI Studio pricing and policies, Cornell LII, govinfo, FTC, the AI Act Service Desk, EUR-Lex, Runway, Luma, ElevenLabs, Photo AI, the App Store, Google Play, NCMEC, the Copyright Office and the Planalto). A session started on it can finish the open reads; this one could not move to it.

## Accessibility

No interface was created or changed: 0 → 0 steps and decisions. AX274 conditions recorded for any future build: captions, full transcript and extended audio description for every generated video. No automated or human accessibility test ran.
