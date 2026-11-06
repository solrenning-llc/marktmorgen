# Lot 01: E3, E5 and E6 dependency audit

Frozen main 87d9e6a1c4bf98f89ac7969e8e4093e8d1134231; November 6, 2026. Read-only audit, no runtime changes, provider requests or credentials. No tests executed during this inspection. Audit reservation 498e331454ea8f65a19fb24ffdb4aca969e0a572.

## E3 / 20 — shared with HL8 / 227

Queue:2375–2379 asks for an AI-proposed automation from a creator objective, reviewed before activation. HL8:5914–5917 describes the same scope: existing blocks only, step explanations, explicit confirmation and prior bounded AI reserve. Treat these as one item.

Existing writeSequence accepts a selected trigger and produces email steps (ai.ts:1101–1130), using counted (:1123), bounded ask (:1144) and readDraftedSteps (:1146). The API chooses its trigger and public product facts (app/api/store/ai/route.ts:296–327). The manual workflow engine checks steps/routes/placeholders/goals and saves new flows paused (flows.ts:262–268/:313–329/:338–361). None establishes objective-to-workflow drafting.

Possible first unit, after canonical ownership check: an inert pure structured proposal validator restricted to existing blocks and supplied known references, returning a reviewable inactive proposal. No provider call, endpoint, persistence or activation. saveFlow is not pure; it must not be called in such a unit. Existing counted is an integration point, not proof that larger prompts/outputs are funded. E2/E7 pure units were selected first; E3 runtime is not implemented by this audit.

## E5 / 22 — existing model, unresolved runtime prerequisites

Queue:2409–2414 records the design/model/money-reader work. currency-prices.ts:99–117/:129–163 already validates creator-set currencies and constructs options; its note (:155) says they are not sent anywhere. Checkout still sets store language and inline price_data in store currency (store-checkout.ts:341/:345–347/:431–433).

The design requires editor and Checkout together after the model/readers; a standalone editor must not imply Checkout support (buyer-currency-and-language.md:60–65). Browser-language selection depends on multilingual stores/SZ5 (queue:21964–21965). Two connected-account test-mode questions remain unresolved (design:38): manual localization with Adaptive Pricing off, and localization on direct charges. No test keys or real provider calls were used. A created Price and cache operations need prior explicit cost budgeting (design:70–72).

No safe runtime/editor unit is approved here. Duplicating the existing pure model would not advance the item. Historical Stripe research is not newly verified provider behavior.

## E6 / 23 — phone present, checkbox belongs to TB13

Queue:2417–2422 maps existing phone to TB15 and checkbox remainder to TB13. Phone is a supported type (checkout-fields.ts:31–38), uses native collection without custom-field slots (:142–146), and is read into the answer snapshot (:191–194). checkout-phone.test.ts:17–48 covers parsing, deduplication, required state, native collection, positions and round-trip; inspected, not rerun.

Checkbox is absent from FIELD_TYPES. Canonical TB13 requires explicit labels/state/validation, separation from marketing consent, no pre-opt-in or hidden payment, and receipt/snapshot/DSAR preservation (queue:11136–11138); TB15:11152–11154 already documents phone. Do not open duplicate phone or checkbox work under a new E6 scope.

A later pure checkbox schema proof needs coordination with TB13's owner and transport/snapshot/privacy design first. No unsupported field type is sent to Stripe and no consent, checkout, terms or price is changed here.
