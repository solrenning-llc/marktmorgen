# P1: original checkout questions, local construction

This unit was reconstructed from the conversation after the workspace returned to an older copy. The previous local commits and bundles (including bd6c3c560, 11ca52d92 and 6684ec13) were unavailable in the restored Git database. This reconstruction starts from the published #1502 head aed32693; it is not claimed byte-identical to the missing commits. Previous complete-suite proofs do not approve this source. The original option-producer stack still requires recovery or reconstruction before publication.

## Schema capture

`captureCheckoutQuestions` captures only canonical original creator questions and their exact custom_fields/phone_number_collection projection. It reuses the existing readFields and applyCheckoutFields without changing them. Required/optional status, original labels, dropdown labels and stable provider values, positions and native phone collection must agree. Added, omitted, duplicate, silently normalized or changed questions refuse. Unrelated form fields are outside this projection; this helper is not complete payment or body proof.

The candidate is detached and deeply frozen. Later catalog edits cannot rewrite it. Descriptor-backed inputs are refused without invoking getters. The body and serialized candidate have explicit UTF-8 ceilings and use the existing schema limits. This is not proof or funding of the entire CPU/heap cost of inspecting arbitrary JavaScript objects; a trusted producer must also bound upstream decoding and catalog inputs.

## Original admission integrity

`captureOriginalCheckoutQuestions` joins the schema to a canonical original body and genuine existing preintent MAC in the distinct physical-questions-v1 domain. Owner, original connected account, nonce, digest, original reference and capture/expiry times must agree. A fingerprint of a forged token is insufficient, and recomputing a changed body's hash cannot change the original signed digest. The complete join, including original token and identity, must fit the caller's byte ceiling. A new construction after admission expiry refuses; this does not authorize removal of an already reserved pending source after expiry.

This is integrity construction only. It does not authenticate catalog ownership, product/freight/price/rights, a Stripe observation, paid answers, original accounting or a CAS winner. It performs local parsing and crypto without Redis/source reservation, new admission, provider calls, URL, payment, settlement or email. The candidate explicitly has admitted=false and permitsCheckout=false. Original admission tokens and owner data would need the existing protected-source privacy and erasure treatment before any future persistence; nothing persists them here.

No checkout, worker, route or live producer calls these helpers. A future physical-with-questions producer still needs trusted original product/shipping/rights capture, explicit same-review full-lifetime funding, the existing source/pool and fences, original-account paid answers, immutable reconciliation, deletion, uncertain-ACK handling and finite recovery. Costs remain unknown/rejected, never zero; actual policies remain null, flags false and lifecycle never_activated. The current checkout restriction for physical products with questions is unchanged. P1 remains partial.

## Reconstruction validation

Eight schema cases and seven admission-join cases reproduce the prior directed behavior against real existing encoding/admission/crypto modules and synthetic transport. They cover changed and removed schemas, required status, phone/numeric fields, dropdown changes, duplicates, UTF-8 bounds, mutation resistance, getters, token forgery, changed signed bodies, wrong owner/account/nonce, unknown time, expiry and full-candidate byte limits. No external account or funded producer is certified. Types, lint, scanner and reservation checks are recorded for this reconstructed source separately; no complete-suite or independent-review approval is claimed.

CX-20 still keeps the option-producer PR local until #1931 frees the download route. Neither the route nor #1502 is modified by this recovery.
