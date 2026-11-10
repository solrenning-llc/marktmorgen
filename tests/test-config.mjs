import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
/**
 * One wiring source for the repository runner and local parallel verification.
 * A new test that needs aliases declares them in its own file,
 * tests/aliases/<test file>.json, never by adding a line to the list below:
 * every pull request appended one at the same place, and two of them conflicted
 * (Claude 1, C1-20261107-1232-TODOS-3). The file is one object from alias to
 * target, read after this list, so it may also replace an entry of it:
 * a target is a path under tests/, or under the repository root when it starts
 * with "@/", and null takes a default of the list away for that test only.
 * A target that does not exist, or a file that does not read so, fails the test.
 */
export function testAliases(file,root,here){
 return withOwnAliases(centralAliases(file,root,here),file,root,here);
}
function withOwnAliases(aliases,file,root,here){
 const path=join(here,'aliases',file+'.json');
 if(!existsSync(path))return aliases;
 let own;
 try{own=JSON.parse(readFileSync(path,'utf8'));}catch(error){throw new Error(`tests/aliases/${file}.json does not parse: ${error.message}`);}
 if(!own||typeof own!=='object'||Array.isArray(own))throw new Error(`tests/aliases/${file}.json is not one object from alias to target`);
 for(const [name,target] of Object.entries(own)){
  if(target===null){delete aliases[name];continue;}
  if(typeof target!=='string'||!target)throw new Error(`tests/aliases/${file}.json: the target of ${name} is not a path or null`);
  const resolved=target.startsWith('@/')?join(root,target.slice(2)):join(here,target);
  if(!existsSync(resolved))throw new Error(`tests/aliases/${file}.json: the target of ${name}, ${target}, does not exist`);
  aliases[name]=resolved;
 }
 return aliases;
}
/** The list kept from before tests/aliases: add nothing here. */
function centralAliases(file,root,here){
 const aliases={'@':root,'@/lib/redis':['range-traffic-coverage.test.ts','stats-traffic-coverage.test.ts'].includes(file)?join(root,'lib/redis.ts'):join(here,'redis-stub.ts')};
 if(file==='stats-notes-read-evidence.test.ts')aliases['@/lib/redis']=join(here,'stats-notes-read-world.ts');
 if(file==='path-weekly-summary-page.test.ts'){
  for(const name of ['ai','path-wording-source','path-scripts','path-growth-facts','path-board','opening','store-checkout','stripe-connect','path-campaign','studio-route','store-allowance','store-allowance-rules','path-plan','larger-plan','path'])aliases['@/lib/'+name]=join(here,'path-weekly-summary-page-world.tsx');
  for(const name of ['path-certificates','path-ai-wording','path-social-scripts','path-growth-missions','path-board','path-checkout-notice','path-missions','path-reminder-button','path-share-card','studio-header','studio-store-pin','path-onboarding'])aliases['@/components/'+name]=join(here,'path-weekly-summary-page-world.tsx');
  for(const name of ['next/headers','next/navigation','next/link'])aliases[name]=join(here,'path-weekly-summary-page-world.tsx');
 }


 if(file==='review-summary-unavailable-page.test.ts'){
  for(const name of ['catalog','studio-route','reviews','review-ai-summary','customer-voice','buyer-orders','purchase-email','ai','mail'])aliases['@/lib/'+name]=join(here,'review-summary-page-world.tsx');
  for(const name of ['studio-header','studio-store-pin','ai-assist','review-studio','review-qr','review-themes','review-ai-summaries'])aliases['@/components/'+name]=join(here,'review-summary-page-world.tsx');
  for(const name of ['next/headers','next/navigation'])aliases[name]=join(here,'review-summary-page-world.tsx');
 }
 if(file==='blog-read-unavailable-page.test.ts'){
  for(const name of ['store','store-blog','studio-route','traffic','ai'])aliases['@/lib/'+name]=join(here,'blog-read-page-world.tsx');
  for(const name of ['studio-header','studio-store-pin','ai-assist','blog-editor','store-tracking'])aliases['@/components/'+name]=join(here,'blog-read-page-world.tsx');
  aliases['next/headers']=join(here,'blog-read-page-world.tsx');
  aliases['next/navigation']=join(here,'blog-read-page-world.tsx');
 }
 if(file==='studio-today-trips.test.ts'||file==='studio-today-removal-order.test.ts'){aliases['next/headers']=join(here,'security/next-headers.ts');aliases['next/navigation']=join(here,'studio-today-navigation.ts');aliases['next/server']=join(here,'studio-today-next-server.ts');}
 if(file==='studio-passkeys-unread.test.ts'||file==='studio-lock-unread.test.ts'){aliases['next/headers']=join(here,'security/next-headers.ts');aliases['next/navigation']=join(here,'studio-today-navigation.ts');aliases['next/server']=join(here,'studio-today-next-server.ts');}
 if(file==='service-counter-admission.test.ts')for(const name of ['redis','store-allowance','traffic'])aliases['@/lib/'+name]=join(here,'service-counter-admission-world.ts');
 if(file==='stream-hook-counter-admission.test.ts')for(const name of ['redis','stream','auto-captions'])aliases['@/lib/'+name]=join(here,'stream-hook-counter-admission-world.ts');
 if(file==='yearly-ask-read-evidence.test.ts')for(const name of ['redis','order-data','stripe-account','email','store','membership-manage','mail','contacts','purchase-email','catalog','store-checkout','auth','member-health','yearly-switch'])aliases['@/lib/'+name]=join(here,'yearly-ask-read-world.ts');
 if(['community-mail-read-evidence.test.ts','nx-community-mail.test.ts'].includes(file))for(const name of ['redis','community','community-access','community-events','email','mail','order-data','calls','phone-alerts'])aliases['@/lib/'+name]=join(here,'community-mail-read-world.ts');
 if(file==='r30-scan-followup.test.ts')aliases['@/lib/contact-rules']=join(here,'r30-scan-followup-contact-rules.ts');
 if(file==='community-report-queue-view.test.ts'||file==='r30-studio-rsvp-unread.test.ts'){
  for(const name of ['next/headers','next/navigation'])aliases[name]=join(here,'meeting-withdrawal-page-world.ts');
  for(const name of ['studio-header','studio-store-pin'])aliases['@/components/'+name]=join(here,'meeting-withdrawal-page-world.ts');
 }
 if(file==='preview-counter-admission.test.ts')for(const name of ['redis','store','store-request','catalog','traffic','pdf-preview','serve-file'])aliases['@/lib/'+name]=join(here,'preview-counter-admission-world.ts');
 if(file==='flow-stop-action.test.ts')aliases['@/lib/ses']=join(here,'flow-stop-ses-network.ts');
 if(file==='thanks-note-unread.test.ts'){aliases['next/headers']=join(here,'security/next-headers.ts');aliases['next/server']=join(here,'next-server-after-world.ts');}
 if(file==='sales-goal-ack.test.ts')aliases['@/lib/store-request']=join(here,'sales-goal-ack-world.ts');
 if(!['order-email-fallback.test.ts','resend-fallback-budget.test.ts','auth-mail-unavailable.test.ts','course-link-mail-unavailable.test.ts','email-meter-preflight.test.ts'].includes(file))aliases['@/lib/resend-fallback-transport']=join(here,'resend-fallback-fixture.ts');
 if(file==='customer-base-fixed-evidence.test.ts')for(const [name,fixture] of [['upload-budget-policy','upload-budget-approved-policy'],['ai-spend-policy','commercial-ai-approved-policy'],['llc-fixed-costs','llc-fixed-approved-policy']])aliases['@/lib/'+name]=join(here,fixture+'.ts');
 if(file==='meeting-withdrawal-page.test.ts'||file==='studio-meetings-test-unread.test.ts'){
  for(const name of ['next/headers','next/navigation'])aliases[name]=join(here,'meeting-withdrawal-page-world.ts');
  for(const name of ['studio-header','studio-store-pin'])aliases['@/components/'+name]=join(here,'meeting-withdrawal-page-world.ts');
  aliases['next/server']=join(here,'next-server-after-world.ts');
  aliases['@/lib/account-notice']=join(here,'meeting-disabled-world.ts');
 }
 if(file==='letter-members.test.ts'||file==='bv1-letter-preview.test.ts'){aliases['next/headers']=join(here,'letter-members-world.ts');aliases['next/server']=join(here,'next-server-after-world.ts');aliases['@/components/store-tracking']=join(here,'letter-members-world.ts');}
 if(['public-reads-ceiling.test.ts','draft-view.test.ts','draft-view-move-renew.test.ts','draft-view-waitlist.test.ts','pf1-paypal-thanks-honest.test.ts'].includes(file))aliases['next/headers']=join(here,'security/next-headers.ts');
 if(['draft-view.test.ts','draft-view-move-renew.test.ts','draft-view-waitlist.test.ts','pf1-paypal-thanks-honest.test.ts'].includes(file))aliases['next/server']=join(here,'next-server-after-world.ts');
 if(file==='failure-cleanup-paths.test.ts'||file==='picture-owner-paths.test.ts'||file==='picture-owner-followup.test.ts'||file==='picture-door-replies.test.ts'||file==='encanto-tone-route.test.ts')for(const name of ['@/lib/blob','@vercel/blob/client'])aliases[name]=join(here,'failure-cleanup-world.ts');
 if(['review-g2-card-read-completeness.test.ts','creator-card-partial-read-g.test.ts','creator-card-remove-race-g.test.ts','creator-card-reload-delete-g.test.ts','creator-card-reload-held.test.ts','studio-team-two-step-unknown.test.ts','studio-import-unknown.test.ts'].includes(file))aliases['next/headers']=join(here,'security/next-headers.ts');
 if(file==='meeting-disabled-settings.test.ts')aliases['next/navigation']=join(here,'next-navigation-stub.ts');
 if(file==='zoom-arrival.test.ts')aliases['next/navigation']=join(here,'meeting-withdrawal-page-world.ts');
 if(file==='meeting-disabled-withdrawal.test.ts'){
  aliases['next/server']=join(here,'next-server-after-world.ts');
  for(const name of ['meet-test','account-notice'])aliases['@/lib/'+name]=join(here,'meeting-disabled-world.ts');
 }
 if(file==='host-calendar-removal.test.ts')aliases['@/lib/host-calendar']=join(here,'host-calendar-removal-world.ts');
 if(file==='calendar-add-limit.test.ts')aliases['@/lib/calendar-sync']=join(here,'calendar-add-limit-world.ts');
 if(file==='outreach-counter-admission.test.ts')for(const name of ['redis','store-request','outreach','metered-limits'])aliases['@/lib/'+name]=join(here,'outreach-counter-admission-world.ts');
 if(file==='ai-report-counter-admission.test.ts')for(const name of ['redis','store-request','review-ai-summary','stats-report','numbers-ask','person-agenda-read','ai'])aliases['@/lib/'+name]=join(here,'ai-report-counter-admission-world.ts');
 if(file==='cron-checks-exact.test.ts')for(const name of ['email','verify-mail','verify-stripe'])aliases['@/lib/'+name]=join(here,'cron-checks-exact-world.ts');
 if(file==='mail-check-route.test.ts')for(const name of ['request-guard','email','verify-mail'])aliases['@/lib/'+name]=join(here,'mail-check-route-world.ts');
 if(file==='numbers-email-claim.test.ts')for(const name of ['request-guard','email','traffic','usage-billing','numbers-ask','ai','team','stats'])aliases['@/lib/'+name]=join(here,'numbers-email-claim-world.ts');
 if(file==='plan-break-off-cron.test.ts')for(const name of ['request-guard','billing-reminders','trial-nudges','payment-requests'])aliases['@/lib/'+name]=join(here,'plan-break-off-cron-world.ts');
 if(file==='plan-refund-route.test.ts')aliases['@/lib/studio-route']=join(here,'plan-refund-route-world.ts');
 if(file==='plan-refund-page.test.ts'||file==='kb9-plan-withdrawal.test.ts'||file==='n-2849-plan-recovery.test.ts'||file==='kb9-plan-withdrawal-honest.test.ts'){
  aliases['@/lib/studio-route']=join(here,'plan-refund-route-world.ts');
  for(const name of ['next/headers','next/navigation'])aliases[name]=join(here,'meeting-withdrawal-page-world.ts');
  for(const name of ['studio-header','studio-store-pin'])aliases['@/components/'+name]=join(here,'meeting-withdrawal-page-world.ts');
 }
 if(file==='billing-subscription-write.test.ts')for(const name of ['studio-route','request-guard','billing','store','opening','contract-funding','plan-pause'])aliases['@/lib/'+name]=join(here,'billing-subscription-write-world.ts');
 if(file==='billing-resume-unknown-route.test.ts')for(const name of ['studio-route','request-guard'])aliases['@/lib/'+name]=join(here,'billing-resume-route-world.ts');
 if(['ai-spend.test.ts','ai-spend-provider.test.ts','automatic-ai-spend.test.ts'].includes(file))aliases['@/lib/redis']=join(here,'ai-spend-redis.ts');
 else aliases['@/lib/ai-spend']=join(here,'ai-spend-regression-stub.ts');
 if(file==='upload-budget-routes.test.ts'){
  aliases['@/lib/redis']=join(here,'upload-budget-redis.ts');
  aliases['@/lib/upload-budget-policy']=join(here,'upload-budget-approved-policy.ts');
  for(const name of ['store','catalog','course','delivery','storage-quota','stream','vault','vault-storage','request-guard','store-request','studio-route','blob','metered-limits'])aliases['@/lib/'+name]=join(here,'upload-route-world.ts');
  aliases['@vercel/blob/client']=join(here,'upload-route-world.ts');
 }
 if(file==='path-wording-route.test.ts'){
  for(const name of ['studio-route','path-board-rules','path-reminder','store-request','store','path-rules','path','path-wording','path-wording-source','request-guard','ai-rules'])aliases['@/lib/'+name]=join(here,'path-wording-route-world.ts');
 }
 if(file==='stripe-charges-off.test.ts')aliases['next/server']=join(here,'next-server-after-world.ts');
 if(file==='path-wording-provider.test.ts'){
  aliases['@/lib/redis']=join(here,'path-wording-provider-world.ts');
  aliases['@/lib/ai-spend']=join(root,'lib/ai-spend.ts');
 }
 if(file==='path-growth-facts.test.ts')for(const name of ['redis','catalog','broadcasts','reviews'])aliases['@/lib/'+name]=join(here,'path-growth-world.ts');
 if(file==='path-reminder-push.test.ts')aliases['@/lib/web-push']=join(here,'path-push-world.ts');
 if(file==='digital-consent.test.ts'||file==='checkout-key-count.test.ts'||file==='r30-event-notice-unread.test.ts')aliases['next/server']=join(here,'next-server-after-world.ts');
 if(file==='cart-physical.test.ts'||file==='cart-soon-unknown.test.ts'||file==='cart-soon-get.test.ts'||file==='r24-waitlist-soon-unknown.test.ts')aliases['next/server']=join(here,'next-server-after-world.ts');
 if(file==='cart-stock.test.ts')aliases['next/server']=join(here,'next-server-after-world.ts');
 if(file==='waitlist-join-suspended.test.ts')aliases['next/server']=join(here,'next-server-after-world.ts');
 if(file==='review-photo-paused.test.ts')aliases['next/server']=join(here,'next-server-after-world.ts');
 if(file==='orders-open.test.ts'||file==='kb9-withdrawal.test.ts'||file==='n-2827-withdrawal-flow.test.ts'||file==='kb9-2827-c5-review.test.ts')aliases['next/server']=join(here,'next-server-after-world.ts');
 if(file==='orders-page-bounds.test.ts'){aliases['next/server']=join(here,'next-server-after-world.ts');aliases['next/link']=join(here,'next-link-world.tsx');}
 if(file==='deals-board-pipelines-render.test.ts')aliases['next/navigation']=join(here,'next-navigation-stub.ts');
 if(file==='unnamed-buyer-notes.test.ts')aliases['next/navigation']=join(here,'next-navigation-stub.ts');
 if(file==='wg15-tax-link.test.ts')aliases['next/navigation']=join(here,'next-navigation-stub.ts');
 if(file==='agent-proposals-names.test.ts')aliases['next/navigation']=join(here,'next-navigation-stub.ts');
 if(file==='mail-reservation.test.ts'){aliases['@/lib/email']=join(here,'mail-reservation-email.ts');aliases['@/lib/ses']=join(here,'mail-reservation-ses.ts');}
 if(file==='traffic-admission.test.ts')for(const name of ['redis','store','delivery','secret-box'])aliases['@/lib/'+name]=join(here,'traffic-admission-world.ts');
 if(['upload-budget.test.ts','automatic-upload-budget.test.ts'].includes(file))aliases['@/lib/redis']=join(here,'upload-budget-redis.ts');
 if(['commercial-review-input.test.ts','commercial-terms-snapshot.test.ts','net-margin.test.ts','customer-base.test.ts','plan-revenue-ceilings.test.ts','commercial-ai-coverage.test.ts'].includes(file))aliases['@/lib/upload-budget-policy']=join(here,'upload-budget-approved-policy.ts');
 if(['commercial-review-input.test.ts','commercial-terms-snapshot.test.ts','net-margin.test.ts','customer-base.test.ts','plan-revenue-ceilings.test.ts','commercial-ai-coverage.test.ts'].includes(file))aliases['@/lib/ai-spend-policy']=join(here,'commercial-ai-approved-policy.ts');
 if(file==='ai-spend-provider.test.ts')aliases['@/lib/ai-spend-policy']=join(here,'ai-spend-approved-policy.ts');
 if(['video-admission.test.ts','video-tier.test.ts'].includes(file)){aliases['@/lib/redis']=join(here,'video-admission-redis.ts');aliases['@/lib/stream']=join(here,'video-admission-stream.ts');}
 if(['ai-counted-ack.test.ts','ai-left-envelope.test.ts'].includes(file))for(const name of ['redis','ai-spend'])aliases['@/lib/'+name]=join(here,'z-counted-ack-world.ts');
 if(file==='ai-inbox-balance-page.test.ts'){
  for(const name of ['next/headers','next/navigation'])aliases[name]=join(here,'z-ai-inbox-page-world.ts');
  for(const name of ['studio-route','ai','email','house-store','inbox','team'])aliases['@/lib/'+name]=join(here,'z-ai-inbox-page-world.ts');
  for(const name of ['studio-header','studio-store-pin','inbox-studio'])aliases['@/components/'+name]=join(here,'z-ai-inbox-page-world.ts');
 }
 if(file==='storage-measurement.test.ts')for(const name of ['blob','vault','stream'])aliases['@/lib/'+name]=join(here,'storage-provider-stub.ts');
 if(file==='blob-download-attachment.test.ts')aliases['@/lib/blob']=join(here,'blob-download-attachment-world.ts');
 if(file==='sg2-l1-serve-file.test.ts')aliases['@/lib/blob']=join(here,'blob-download-attachment-world.ts');
 if(file==='picture-takedown.test.ts')aliases['@/lib/blob']=join(here,'picture-takedown-world.ts');
 if(file==='sg2-l1-outreach-order.test.ts')aliases['@/lib/contract-resource-window']=join(here,'sg2-l1-reserve-world.ts');
 if(['exposure-budget.test.ts','exposure-provider.test.ts'].includes(file))aliases['@/lib/redis']=join(here,'exposure-budget-redis.ts');
 if(file==='exposure-provider.test.ts'){
  aliases['@/lib/ai-spend']=join(here,'exposure-ai-spend-stub.ts');
  aliases['@/lib/exposure-budget-policy']=join(here,'exposure-budget-approved-policy.ts');
  aliases['@/lib/commercial-margin']=join(here,'exposure-commercial-context.ts');
 }
 if(file==='exposure-release.test.ts'){
  aliases['@/lib/plan']=join(here,'exposure-release-plan.ts');
  aliases['@/lib/platform-share']=join(here,'exposure-release-share.ts');
  aliases['@/lib/ai-spend-policy']=join(here,'commercial-ai-approved-policy.ts');
  aliases['@/lib/upload-budget-policy']=join(here,'upload-budget-approved-policy.ts');
 }
 if(['contract-funding.test.ts','contract-routes.test.ts','contract-resource-window.test.ts'].includes(file)){
  aliases['@/lib/redis']=join(here,'contract-funding-redis.ts');
  aliases['@/lib/ai-spend-policy']=join(here,'commercial-ai-approved-policy.ts');
  aliases['@/lib/upload-budget-policy']=join(here,'upload-budget-approved-policy.ts');
 }
 if(file==='contract-admission-ack.test.ts'){
  aliases['@/lib/redis']=join(here,'contract-admission-ack-world.ts');
  aliases['@/lib/contract-funding-rules']=join(here,'restart-activation-enabled-rules.ts');
  aliases['@/lib/ai-spend-policy']=join(here,'commercial-ai-approved-policy.ts');
  aliases['@/lib/upload-budget-policy']=join(here,'upload-budget-approved-policy.ts');
 }
 if(file==='restart-recovery-ack.test.ts'){
  aliases['@/lib/redis']=join(here,'restart-recovery-ack-world.ts');
  aliases['@/lib/contract-funding-rules']=join(here,'restart-activation-enabled-rules.ts');
  aliases['@/lib/ai-spend-policy']=join(here,'commercial-ai-approved-policy.ts');
  aliases['@/lib/upload-budget-policy']=join(here,'upload-budget-approved-policy.ts');
 }
 if(file==='restart-result-ack.test.ts'){
  aliases['@/lib/redis']=join(here,'restart-result-ack-world.ts');
  aliases['@/lib/contract-funding-rules']=join(here,'restart-activation-enabled-rules.ts');
  aliases['@/lib/ai-spend-policy']=join(here,'commercial-ai-approved-policy.ts');
  aliases['@/lib/upload-budget-policy']=join(here,'upload-budget-approved-policy.ts');
 }
 if(file==='restart-submission-ack.test.ts'){
  aliases['@/lib/redis']=join(here,'restart-submission-ack-world.ts');
  aliases['@/lib/contract-funding-rules']=join(here,'restart-activation-enabled-rules.ts');
  aliases['@/lib/ai-spend-policy']=join(here,'commercial-ai-approved-policy.ts');
  aliases['@/lib/upload-budget-policy']=join(here,'upload-budget-approved-policy.ts');
 }
 if(file==='quiz-underway-exact.test.ts')aliases['@/lib/studio-route']=join(here,'plan-refund-route-world.ts');
 if(file==='restart-activation-ack.test.ts'){
  aliases['@/lib/redis']=join(here,'restart-activation-ack-world.ts');
  aliases['@/lib/contract-funding-rules']=join(here,'restart-activation-enabled-rules.ts');
  aliases['@/lib/ai-spend-policy']=join(here,'commercial-ai-approved-policy.ts');
  aliases['@/lib/upload-budget-policy']=join(here,'upload-budget-approved-policy.ts');
 }
 if(file==='contract-resource-window.test.ts')aliases['@/lib/redis']=join(here,'contract-resource-redis.ts');
 if(file==='contract-routes.test.ts'){
  aliases['@/lib/contract-funding-rules']=join(here,'contract-funding-approved-policy.ts');
  aliases['@/lib/commercial-margin']=join(here,'contract-commercial-context.ts');
  aliases['@/lib/opening']=join(here,'contract-opening-on.ts');
  aliases['@/lib/studio-route']=join(here,'contract-route-studio.ts');
  aliases['@/lib/billing']=join(here,'contract-route-billing.ts');
  aliases['@/lib/store']=join(here,'contract-route-store.ts');
 }
 if(file==='contract-billing-metadata.test.ts'){
  aliases['@/lib/plan']=join(here,'contract-billing-plan.ts');
  aliases['@/lib/contract-funding']=join(here,'contract-activation-billing.ts');
 }
 if(file==='restart-publication-ack.test.ts'){
  for(const name of ['contract-restart-activation','contract-funding-rules','commercial-margin','redis','store','plan-standing','free-pool-rules','platform-share'])aliases['@/lib/'+name]=join(here,'restart-publication-ack-world.ts');
 }
 if(file==='buyer-actions.test.ts')aliases['@/lib/blob']=join(here,'buyer-actions-blob.ts');
 if(file==='task-hand-in-kept.test.ts'){aliases['@/lib/blob']=join(here,'buyer-actions-blob.ts');aliases['next/headers']=join(here,'security/next-headers.ts');}
 if(file==='task-room-unknown.test.ts'){aliases['@/lib/blob']=join(here,'buyer-actions-blob.ts');aliases['next/headers']=join(here,'security/next-headers.ts');}
 if(file==='task-hand-in-lease.test.ts'){aliases['@/lib/blob']=join(here,'buyer-actions-blob.ts');aliases['next/headers']=join(here,'security/next-headers.ts');}
 if(file==='hand-in-replace-exact.test.ts'){aliases['@/lib/blob']=join(here,'buyer-actions-blob.ts');aliases['next/headers']=join(here,'security/next-headers.ts');}
 if(file==='dispute-purchase-review.test.ts')for(const name of ['store','stripe-account','contract-resource-window','store-allowance'])aliases['@/lib/'+name]=join(here,'dispute-review-world.ts');
 if(file==='dispute-review-route.test.ts')for(const name of ['store-request','dispute-purchase-review','dispute-preorder-review'])aliases['@/lib/'+name]=join(here,'dispute-review-route-world.ts');
 if(file==='dispute-preorder-review.test.ts')for(const name of ['redis','contract-resource-window','store-allowance'])aliases['@/lib/'+name]=join(here,'dispute-preorder-world.ts');
 if(file==='closing-plan-routes.test.ts'){
  aliases['@/lib/studio-route']=join(here,'closing-route-studio.ts');
  aliases['@/lib/opening']=join(here,'closing-route-opening.ts');
  aliases['@/lib/contract-funding']=join(here,'closing-route-funding.ts');
 }
 if(file==='email-disconnect-idempotent.test.ts'){
  aliases['next/server']=join(here,'next-server-after-world.ts');
  aliases['@/lib/account-notice']=join(here,'email-disconnect-world.ts');
 }
 if(['commercial-review-input.test.ts','commercial-terms-snapshot.test.ts','net-margin.test.ts','customer-base.test.ts','plan-revenue-ceilings.test.ts','commercial-ai-coverage.test.ts','exposure-release.test.ts'].includes(file))aliases['@/lib/llc-fixed-costs']=join(here,'llc-fixed-approved-policy.ts');
 if(file==='commercial-llc-costs.test.ts'){
  aliases['@/lib/llc-fixed-costs']=join(here,'llc-retention-approved-policy.ts');
  aliases['@/lib/upload-budget-policy']=join(here,'upload-budget-approved-policy.ts');
  aliases['@/lib/ai-spend-policy']=join(here,'commercial-ai-approved-policy.ts');
 }
 if(["contract-admission-ack.test.ts","contract-funding.test.ts","contract-resource-window.test.ts","contract-routes.test.ts","restart-activation-ack.test.ts","restart-recovery-ack.test.ts","restart-result-ack.test.ts","restart-submission-ack.test.ts"].includes(file))aliases['@/lib/llc-fixed-costs']=join(here,'llc-fixed-approved-policy.ts');
 if(file==='file-download-refusals.test.ts')aliases['@/lib/studio-route']=join(here,'file-download-refusals-world.ts');
 if(file==='ai-counter-admission.test.ts')for(const name of ['redis','store-request','ai'])aliases['@/lib/'+name]=join(here,'ai-counter-admission-world.ts');
 if(file==='visitor-ai-counter-response.test.ts'){for(const name of ['redis','store','store-checkout','catalog','product-about','sales-page-store','answers','store-guide','sales-page'])aliases['@/lib/'+name]=join(here,'visitor-ai-counter-admission-world.ts');aliases['@/components/store-product']=join(here,'visitor-ai-counter-admission-world.ts');}
 if(file==='visitor-ai-counter-admission.test.ts'){for(const name of ['redis','store','store-checkout','catalog','product-about','sales-page-store','answers','store-guide','sales-page'])aliases['@/lib/'+name]=join(here,'visitor-ai-counter-admission-world.ts');aliases['@/components/store-product']=join(here,'visitor-ai-counter-admission-world.ts');}
 if(file==='meta-return-counter-admission.test.ts'){
  for(const name of ['redis','auth','studio-route','store','integration-pause','contract-resource-window','account-notice','team','meet-providers','metered-limits'])aliases['@/lib/'+name]=join(here,'meta-return-counter-world.ts');
  aliases['@/lib/meta-ads']=join(here,'meta-return-provider-world.ts');
  aliases['next/server']=join(here,'next-server-after-world.ts');
 }
 if(file==='form-response-unavailable.test.ts'){
  for(const name of ['next/headers','next/navigation'])aliases[name]=join(here,'form-response-unavailable-world.tsx');
  for(const name of ['studio-route','store-request','form-store','catalog','crm','team','pipeline-access','form-opportunity','form-response-pdf'])aliases['@/lib/'+name]=join(here,'form-response-unavailable-world.tsx');
  for(const name of ['studio-header','studio-store-pin'])aliases['@/components/'+name]=join(here,'form-response-unavailable-world.tsx');
 }
 if(file==='eu-who-answers.test.ts'){aliases['next/headers']=join(here,'security/next-headers.ts');aliases['next/server']=join(here,'next-server-after-world.ts');}
 if(file==='r24-keys-pages-unknown.test.ts'){aliases['next/headers']=join(here,'security/next-headers.ts');aliases['next/server']=join(here,'next-server-after-world.ts');}
 if(file==='assistant-counter-admission.test.ts')for(const name of ['redis','store','store-assistant','metered-limits'])aliases['@/lib/'+name]=join(here,'assistant-counter-admission-world.ts');
 if(file==='embed-library-unknown.test.ts'){aliases['next/headers']=join(here,'security/next-headers.ts');aliases['next/server']=join(here,'next-server-after-world.ts');}
 if(file==='a8-stock-unknown.proof.ts'){aliases['next/headers']=join(here,'security/next-headers.ts');aliases['next/server']=join(here,'next-server-after-world.ts');}
 if(file==='r24-soon-pages-unknown.test.ts'){aliases['next/headers']=join(here,'security/next-headers.ts');aliases['next/server']=join(here,'next-server-after-world.ts');}
 if(file==='r24-soon-partial-callers.test.ts')aliases['next/server']=join(here,'next-server-after-world.ts');
 if(file==='email-platform-target-evidence.test.ts')aliases['@/lib/safe-fetch']=join(here,'email-platform-target-world.ts');
 return aliases;
}
export function testEnvironment(env){return{...env,DEMO_STUDIO_ADMIN:'operator@example.test',STRIPE_DEMO_ACCOUNT_ID:'acct_fixtureDemo',NIMBUS_DATA_KEY:env.NIMBUS_DATA_KEY??'tests-only-not-a-real-deployment-secret'};}
