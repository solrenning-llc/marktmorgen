/**
 * Prints, as one JSON object, the erasure's script exactly as the application sends it (lib/form-store.ts
 * FORGET_FORM_PERSON), and every case of tests/form-forget-cases.ts with what the rule of lib/form-respondent.ts makes
 * of it: built and run by scripts/form-forget-redis.mjs for scripts/test_form_forget_redis.py, which runs the script
 * in a real Redis and compares. It reaches no Redis itself.
 */
import { FORGET_FORM_PERSON } from "@/lib/form-store";
import { personAddress } from "@/lib/form-respondent";
import { FORM_FORGET_CASES, expectedOf } from "./form-forget-cases";

process.stdout.write(JSON.stringify({
  script: FORGET_FORM_PERSON,
  cases: FORM_FORGET_CASES.map((c) => ({
    name: c.name,
    address: personAddress(c.email),
    forms: c.forms.map((form) => ({ ids: form.ids, items: form.items, expected: expectedOf(c.email, form) })),
  })),
}));
