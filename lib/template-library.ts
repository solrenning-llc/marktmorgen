import {PAGE_TEMPLATES,templateOutline} from "@/lib/sales-page";
import {MAIL_TEMPLATES,serializeMailBlocks} from "@/lib/mail-body";
import {FUNNEL_STARTERS} from "@/lib/funnel-starters";
import {starterCard} from "@/lib/funnel-starter-catalog";
import {welcomeSteps,boughtSteps,type StarterFacts} from "@/lib/mail-starters";
import {COURSE_TEMPLATES,opensWords} from "@/lib/course-templates";
import type {LibraryCard} from "@/lib/template-library-rules";
/** Existing canonical definitions only; no read, write, model or provider operation. */
export function templateLibraryCards(facts:StarterFacts):LibraryCard[]{
 return [
 ...PAGE_TEMPLATES.map(template=>({id:template.id,kind:"page" as const,label:template.label,hint:template.hint,goal:template.free?"leads" as const:template.id==="course"||template.id==="membership"?"teaching" as const:template.id==="coaching"?"services" as const:"sales" as const,preview:["Hero",...templateOutline(template.id)],free:template.free})),
 ...FUNNEL_STARTERS.map(starter=>{const card=starterCard(starter);return {id:card.id,kind:"funnel" as const,label:card.label,hint:card.hint,goal:card.goal,preview:card.steps.map(step=>step.title+" — "+step.kind)};}),
 ...MAIL_TEMPLATES.map(template=>({id:template.id,kind:"email" as const,label:template.label,hint:template.hint,goal:template.id==="welcome"||template.id==="news"||template.id==="year-end"?"leads" as const:template.id==="back-to-school"?"teaching" as const:"sales" as const,preview:[serializeMailBlocks(template.blocks)]})),
 ...COURSE_TEMPLATES.map(template=>({id:template.id,kind:"course" as const,label:template.name,hint:template.about,goal:"teaching" as const,preview:template.modules.length?[
  ...template.modules.flatMap(module=>[`${module.title} — ${opensWords(module.dripDays)}`,...module.lessons.map(lesson=>`Lesson — ${lesson}`)]),
  ...(template.certificate?["Certificate of completion — switched on when this structure is used."]:[]),
 ]:["Empty course — add modules and lessons one at a time."]})),
 ...(["welcome","bought"] as const).map(id=>({id,kind:"sequence" as const,label:id==="welcome"?"Welcome sequence":"After a first purchase",hint:"Existing starter sequence. Product steps adapt to your store; opens an unsaved paused draft and sends nothing.",goal:id==="welcome"?"leads" as const:"sales" as const,preview:(id==="welcome"?welcomeSteps(facts):boughtSteps(facts)).map(step=>step.delayHours+" hours: "+step.subject+"\n"+step.body)}))
 ];
}
