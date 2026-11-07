/**
 * Questions a creator asks at checkout: the size, the name to put on it, the
 * time zone, what they want to talk about on the call.
 *
 * They are Stripe's own custom fields, shown on Stripe's payment page under
 * the card. That matters for three reasons. The answer is typed where the
 * buyer is already typing, so nobody is sent to a form after paying and
 * forgets. It is kept on the payment itself, on the creator's own account, so
 * it is in their Stripe dashboard next to the charge and in the studio's list
 * of sales. And a required question has to be answered before the buyer can
 * pay, which a form sent afterward can never promise.
 *
 * Stripe's limits are the limits here, checked before anything is saved so a
 * checkout is never refused over a question: three questions, labels of up to
 * 50 characters, and a list of up to 200 choices of up to 100 characters each.
 * A text answer may be up to 255 characters, as Stripe allows.
 *
 * A yes or no question (387 [TB13], 7 November 2026) is Stripe's list with
 * exactly two choices, "Yes" and "No", because Stripe's page has no checkbox
 * among its custom fields. Nothing is picked for the buyer, and the answer is
 * only an answer: it never signs anyone up for emails, which the checkout asks
 * about on its own, with its own words kept.
 *
 * Questions are asked wherever the buyer pays through Stripe's page: a file,
 * a link, a course, a membership, a paid call. Something free is given for an
 * email address and never reaches Stripe, so it has no questions.
 *
 * Pure apart from the types, so the studio checks with the same rules.
 */

export const MAX_CHECKOUT_FIELDS = 3;
export const MAX_FIELD_LABEL_LENGTH = 50;
export const MAX_DROPDOWN_OPTIONS = 200;
export const MAX_DROPDOWN_OPTION_LENGTH = 100;
export const MIN_DROPDOWN_OPTIONS = 2;

export const FIELD_TYPES = ["text", "numeric", "dropdown", "yes_no", "phone"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_NAMES: Record<FieldType, string> = {
  text: "Short answer",
  numeric: "Number",
  dropdown: "Choose from a list",
  yes_no: "Yes or no",
  phone: "Phone number",
};

/**
 * A phone number (added 11 October 2026) is not one of Stripe's custom
 * fields: it is Stripe's own phone box (phone_number_collection), which asks
 * for the country and checks the number is one, and which Stripe always
 * requires once it is on. So it is asked once at most, is never optional, and
 * its label is Stripe's own, in the buyer's language; the creator reads the
 * answer on the sale as "Phone".
 */
export const PHONE_LABEL = "Phone number";

/** The two choices of a yes or no question, fixed by the code, in this order. */
export const YES_NO_CHOICES = ["Yes", "No"] as const;

/** What the studio says under a yes or no question, so the creator knows what the buyer sees. */
export const YES_NO_NOTE =
  "On Stripe's payment page, the buyer picks from a short list with Yes and No. Nothing is picked for them. The answer never signs anyone up for your emails: the checkout asks about emails on its own.";

export type CheckoutField = {
  /** What the buyer reads above the box, in the creator's words. */
  label: string;
  type: FieldType;
  /** Whether the buyer may leave it empty. Required unless the creator says. */
  optional: boolean;
  /** The choices, for a list. Empty for every other kind, a yes or no question included (its two are fixed). */
  options: string[];
};

function isFieldType(value: unknown): value is FieldType {
  return typeof value === "string" && (FIELD_TYPES as readonly string[]).includes(value);
}

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** Whatever came back from storage, made safe to use. */
export function parseFields(raw: unknown): CheckoutField[] {
  if (!Array.isArray(raw)) return [];
  const fields: CheckoutField[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const label = clean(value.label, MAX_FIELD_LABEL_LENGTH);
    if (!label || !isFieldType(value.type)) continue;
    const options =
      value.type === "dropdown" && Array.isArray(value.options)
        ? value.options.map((option) => clean(option, MAX_DROPDOWN_OPTION_LENGTH)).filter(Boolean).slice(0, MAX_DROPDOWN_OPTIONS)
        : [];
    if (value.type === "dropdown" && options.length < MIN_DROPDOWN_OPTIONS) continue;
    if (value.type === "phone") {
      if (fields.some((field) => field.type === "phone")) continue;
      fields.push({ label: PHONE_LABEL, type: "phone", optional: false, options: [] });
    } else fields.push({ label, type: value.type, optional: value.optional === true, options });
    if (fields.length >= MAX_CHECKOUT_FIELDS) break;
  }
  return fields;
}

export type FieldsProblem =
  | { reason: "too_many" }
  | { reason: "label" | "type" | "options_few" | "options_many" | "option_long" | "options_same" | "label_long" | "phone_twice"; at: number };

/**
 * Reads what the studio sent, strictly. Where parseFields quietly drops what
 * it cannot use, this says which question was wrong and how, because the
 * creator is there to fix it.
 */
export function readFields(raw: unknown): CheckoutField[] | FieldsProblem {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_CHECKOUT_FIELDS) return { reason: "too_many" };
  const fields: CheckoutField[] = [];
  for (let at = 0; at < raw.length; at += 1) {
    const value = (raw[at] && typeof raw[at] === "object" ? raw[at] : {}) as Record<string, unknown>;
    if (value.type === "phone") {
      // Stripe's own box, with its own words: nothing to label, never optional.
      if (fields.some((field) => field.type === "phone")) return { reason: "phone_twice", at };
      fields.push({ label: PHONE_LABEL, type: "phone", optional: false, options: [] });
      continue;
    }
    const typed = typeof value.label === "string" ? value.label.replace(/\s+/g, " ").trim() : "";
    if (!typed) return { reason: "label", at };
    if (typed.length > MAX_FIELD_LABEL_LENGTH) return { reason: "label_long", at };
    if (!isFieldType(value.type)) return { reason: "type", at };
    let options: string[] = [];
    if (value.type === "dropdown") {
      const lines = Array.isArray(value.options)
        ? value.options
        : typeof value.options === "string"
          ? value.options.split(/\r?\n/)
          : [];
      options = lines.map((line) => (typeof line === "string" ? line.replace(/\s+/g, " ").trim() : "")).filter(Boolean);
      if (options.length < MIN_DROPDOWN_OPTIONS) return { reason: "options_few", at };
      if (options.length > MAX_DROPDOWN_OPTIONS) return { reason: "options_many", at };
      if (options.some((option) => option.length > MAX_DROPDOWN_OPTION_LENGTH)) return { reason: "option_long", at };
      if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) return { reason: "options_same", at };
    }
    fields.push({ label: typed, type: value.type, optional: value.optional === true, options });
  }
  return fields;
}

