/**
 * Which words a person said yes to the creator's list with (GDPR art. 7(1):
 * the one who sends must be able to show what was agreed to, not only that
 * it was).
 *
 * Every own yes is kept on the contact with this version, where it was given
 * and when (lib/contacts.ts, upsertContact: consentVersion, consentFrom,
 * consentAt). The version stands for these words, in every language a store
 * speaks:
 *
 *   - lib/buyer-words: alsoEmails, alsoOtherEmails and alsoClicks (the boxes
 *     beside a checkout, a free copy and a waitlist);
 *   - lib/buyer-words/form.ts: hearFrom (the box on a store's form);
 *   - lib/buyer-words/join.ts: line, Marktmorgen's own sentence on the
 *     sign-up box. A line the store wrote over it is the store's own words,
 *     not covered by this version.
 *
 * LIST_CONSENT_FINGERPRINT is the SHA-256 of those words, held by
 * tests/contact-consent-version.test.ts: any change to them in any language
 * fails it until LIST_CONSENT_VERSION moves to a new one and the fingerprint
 * with it. Earlier versions' words stay in the repository's history under
 * their version.
 *
 * No imports, so a page or a test can read it alone.
 */
export const LIST_CONSENT_VERSION = "list-1";
export const LIST_CONSENT_FINGERPRINT = "06a409ad9516631cd33ee7d285735836931205dfed2819bcda0f54d06f0be54d";

/** Where an own yes to the list was given. */
export const CONSENT_PLACES = ["checkout", "free", "waitlist", "join", "form"] as const;
export type ConsentPlace = (typeof CONSENT_PLACES)[number];

export const isConsentPlace = (value: unknown): value is ConsentPlace => typeof value === "string" && (CONSENT_PLACES as readonly string[]).includes(value);

/** A version as this module writes them: "list-" and a whole number. */
export const CONSENT_VERSION_PATTERN = /^list-[1-9][0-9]{0,5}$/;
