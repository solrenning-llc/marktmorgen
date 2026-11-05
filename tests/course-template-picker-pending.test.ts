/** A pending save must keep the visible structure equal to the one sent. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CourseTemplatePicker } from "@/components/course-template-picker";
import { emptyCourse } from "@/lib/course";
import { done, is, part } from "./check";

let saves = 0;
const draw = (busy: boolean) => renderToStaticMarkup(createElement(CourseTemplatePicker, {
  course: emptyCourse(), busy,
  save: async () => { saves += 1; return { ok: false }; },
  onSkip: () => {}, onApplied: () => {},
}));
const group = (html: string) => html.match(/<fieldset\b[^>]*>[\s\S]*?<\/fieldset>/)?.[0] ?? "";
const disabled = (html: string) => /^<fieldset\b[^>]*\sdisabled(?:=""|\s|>)/.test(group(html));
const unavailable = (html: string) => /^<fieldset\b[^>]*\saria-disabled="true"/.test(group(html));

part("Course structure selection while its save is pending");
const pending = draw(true);
const idle = draw(false);
is("a pending save identifies the unavailable radio group", unavailable(pending), true);
is("the pending group keeps native keyboard focus targets", disabled(pending), false);
is("all five structure options stay inside that group", (group(pending).match(/type="radio"/g) ?? []).length, 5);
is("the group remains named for keyboard and screen-reader users", group(pending).includes('<legend class="field-label">Pick a structure</legend>'), true);
is("when saving ends the group is available again", unavailable(idle), false);
is("the pending exit remains focusable instead of natively disabled", /<button\b[^>]*\sdisabled(?:=""|\s|>)/.test(pending), false);
is("the pending exit announces its unavailable state", /<button\b[^>]*aria-disabled="true"/.test(pending), true);
is("all choices remain available when idle", (group(idle).match(/type="radio"/g) ?? []).length, 5);
is("rendering either state never saves a structure", saves, 0);
done();