/**
 * Adds the questions to a Checkout Session being made.
 *
 * The keys and the choice values are made from positions, because Stripe
 * wants them plain and unique and the buyer never sees them. The answers are
 * read back by label, from the session itself, so a question the creator has
 * since reworded or removed still reads right on an old sale.
 */
export function applyCheckoutFields(body: URLSearchParams, fields: CheckoutField[] | undefined): void {
  const asked = (fields ?? []).slice(0, MAX_CHECKOUT_FIELDS);
  // The phone is Stripe's own box, not a custom field (PHONE_LABEL above).
  if (asked.some((field) => field.type === "phone")) body.set("phone_number_collection[enabled]", "true");
  asked.filter((field) => field.type !== "phone").forEach((field, i) => {
    const at = `custom_fields[${i}]`;
    body.set(`${at}[key]`, `question${i + 1}`);
    body.set(`${at}[label][type]`, "custom");
    body.set(`${at}[label][custom]`, field.label.slice(0, MAX_FIELD_LABEL_LENGTH));
    // A yes or no question is Stripe's own list, with its two fixed choices and no default_value, so nothing is picked.
    body.set(`${at}[type]`, field.type === "yes_no" ? "dropdown" : field.type);
    body.set(`${at}[optional]`, field.optional ? "true" : "false");
    if (field.type === "yes_no") {
      YES_NO_CHOICES.forEach((choice, j) => {
        body.set(`${at}[dropdown][options][${j}][label]`, choice);
        body.set(`${at}[dropdown][options][${j}][value]`, choice.toLowerCase());
      });
    } else if (field.type === "dropdown") {
      field.options.slice(0, MAX_DROPDOWN_OPTIONS).forEach((option, j) => {
        body.set(`${at}[dropdown][options][${j}][label]`, option.slice(0, MAX_DROPDOWN_OPTION_LENGTH));
        body.set(`${at}[dropdown][options][${j}][value]`, `choice${j + 1}`);
      });
    }
  });
}

/** One question and what the buyer answered, as the creator reads it. */
export type Answer = { label: string; value: string };

type SessionField = {
  label?: { custom?: unknown } | null;
  type?: unknown;
  dropdown?: { value?: unknown; options?: { label?: unknown; value?: unknown }[] | null } | null;
  numeric?: { value?: unknown } | null;
  text?: { value?: unknown } | null;
};

/** The answers a finished checkout carries, skipping questions left empty, and the phone number when one was asked for. */
export function readAnswers(session: { custom_fields?: unknown; customer_details?: unknown }): Answer[] {
  const list = Array.isArray(session.custom_fields) ? (session.custom_fields as SessionField[]) : [];
  const answers: Answer[] = [];
  for (const field of list) {
    const label = typeof field.label?.custom === "string" ? field.label.custom : "";
    let value = "";
    if (field.type === "dropdown") {
      const chosen = field.dropdown?.value;
      const option = (field.dropdown?.options ?? []).find((entry) => entry.value === chosen);
      value = typeof option?.label === "string" ? option.label : typeof chosen === "string" ? chosen : "";
    } else if (field.type === "numeric") {
      value = typeof field.numeric?.value === "string" ? field.numeric.value : "";
    } else if (field.type === "text") {
      value = typeof field.text?.value === "string" ? field.text.value : "";
    }
    if (label && value) answers.push({ label, value });
  }
  const details = session.customer_details && typeof session.customer_details === "object" ? (session.customer_details as { phone?: unknown }) : null;
  const phone = details?.phone;
  if (typeof phone === "string" && phone.trim()) answers.push({ label: "Phone", value: phone.trim().slice(0, 40) });
  return answers;
}
