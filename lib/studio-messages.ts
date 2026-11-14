/**
 * What every studio form says when the store's own checks turn a change
 * away (lib/studio-route.ts): each form's own words for these come first.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { SETUP_STORAGE_BYTES } from "@/lib/plan-standing";

const GB = 1024 * 1024 * 1024;
const SETUP_GB = SETUP_STORAGE_BYTES / GB;

export const STUDIO_MESSAGES: Record<string, string> = {
  role: "You need permission for this change. Ask the store owner to review your role.",
  // A session let in without its second step (lib/two-step.ts LOCKED_NEEDS).
  locked: "This action is locked because you signed in without your second step. Check the recovery date at the top of your studio.",
  store_gone: "This store is no longer available to you. It may have been deleted or your team access may have changed. Reload to see your stores.",
  // What an upload of a file that is sold can be told (lib/sold-file-upload.ts).
  storage_full: "This file is larger than your remaining storage. Review the files you no longer need before removing anything.",
  // The same, for a store that is not on a paid plan yet (lib/plan-standing.ts).
  storage_trial: "This file is larger than your remaining trial storage. Check the allowance and remaining space in your studio, then review files you no longer need.",
  storage_setup: PLANS_ON_SALE
    ? `A store without a plan holds up to ${SETUP_GB} GB, and this file does not fit in what is left. Start your plan to add more; trial storage is capped by the plan you choose.`
    : `A store holds up to ${SETUP_GB} GB until its plan starts, and this file does not fit in what is left. Plans are not on sale yet; until they are, delete a file you do not need to make room.`,
  upload_refresh: "Reload this page, then choose your file again.",
  // What the store keeps in the database is past its data room (lib/store-data-rules.ts).
  store_full: "Your store's record space is full. Review old posts, drafts, pages or contacts. Remove only what you no longer need, then try the change again.",
  // A renewal Stripe could not collect (232 [CA1] unit 4, lib/plan-standing.ts renewalUnpaid).
  // A plan payment the creator disputed (232 [CA1] unit 5, lib/plan-dispute-rules.ts).
  plan_disputed: "A payment for your plan is disputed with your bank, so new uploads are paused. Check the notice at the top of your studio for what happens next. Files already uploaded stay as they are.",
  renewal_unpaid: "Your plan's renewal payment did not go through, so new uploads are paused. Check the notice at the top of your studio to pay it; uploads start again once it is paid. Files already uploaded stay as they are.",
  upload_budget_unavailable: "New uploads are paused right now. Existing files and downloads are not changed by this pause.",
  uploads_pending: "Other uploads are using the remaining space. Finish or cancel them before trying again. If an earlier upload stopped, try again later.",
  // One upload's finish and cancel requests are spent (lib/vault.ts, VAULT_CONTROL_CALLS_PER_UPLOAD).
  upload_tries: "This upload was already finished or stopped, so it can't be changed again. To upload the file, choose it again.",
  // The upload's first finish or cancel is still running in another request.
  upload_busy: "This upload is still being finished. Wait a minute, then reload this page to see if your file is there.",
  upload_stopped: "The upload stopped before it finished. Check your connection, then choose the file again.",
  // Also the store's calls to connected services used, or no place this month (lib/metered-limits.ts): no reason is claimed.
  slow_down: "Uploads can't start just now. Try again later.",
  files_unavailable: "File uploads are unavailable right now. Keep your file and try again in a few minutes.",
  // The studio's picture door, capped before it signs (lib/picture-door.ts).
  pictures_waiting: "Your store has many pictures uploaded in the last day that are not on a product, link or page yet, so this upload did not start. Add those pictures where you want them, or try again later.",
  pictures_hourly: "Your store has started many picture uploads in the last hour, so this upload did not start. Try again in an hour.",
  pictures_unavailable: "We could not check your store's picture uploads just now, so this upload did not start. Try again in a moment.",
  // A page whose read did not come back in a known shape (lib/sales-page-store.ts readPage): nothing is decided from it.
  page_unread: "A page could not be read just now, so nothing was changed. Reload, then try again.",
  // The same, once a section update had already been counted toward the month (app/api/store/saved-blocks, apply).
  page_unread_counted: "A page could not be read just now, so no page was changed. This try still counts toward this month's section updates. Reload, then try again.",
};
