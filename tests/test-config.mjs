import {join} from 'node:path';
/** One wiring source for the repository runner and local parallel verification. */
export function testAliases(file,root,here){
 const aliases={'@':root,'@/lib/redis':['range-traffic-coverage.test.ts','stats-traffic-coverage.test.ts'].includes(file)?join(root,'lib/redis.ts'):join(here,'redis-stub.ts')};
 if(file==='meeting-withdrawal-page.test.ts'){
  for(const name of ['next/headers','next/navigation'])aliases[name]=join(here,'meeting-withdrawal-page-world.ts');
  for(const name of ['studio-header','studio-store-pin'])aliases['@/components/'+name]=join(here,'meeting-withdrawal-page-world.ts');
  aliases['next/server']=join(here,'next-server-after-world.ts');
  aliases['@/lib/account-notice']=join(here,'meeting-disabled-world.ts');
 }
 if(file==='failure-cleanup-paths.test.ts'||file==='picture-owner-paths.test.ts')for(const name of ['@/lib/blob','@vercel/blob/client'])aliases[name]=join(here,'failure-cleanup-world.ts');
 if(file==='meeting-disabled-settings.test.ts')aliases['next/navigation']=join(here,'next-navigation-stub.ts');
 if(file==='zoom-arrival.test.ts')aliases['next/navigation']=join(here,'meeting-withdrawal-page-world.ts');
 if(file==='meeting-disabled-withdrawal.test.ts'){
  aliases['next/server']=join(here,'next-server-after-world.ts');
  for(const name of ['meet-test','account-notice'])aliases['@/lib/'+name]=join(here,'meeting-disabled-world.ts');
 }
 if(file==='host-calendar-removal.test.ts')aliases['@/lib/host-calendar']=join(here,'host-calendar-removal-world.ts');
 if(file==='mail-check-route.test.ts')for(const name of ['request-guard','email','verify-mail'])aliases['@/lib/'+name]=join(here,'mail-check-route-world.ts');
 if(file==='plan-break-off-cron.test.ts')for(const name of ['request-guard','billing-reminders','trial-nudges','payment-requests'])aliases['@/lib/'+name]=join(here,'plan-break-off-cron-world.ts');
 if(file==='plan-refund-route.test.ts')aliases['@/lib/studio-route']=join(here,'plan-refund-route-world.ts');
 if(file==='plan-refund-page.test.ts'){
  aliases['@/lib/studio-route']=join(here,'plan-refund-route-world.ts');
  for(const name of ['next/headers','next/navigation'])aliases[name]=join(here,'meeting-withdrawal-page-world.ts');
  for(const name of ['studio-header','studio-store-pin'])aliases['@/components/'+name]=join(here,'meeting-withdrawal-page-world.ts');
 }
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
 if(file==='path-wording-provider.test.ts'){
  aliases['@/lib/redis']=join(here,'path-wording-provider-world.ts');
  aliases['@/lib/ai-spend']=join(root,'lib/ai-spend.ts');
 }
 if(file==='path-growth-facts.test.ts')for(const name of ['redis','catalog','broadcasts','reviews'])aliases['@/lib/'+name]=join(here,'path-growth-world.ts');
 if(file==='path-reminder-push.test.ts')aliases['@/lib/web-push']=join(here,'path-push-world.ts');
 if(file==='digital-consent.test.ts')aliases['next/server']=join(here,'next-server-after-world.ts');
 if(file==='cart-physical.test.ts')aliases['next/server']=join(here,'next-server-after-world.ts');
 if(file==='review-photo-paused.test.ts')aliases['next/server']=join(here,'next-server-after-world.ts');
 if(file==='deals-board-pipelines-render.test.ts')aliases['next/navigation']=join(here,'next-navigation-stub.ts');
 if(file==='mail-reservation.test.ts'){aliases['@/lib/email']=join(here,'mail-reservation-email.ts');aliases['@/lib/ses']=join(here,'mail-reservation-ses.ts');}
 if(file==='traffic-admission.test.ts')for(const name of ['redis','store','delivery','secret-box'])aliases['@/lib/'+name]=join(here,'traffic-admission-world.ts');
 if(['upload-budget.test.ts','automatic-upload-budget.test.ts'].includes(file))aliases['@/lib/redis']=join(here,'upload-budget-redis.ts');
 if(['commercial-terms-snapshot.test.ts','net-margin.test.ts','customer-base.test.ts','plan-revenue-ceilings.test.ts','commercial-ai-coverage.test.ts'].includes(file))aliases['@/lib/upload-budget-policy']=join(here,'upload-budget-approved-policy.ts');
 if(['commercial-terms-snapshot.test.ts','net-margin.test.ts','customer-base.test.ts','plan-revenue-ceilings.test.ts','commercial-ai-coverage.test.ts'].includes(file))aliases['@/lib/ai-spend-policy']=join(here,'commercial-ai-approved-policy.ts');
 if(file==='ai-spend-provider.test.ts')aliases['@/lib/ai-spend-policy']=join(here,'ai-spend-approved-policy.ts');
 if(['video-admission.test.ts','video-tier.test.ts'].includes(file)){aliases['@/lib/redis']=join(here,'video-admission-redis.ts');aliases['@/lib/stream']=join(here,'video-admission-stream.ts');}
 if(file==='storage-measurement.test.ts')for(const name of ['blob','vault','stream'])aliases['@/lib/'+name]=join(here,'storage-provider-stub.ts');
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
 if(['commercial-terms-snapshot.test.ts','net-margin.test.ts','customer-base.test.ts','plan-revenue-ceilings.test.ts','commercial-ai-coverage.test.ts','exposure-release.test.ts'].includes(file))aliases['@/lib/llc-fixed-costs']=join(here,'llc-fixed-approved-policy.ts');
 if(file==='commercial-llc-costs.test.ts'){
  aliases['@/lib/llc-fixed-costs']=join(here,'llc-retention-approved-policy.ts');
  aliases['@/lib/upload-budget-policy']=join(here,'upload-budget-approved-policy.ts');
  aliases['@/lib/ai-spend-policy']=join(here,'commercial-ai-approved-policy.ts');
 }
 if(["contract-admission-ack.test.ts","contract-funding.test.ts","contract-resource-window.test.ts","contract-routes.test.ts","restart-activation-ack.test.ts","restart-recovery-ack.test.ts","restart-result-ack.test.ts","restart-submission-ack.test.ts"].includes(file))aliases['@/lib/llc-fixed-costs']=join(here,'llc-fixed-approved-policy.ts');
 return aliases;
}
export function testEnvironment(env){return{...env,DEMO_STUDIO_ADMIN:'operator@example.test',STRIPE_DEMO_ACCOUNT_ID:'acct_fixtureDemo',NIMBUS_DATA_KEY:env.NIMBUS_DATA_KEY??'tests-only-not-a-real-deployment-secret'};}
