/**
 * MM-SA-40, same-family follow-up (reading 51LL): a funnel's sequence is never set to start from a form that cannot
 * start it. A form starts a sequence only for an address it has proven: its list box checked, and the button in the
 * email it sends pressed (app/api/store/form/route.ts). The forms a funnel makes never offer that box (lib/funnel-ai.ts
 * writes offerList:false, and isFunnelAiDraft refuses a draft that sets it), so followUpMoment (lib/funnel-ai-rules.ts)
 * pointed the sequence at a form that never starts it: the AI wrote emails nobody would ever get, and their words
 * spoke of a box that is not there. Now a form is the moment only when it offers the box; otherwise the sequence
 * follows a product, as for a funnel without a form.
 */
import { readFileSync } from "node:fs";
import { followUpMoment } from "@/lib/funnel-ai-rules";
import { FUNNEL_TYPES, pagesOf } from "@/lib/funnel-types";
import { done, is, part } from "./check";

part("Every funnel type with an email form and no product picked");
const withForm = FUNNEL_TYPES.filter((type) => pagesOf(type).some((page) => page.form && page.blocks.includes("form") && page.form.fields.some((field) => field.type === "email")));
is("control: some funnel types ask for an email in a form", withForm.length > 0, true);
for (const type of withForm) {
  const moment = followUpMoment(type, {});
  const page = moment?.trigger === "form" ? pagesOf(type).find((p) => p.key === moment.slot) : null;
  is(`${type.id}: never a form that offers no list box, which would never start the sequence`, moment?.trigger !== "form" || page?.form?.offerList === true, true);
}

part("A form without the box is never the moment");
const quizNoBox = FUNNEL_TYPES.find((type) => type.id === "quiz")!;
const unboxed = { ...quizNoBox, slots: quizNoBox.slots.map((slot) => (slot.kind === "page" && slot.form ? { ...slot, form: { ...slot.form, offerList: false } } : slot)) };
is("without the box, no form trigger", followUpMoment(unboxed, {})?.trigger === "form", false);

part("A form that offers the box is still the moment");
const quiz = FUNNEL_TYPES.find((type) => type.id === "quiz")!;
const boxed = { ...quiz, slots: quiz.slots.map((slot) => (slot.kind === "page" && slot.form ? { ...slot, form: { ...slot.form, offerList: true } } : slot)) };
is("with the box, the form starts the sequence", followUpMoment(boxed, {})?.trigger, "form");

part("An application or a quiz funnel makes its form with the box, unchecked, so its follow-up can start");
for (const id of ["application", "quiz"]) {
  const type = FUNNEL_TYPES.find((t) => t.id === id)!;
  const page = pagesOf(type).find((p) => p.form && p.blocks.includes("form"))!;
  is(`${id}: its form offers the box`, page.form?.offerList, true);
  is(`${id}: its follow-up starts from that form, for whoever checks the box and confirms`, followUpMoment(type, {}), { trigger: "form", slot: page.key });
}
const picker = readFileSync("components/funnel-type-picker.tsx", "utf8");
is("the studio starts each form with its type's box, never forced off", /offerList: page\.form!\.offerList === true/.test(picker), true);
is("an AI draft never turns the creator's box off", /offerList: Boolean\(current\[key\]\?\.offerList\)/.test(picker), true);
is("a follow-up from a form whose box the creator turned off is not saved", /formDrafts\[aiDraft\.sequence\.formSlot\]\?\.offerList/.test(picker), true);
const box = readFileSync("components/sales-blocks.tsx", "utf8");
is("control: the box on the public form starts unchecked", /<input type="checkbox" name="consent" value="yes" disabled=\{ctx\.preview\} \/>/.test(box), true);

part("A free product picked is still first");
const magnet = FUNNEL_TYPES.find((type) => type.slots.some((slot) => slot.kind === "product" && slot.wants === "free"));
if (magnet) {
  const free = magnet.slots.find((slot) => slot.kind === "product" && slot.wants === "free")!;
  is("the free product's moment", followUpMoment(magnet, { [free.key]: "prod01" }), { trigger: "product", slot: free.key, productId: "prod01" });
}
done();
