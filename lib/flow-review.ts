import { goalClash, MAX_FLOW_WAIT_HOURS, readsEmailBefore } from "@/lib/flow-rules";
import { MAX_STEPS } from "@/lib/flow-limits";
import { END, checkRoutes } from "@/lib/flow-paths";
import { hasPlaceholder } from "@/lib/mail-body";
import { fieldValue, isFieldType } from "@/lib/crm-rules";
import type { Flow } from "@/lib/flows";

export type FlowReviewContext = {
  products: readonly { id: string }[];
  /** Paid product ids from the selected store catalog; omitted when not supplied. */
  paidProducts?: readonly string[];
  courses: readonly string[];
  forms: readonly { id: string; outcomes?: readonly { id: string }[] }[];
  fields: readonly { id: string; name: string; type: string; options: string[] }[];
  stages: readonly { id: string }[];
  flows: readonly Pick<Flow, "id" | "name" | "active" | "steps">[];
  /** Who may be made responsible for a deal; omitted when not supplied. */
  assignees?: readonly string[];
};
/** Saved references only; never sends email or executes an action. */
export function flowConfigurationIssues(flow: Flow, context: FlowReviewContext): string[] {
  const issues: string[] = [];
  if (!flow.steps.length) issues.push("This sequence has no steps. Add an email or action before activating.");
  const productExists = (id: string | null) => context.products.some(product => product.id === id);
  if (flow.trigger === "product" && !productExists(flow.productId)) issues.push("The trigger product is unavailable. Choose a product in this store.");
  if ((flow.trigger === "finished" || flow.trigger === "started") && !context.courses.includes(flow.productId ?? "")) issues.push("The trigger course is unavailable. Choose a current course.");
  if (flow.trigger === "abandoned" && !productExists(flow.productId)) issues.push("The product of the abandoned checkout is unavailable. Choose a product in this store.");
  if (flow.trigger === "abandoned" && !(flow.goal && ("any" in flow.goal || "productId" in flow.goal))) issues.push("A workflow about an abandoned checkout needs a goal: end it once they buy, so nobody is reminded after paying.");
  if (flow.steps.length > MAX_STEPS) issues.push("This workflow has more than " + MAX_STEPS + " steps. Remove steps before saving.");
  const badRoute = checkRoutes(flow.steps);
  if (badRoute !== null) issues.push("Step " + (badRoute + 1) + ": a branch must go forward to a later step of this workflow. Choose a later step, or the end.");
  if (flow.trigger === "stage" && !context.stages.some(stage => stage.id === flow.stageId)) issues.push("The deal stage that starts this workflow is no longer in your pipelines. Choose a current stage.");
  if (flow.trigger === "form" && !context.forms.some(form => form.id === flow.formId)) issues.push("The trigger form is unavailable for this sequence. Choose a form that collects an email address.");
  else if (flow.trigger === "form" && flow.formOutcome && !context.forms.find(form => form.id === flow.formId)?.outcomes?.some(o => o.id === flow.formOutcome)) issues.push("The quiz result that starts this workflow is no longer in the form. Choose one of its results, or everyone who sends it.");
  if (flow.goal && "productId" in flow.goal && !productExists(flow.goal.productId)) issues.push("The product used to end this sequence is unavailable. Review the goal.");
  const startsPaid = context.paidProducts?.includes(flow.productId ?? "") ?? false;
  if (goalClash(flow.trigger, flow.productId, flow.goal ?? null, startsPaid, flow.tag)) issues.push("This ending conflicts with the trigger and would stop the sequence before its first email. Choose another ending or none.");
  flow.steps.forEach((step, index) => {
    const prefix = "Step " + (index + 1) + ": ";
    if (readsEmailBefore(step.when) && (index === 0 || flow.steps[index - 1].action)) issues.push(prefix + "This click condition needs an email immediately before it. Move it after an email or choose another condition.");
    if (!Number.isInteger(step.delayHours) || step.delayHours < 0 || step.delayHours > MAX_FLOW_WAIT_HOURS) issues.push(prefix + "Choose a valid wait from zero to 365 days, in whole hours.");
    if (hasPlaceholder(JSON.stringify(step))) issues.push(prefix + "Replace the template placeholders in this step before saving or activating.");
    if (!step.action && (!step.subject.trim() || !step.body.trim())) issues.push(prefix + "Complete the email subject and content before activating.");
    if (step.when && "productId" in step.when) {
      const course = ["started", "unstarted", "finished", "unfinished"].includes(step.when.if);
      if (course ? !context.courses.includes(step.when.productId) : !productExists(step.when.productId)) issues.push(prefix + "The condition refers to an unavailable " + (course ? "course" : "product") + ". Review it before activating.");
    }
    const action = step.action;
    if (action?.do === "start") {
      const target = context.flows.find(target => target.id === action.flowId && target.id !== flow.id);
      if (!target) issues.push(prefix + "The sequence to start is unavailable. Choose another sequence.");
      else if (!target.active || !target.steps.length) issues.push(prefix + "The sequence “" + target.name + "” is paused or has no steps. Review it before expecting this action to start it.");
    }
    if (action?.do === "stop" && !context.flows.some(target => target.id === action.flowId && target.id !== flow.id)) issues.push(prefix + "The sequence to take them out of is unavailable. Choose another sequence.");
    if (action?.do === "field") {
      const field = context.fields.find(field => field.id === action.field);
      if (!field) issues.push(prefix + "The contact field is unavailable. Choose a current field.");
      else if (!isFieldType(field.type)) issues.push(prefix + "The contact field format could not be checked. Review the field configuration.");
      else if (fieldValue({ ...field, type: field.type }, action.value) === null) issues.push(prefix + "The saved value is incompatible with contact field “" + field.name + "”. Review its type and allowed values.");
    }
    if (action?.do === "deal" && !context.stages.some(stage => stage.id === action.stage)) issues.push(prefix + "The deal stage is unavailable. Choose a current stage.");
    if (action?.do === "assign" && context.assignees && !context.assignees.includes(action.assignee)) issues.push(prefix + "This teammate can no longer be responsible for deals. Choose someone on your team who can see orders.");
    if (action?.do === "rotate" && context.assignees && context.assignees.length < 2) issues.push(prefix + "No one besides you can be responsible for deals, so every deal goes to you. Add a teammate who can see orders.");
    if (step.next && step.next !== END && !flow.steps.some(target => target.id === step.next)) issues.push(prefix + "The step it goes to next was removed. Choose a later step, or the end.");
  });
  return issues;
}
