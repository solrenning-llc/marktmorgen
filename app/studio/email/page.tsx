import { agreementsAllowed } from "@/lib/agreement-rules";
import { requestsOpen } from "@/lib/payment-requests";
import { randomBytes } from "node:crypto";
import { MAIL_TEMPLATES, serializeMailBlocks } from "@/lib/mail-body";
import { storeBase } from "@/lib/purchase-email";
import { starterFlows } from "@/lib/mail-starters";
import { windowId } from "@/lib/allowance-window";
import { WHO, type Who } from "@/lib/contacts";
import { lookColours } from "@/lib/store-look";
import type { Metadata } from "next";
import { aiAvailableFor, aiLeft } from "@/lib/ai";
import { productLink } from "@/lib/checkout-recovery";
import { idsOfKind, readTitles } from "@/lib/catalog";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PLANS_ON_SALE } from "@/lib/opening";
import { countStudio, studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { listCounts } from "@/lib/contacts";
import { type BroadcastHeads, readBroadcastHeads } from "@/lib/broadcasts";
import { letterIdFor, publishedLetters } from "@/lib/letters";
import { broadcastMoney, flowMoney, readMailRevenue, readMailVisits } from "@/lib/mail-revenue";
import { sellsSomething } from "@/lib/mail-starters";
import { readFlowStatsStrict } from "@/lib/flow-stats";
import { readFlowListStrict } from "@/lib/flow-list";
import { inTrial, monthlyAllowance, usedThisMonth } from "@/lib/mail";
import { healthId, listHealth, pauseForSending, pauseWords, pausedFor } from "@/lib/mail-health";
import { HEALTH_NOTE, healthAdvice, healthLevels, healthLine } from "@/lib/mail-health-levels";
import { PRO_MONTHLY_EMAILS, PRO_ON_SALE, hasPro, SCALE_MONTHLY_EMAILS, TRIAL_DAYS, TRIAL_MONTHLY_EMAILS, publishedPriceWords as priceWords, publishedYearSaving as yearSaving } from "@/lib/plan";
import { EmailStudio } from "@/components/email-studio";
import { emailEquivalence } from "@/lib/email-equivalence";
import { readForms } from "@/lib/form-store";
import { readFields, readPipelines } from "@/lib/crm";
import { labeledStages } from "@/lib/crm-rules";
import { listDraftsStrict } from "@/lib/mail-drafts";
import { can } from "@/lib/team-roles";
import { isBillingConfigured, trialOffered } from "@/lib/billing";
import { planDisputed } from "@/lib/plan-dispute-rules";
import { listSegments } from "@/lib/segments";
import { MAX_WAITS_PER_RUN, activeFlowLimit, dailyRunLimit } from "@/lib/flow-limits";
import { listHeld, runsToday } from "@/lib/flow-runs";
import { readTeam } from "@/lib/team";

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

export const metadata: Metadata = {
  title: "Email — Marktmorgen",
  robots: { index: false, follow: false },
};

/** Writing to the people who agreed to hear from the creator. */
export default async function StudioEmailPage({ searchParams }: Params) {
  const query = await searchParams;
  // Which store, and whether this person's role there has "draft" (lib/studio-route.ts).
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "draft");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;

  const allowance = monthlyAllowance(store);
  // The emails are read without their bodies, which this page never shows: the list first, inside this page's own
  // studio requests; then what asking each one's size comes to is taken before it is asked, and what reading them
  // comes to before any is read (lib/broadcasts.ts, readBroadcastHeads).
  const payStudio = async (units: number) => {
    const counted = await countStudio(store, null, units);
    return counted.ok ? ({ ok: true } as const) : ({ ok: false, message: counted.message } as const);
  };
  const [counts, used, listedBroadcasts, loadedFlows, listings, loadedDrafts, pause, health, confirmedPause] = await Promise.all([
    listCounts(store.listId),
    usedThisMonth(store.listId, windowId(store)),
    // A campaign whose record expired (400 days) is gone, known: never "could not be read" forever (main's 57ca6e5a3).
    readBroadcastHeads(store.listId, payStudio, 30, { expired: "skip" }).catch((): BroadcastHeads | null => null),
    readFlowListStrict(store.listId).catch(() => null),
    // The names of the products a flow or a broadcast can be about: one
    // command, where reading every card was one per product (lib/catalog.ts).
    readTitles(store),
    listDraftsStrict(store.listId).catch(() => null),
    // Whether this store's list email is waiting out a week because too many
    // of its addresses bounced or reported it (lib/mail-health.ts).
    pausedFor(healthId(store)),
    // The same seven days the pause reads, said before it comes (599 [KB20], lib/mail-health-levels.ts).
    listHealth(healthId(store)).catch(() => null),
    // Whether no pause is confirmed (null), unlike pausedFor, which says null when it could not read: the
    // health section is shown only then, so a failed read never says "no pause coming" during a pause.
    pauseForSending(healthId(store)).catch(() => undefined),
  ]);
  const levels = health ? healthLevels(health) : null;
  const advice = levels ? healthAdvice(levels.worst, levels.measure) : null;
  const loadedBroadcasts = listedBroadcasts?.ok ? listedBroadcasts.heads : null;
  // Not read because the studio requests reading them comes to are not left: said in words, with why.
  const emailsRefused = listedBroadcasts && !listedBroadcasts.ok ? listedBroadcasts.refused : null;
  const broadcasts = loadedBroadcasts ?? [];
  const flows = loadedFlows ?? [];
  const drafts = loadedDrafts ?? [];
  const role = view.role;
  const emailTemplate = typeof query.emailTemplate === "string" ? MAIL_TEMPLATES.find(item => item.id === query.emailTemplate) : undefined;
  const visiblePaid = idsOfKind(store,"paid").filter(id => !idsOfKind(store,"hidden").includes(id));
  const firstPaid = visiblePaid.find(id => listings.has(id));
  const sequence = loadedFlows && can(role,"send") && (query.sequenceTemplate === "welcome" || query.sequenceTemplate === "bought")
    ? starterFlows({
      fromName:store.mail?.fromName || store.name,storeLink:storeBase(store),ordersLink:storeBase(store)+"/orders",
      product:firstPaid ? {title:listings.get(firstPaid)!,link:productLink(store,firstPaid)} : null,paidCount:visiblePaid.length
    }, flows).find(item => item.starter === query.sequenceTemplate)
    : undefined;
  const initialSequence = sequence ? {name:sequence.name,trigger:sequence.trigger as "joined"|"bought",steps:sequence.steps.map(step => ({...step,id:randomBytes(8).toString("hex")}))} : undefined;

  // What each email sold, from the creator's own Stripe account, cached for
  // ten minutes (lib/mail-revenue.ts). Asked only when something was sent.
  const [stats, revenue, visits] = await Promise.all([
    readFlowStatsStrict(flows).catch(() => null),
    broadcasts.length || flows.length ? readMailRevenue(store) : Promise.resolve(null),
    // And how many times its links opened a page of the store, from the
    // store's own count of visits by tag: nothing in the email reports back.
    readMailVisits(store, broadcasts.filter((b) => b.status === "sent" && b.tagged).map((b) => b.id)),
  ]);
  const trial = allowance > 0 && inTrial(store);
  // Which sent emails are published on the store, and which for members (lib/letters.ts): one read.
  // A failed read is not "not published": the studio says it does not know (null).
  const published = broadcasts.some((b) => b.status === "sent") ? await publishedLetters(store) : new Map<string, { members: boolean }>();
  const letterPath = (id: string) => {
    if (published === null) return null;
    const letter = letterIdFor(store.sid, id);
    return published.has(letter) ? `/@${store.handle}/letters/${letter}` : null;
  };
  const letterMembers = (id: string) => published?.get(letterIdFor(store.sid, id))?.members ?? false;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader
        current={store}
        role={view.role}
        stores={view.stores}
        owned={view.owned}
        action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }}
      />
      <StudioStorePin sid={store.sid}>

      <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
        <p className="eyebrow">Email</p>
        <h1 className="t-h2 mt-3">Write to your list</h1>
        <p className="mt-3 max-w-2xl text-ink-soft">
          Only the people who agreed to hear from you are written to: those who checked the box when they got
          something free or bought from you, and those you import who agreed elsewhere. Every email carries a
          one-click unsubscribe, and anyone who leaves is never written to again.
        </p>

        {allowance === 0 && store.subscriptionActive && hasPro(store.tier) ? (
          // Already on Pro or Scale, and stopped by an unpaid renewal or a disputed plan payment
          // (lib/plan.ts canUse): moving "up to Pro" is not the way back (lib/checkup-rules.ts says the same).
          <div role="status" className="card mt-8 p-6 sm:p-8">
            <p className="text-lg font-semibold tracking-[-0.02em] text-ink">
              {(store.renewalUnpaidSince ?? 0) > 0 || !planDisputed(store)
                ? "Email to your list is stopped: your plan's last renewal is not paid."
                : "Email to your list is stopped while a payment for your plan is disputed."}
            </p>
            <p className="mt-2 text-ink-soft">
              {(store.renewalUnpaidSince ?? 0) > 0 || !planDisputed(store)
                ? "Nothing goes to your list, and your sequences wait, until it is paid. Sign-in links and receipts still go out."
                : "Nothing goes to your list, and your sequences wait, until the dispute is closed. Sign-in links and receipts still go out."}
            </p>
            {isBillingConfigured() && can(role, "billing") ? (
              <a href={`${studioPath(store)}#billing`} className="btn btn-secondary mt-5">See your plan</a>
            ) : null}
          </div>
        ) : allowance === 0 ? (
          <div className="card mt-8 p-6 sm:p-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">Part of Pro</h2>
              <span className="tag tag-brand">{priceWords("pro", "month")}</span>
            </div>
            <ul className="mt-4 space-y-2 text-ink-soft">
              <li>One-off emails to everyone on your list, or only to those who got one product.</li>
              <li>Readers chosen by what they spent with you, where they first found you or when they last bought, saved as groups to use again.</li>
              <li>Emails scheduled for the day and time you choose.</li>
              <li>Sequences that go out by themselves, hours or days after someone joins or buys.</li>
              <li>{`Up to ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")} emails a month, sent from your name, with replies coming to you. ${emailEquivalence(PRO_MONTHLY_EMAILS)}`}</li>
              <li>Import the list you already have, and take it with you as a file whenever you like.</li>
            </ul>
            <p className="mt-4 text-sm text-ink-soft">
              {`${PLANS_ON_SALE ? "" : "When plans open, Pro is "}${priceWords("pro", "month")}, or ${priceWords("pro", "year")} — $${(yearSaving("pro") / 100).toLocaleString("en-US")} less. Everything else in your store stays exactly as it is.`}
            </p>
            {!can(role, "billing") ? (
              <p className="mt-5 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink-soft">
                The store&apos;s owner chooses its plan. When they move it to Pro, email opens here for you too.
              </p>
            ) : !PLANS_ON_SALE || !isBillingConfigured() ? (
              // The checkout and the switch both refuse then (app/api/billing/checkout, app/api/billing/switch),
              // so no button offers either.
              <p className="mt-5 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink-soft">
                Paid plans are not on sale yet, so this store cannot move to Pro for now.
              </p>
            ) : store.subscriptionActive ? (
              store.subscriptionId ? (
                <form action={`/api/billing/switch?store=${store.sid}`} method="post" className="mt-5">
                  <input type="hidden" name="tier" value="pro" />
                  <input type="hidden" name="cycle" value={store.cycle} />
                  <button type="submit" className="btn btn-primary">Move up to Pro</button>
                </form>
              ) : null
            ) : (
              <form action={`/api/billing/checkout?store=${store.sid}`} method="post" className="mt-5 flex flex-col items-start gap-3">
                <input type="hidden" name="tier" value="pro" />
                <button type="submit" name="cycle" value="month" className="btn btn-primary btn-wrap">
                  {trialOffered(store)
                    ? `Start the ${TRIAL_DAYS}-day trial on Pro — ${priceWords("pro", "month")} after that`
                    : `Start Pro — ${priceWords("pro", "month")}, from today`}
                </button>
                <button type="submit" name="cycle" value="year" className="btn btn-secondary btn-wrap">
                  {`Or Pro yearly: ${priceWords("pro", "year")}`}
                </button>
              </form>
            )}
            {PLANS_ON_SALE && trialOffered(store) ? (
              <p className="mt-3 text-sm text-ink-soft">
                {`During the free trial a store sends up to ${TRIAL_MONTHLY_EMAILS.toLocaleString("en-US")} emails a month; the full ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")} opens with the first payment.`}
              </p>
            ) : null}
          </div>
        ) : (
          <>
          {/* Switched off after notices about its content (lib/takedown.ts): nothing is sent, everything waits. */}
          {store.suspended ? (
            <div role="status" className="mt-8 rounded-[var(--r-md)] border border-line bg-sand p-5 text-ink">
              <p className="font-semibold">Email from your store is paused while it is switched off</p>
              <p className="mt-2 text-sm text-ink-soft">
                {`Your store is switched off after notices about its content, so nothing goes out to your list or your community: emails to your list, workflow steps and community announcements wait. They go out by themselves once your store is back on. A workflow step is tried again once a day; a run waits ${MAX_WAITS_PER_RUN} times at the most, then stops at that step, and its history says so.`}
              </p>
            </div>
          ) : null}
          {pause ? (
            <div role="status" className="mt-8 rounded-[var(--r-md)] border border-line bg-sand p-5 text-ink">
              <p className="font-semibold">Email to your list is paused</p>
              <p className="mt-2 text-sm text-ink-soft">{pauseWords(pause)}</p>
              <p className="mt-2 text-sm text-ink-soft">
                {pause.reason === "bounces"
                  ? "This usually means a list brought in from somewhere else held old addresses. You do not need to do anything: you can keep writing and scheduling, and the rest of your store is not affected."
                  : "This usually means people on the list did not expect to hear from you. You can keep writing and scheduling, and the rest of your store is not affected."}
              </p>
            </div>
          ) : null}
          {confirmedPause === null && health && levels && advice ? (
            <section aria-labelledby="mail-health-title" className="mt-8 rounded-[var(--r-md)] border border-line bg-white p-5 text-ink" data-mail-health={levels.worst}>
              <h2 id="mail-health-title" className="text-lg font-semibold">{`Email health: ${advice.title}`}</h2>
              <p className="mt-2 text-sm text-ink-soft">{healthLine(health)}</p>
              <p className="mt-2 text-sm">{advice.text}</p>
              <p className="mt-2 text-sm text-ink-soft">{HEALTH_NOTE}</p>
            </section>
          ) : null}
          {emailsRefused !== null ? (
            <p role="status" className="mt-6 max-w-2xl">
              Your sent and scheduled emails could not be shown: reading them counts as studio requests, and there are not enough left. {emailsRefused}
            </p>
          ) : null}
          {can(role, "send") && broadcasts.some((b) => b.sent > 0) ? (
            <p className="mt-6">
              <a href={studioPath(store, "", "email/links")} className="underline">Change where a link goes in an email you already sent</a>
            </p>
          ) : null}
          {(emailTemplate || query.sequenceTemplate) ? <p role="status" className="card mt-6 p-5 text-sm text-ink-soft">{emailTemplate ? "Library email opened as an unsaved draft. Replace every placeholder and review consent before saving or sending." : initialSequence ? "Library sequence opened as an unsaved paused draft. Review every step before saving; activation is a separate action." : "A new sequence could not be opened: its trigger may already be in use, your role may not allow it, or its records or products could not be confirmed. Existing sequences were preserved."}</p> : null}
          <EmailStudio
            initialTemplate={emailTemplate ? {label:emailTemplate.label,subject:"",body:serializeMailBlocks(emailTemplate.blocks)} : undefined}
            initialSequence={initialSequence}
            accent={lookColours(store.look).accent}
            email={view.email}
            canSend={can(role, "send")}
            canSettings={can(role, "settings")}
            canExport={can(role, "export")}
            drafts={drafts.map(({ id, subject, body, productId, by, savedAt, audience, subjectTest }) => ({ id, subject, body, productId, by, savedAt, subjectTest, ...audience }))}
            name={store.name}
            mail={store.mail}
            counts={counts}
            used={used}
            allowance={allowance}
            monthKnown={windowId(store) !== null}
            trial={trial}
            // The way up for a list that has outgrown Pro, offered beside the
            // month's count to whoever may change the plan (lib/plan.ts).
            moveUp={
              PLANS_ON_SALE && isBillingConfigured() && PRO_ON_SALE && store.tier === "pro" && store.subscriptionActive && can(role, "billing")
                ? {
                    action: `/api/billing/switch?store=${store.sid}`,
                    cycle: store.cycle,
                    price: priceWords("scale", store.cycle),
                    emails: SCALE_MONTHLY_EMAILS,
                    trial,
                  }
                : null
            }
            products={[...listings].map(([id, title]) => ({ id, title }))}
            broadcastsReadFailed={loadedBroadcasts === null}
            broadcasts={broadcasts.map((b) => ({
              id: b.id,
              subject: b.subject,
              status: b.status,
              sendAt: b.sendAt,
              finishedAt: b.finishedAt,
              total: b.total,
              sent: b.sent,
              note: b.note,
              listed: b.listed,
              productId: b.productId,
              who: b.who,
              notProductId: b.notProductId,
              narrow: b.narrow,
              label: b.label ?? null,
              tagged: b.tagged,
              money: broadcastMoney(revenue, b.id),
              visits: visits?.[b.id] ?? null,
              test: b.test,
              published: letterPath(b.id),
              publishedMembers: letterMembers(b.id),
              publishedUnknown: published === null,
            }))}
            currency={store.currency}
            sells={sellsSomething(store)}
            flowsReadFailed={loadedFlows === null}
            draftsReadFailed={loadedDrafts === null}
            flows={flows.map((f) => ({ ...f, statsAvailable: stats?.has(f.id) ?? false, stats: stats?.get(f.id) ?? { started: 0, sent: 0, reached: 0, skipped: 0, acted: 0 }, money: flowMoney(revenue, f.id) }))}
            links={Object.fromEntries([...listings].map(([id]) => [id, productLink(store, id)]))}
            ai={aiAvailableFor(store) && can(role, "draft") ? { on: true, left: await aiLeft(store).catch(() => 0) } : { on: false, left: 0 }}
            segments={await listSegments(store.listId).catch(() => [])}
            preset={typeof query.who === "string" && (WHO as readonly string[]).includes(query.who) ? { who: query.who as Who } : undefined}
            courses={idsOfKind(store, "course")}
            calls={idsOfKind(store, "call")}
            paidProducts={idsOfKind(store, "paid")}
            automation={{
              forms: (await readForms(store.statsId).catch(() => [])).filter((f) => f.fields.some((x) => x.type === "email")).map((f) => ({ id: f.id, name: f.name, outcomes: f.outcomes.map((o) => ({ id: o.id, title: o.title })) })),
              fields: (await readFields(store.statsId).catch(() => [])).map((f) => ({ id: f.id, name: f.name, type: f.type, options: f.options })),
              // Each stage named with its pipeline once there is more than one (lib/crm-rules.ts).
              stages: labeledStages(await readPipelines(store.statsId).catch(() => [])).map((st) => ({ id: st.id, name: st.name })),
              // Whether the plan has proposals and agreements, so a sequence may start when one is signed (635 [GL3]).
              signing: agreementsAllowed(store),
              // Whether the store can take payment requests now (lib/payment-requests.ts), so a sequence may start when one is paid.
              requests: requestsOpen(store),
            }}
            workflowLimits={{
              maxActive: activeFlowLimit(store),
              dailyRuns: dailyRunLimit(store),
              runsToday: await runsToday(store.listId),
              held: can(role, "send") ? ((await listHeld(store.listId, 500).catch(() => null))?.length ?? null) : null,
            }}
            switchedOff={Boolean(store.suspended)}
            assignees={can(role, "send") ? [store.email.toLowerCase(), ...(await readTeam(store.sid).catch(() => ({ members: [] as { email: string; role: Parameters<typeof can>[0] }[] }))).members.filter((m) => can(m.role, "orders")).map((m) => m.email.toLowerCase())] : []}
          />
          </>
        )}
      </main>
      </StudioStorePin>
    </div>
  );
}
