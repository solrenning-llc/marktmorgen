import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { countStudio, studioPath, studioView } from "@/lib/studio-route";
import { BUYER_LEDGER_UNITS } from "@/lib/segments";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { PersonFind } from "@/components/person-find";
import { PersonNotes } from "@/components/person-notes";
import { PersonTasks } from "@/components/person-tasks";
import { PersonCompany } from "@/components/person-company";
import { readCompanies } from "@/lib/crm-companies";
import { type Company, companiesForPerson } from "@/lib/crm-companies-rules";
import { PersonFields } from "@/components/person-fields";
import { PersonErase } from "@/components/person-erase";
import { can } from "@/lib/team-roles";
import { readAllTasks, readFields, readPersonTasks, readValues } from "@/lib/crm";
import { AGENDA_UNITS, PERSON_KEY, addressForPerson, agendaForDays, daysAround, personAddresses } from "@/lib/person-agenda";
import type { PersonTask } from "@/lib/person-tasks";
import { TasksAgendaList } from "@/components/tasks-agenda";
import { readTeam } from "@/lib/team";
import type { CrmField } from "@/lib/crm-rules";
import { type BuyerProfile, type ProfileMembership, type ProfileOrder, SALE_REFERENCE, addressForSale, addressForToken, buyerProfile, findToken } from "@/lib/buyer-profile";
import { channelName } from "@/lib/channel-names";
import { formatMoney } from "@/lib/money";
import { listSales } from "@/lib/store-checkout";
import type { Store } from "@/lib/store";

export const metadata: Metadata = {
  title: "Buyers — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A day from an ISO date kept on a contact; "" when there is none to read. */
const isoDay = (iso: string) => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? day(at / 1000) : "";
};

const NOTE_WORDS: Record<ProfileOrder["note"], string> = {
  "": "",
  gift: "Bought as a gift",
  "for others": "A place for someone else",
  call: "A booked call",
  tip: "Support for your work",
  calls: "A package of calls",
  "pre-order": "Pre-order",
  trial: "Began with a free trial",
  plan: "Payment plan",
  paypal: "Paid with PayPal; the amount is in your PayPal account",
  imported: "Brought over from another platform",
  given: "Given to them as a gift",
};

const KIND_WORDS: Record<ProfileOrder["kind"], string> = {
  sale: "Purchase",
  added: "Added after paying",
  renewal: "Later payment",
  brought: "No payment here",
};

const STATUS_WORDS: Record<ProfileMembership["status"], string> = {
  active: "Paying",
  trialing: "In a free trial",
  past_due: "Latest payment failed; Stripe is retrying",
  paused: "Paused",
  canceling: "Canceled; runs until the end of the period",
  ended: "Ended",
};

/**
 * The buyers of a store, one at a time (lib/buyer-profile.ts). Opened from a
 * sale in the studio (?sale=<Stripe reference>), or from the search on this
 * page (?p=<token>); with neither, the search and the latest buyers.
 */
export default async function StudioPeoplePage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "orders");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;

  const token = typeof query.p === "string" ? query.p : "";
  const sale = typeof query.sale === "string" && SALE_REFERENCE.test(query.sale) ? query.sale : "";
  // A person's key, from a task in the agenda below: their address read again from the store's buyers.
  const who = typeof query.who === "string" && PERSON_KEY.test(query.who) ? query.who : "";
  let email: string | null = null;
  let lookupFailed = false;
  if (token) email = await addressForToken(store, token);
  else if (sale) {
    email = await addressForSale(store, sale).catch((error) => {
      console.error("reading a sale's buyer failed", error);
      lookupFailed = true;
      return null;
    });
  } else if (who) {
    email = await addressForPerson(store, who, countLedger(store)).catch((error) => {
      console.error("reading a task's buyer failed", error);
      lookupFailed = true;
      return null;
    });
  }
  const asked = Boolean(token || sale || who);
  const profile = email ? await buyerProfile(store, email) : null;
  // The store's own fields about each person (lib/crm-rules.ts), and this one's answers.
  const fields = profile ? await readFields(store.statsId) : [];
  const values = profile?.person ? await readValues(store.statsId, profile.person, fields) : {};
  // Tasks about this person (639 [GL7](6)), and who may be made responsible: the owner and teammates who can see orders.
  const [tasks, team, companies] = profile?.person
    ? await Promise.all([readPersonTasks(store.statsId, profile.person).catch(() => null), readTeam(store.sid).catch(() => null), readCompanies(store.statsId).catch(() => null)])
    : [null, null, null];
  const assignees = [store.email.toLowerCase(), ...(team?.members ?? []).filter((m) => can(m.role, "orders")).map((m) => m.email.toLowerCase())];
  // Deleting the person needs the page's token, never the address in a link (lib/person-erasure.ts).
  const mayErase = can(view.role, "erase");
  const eraseToken = profile && email && mayErase ? (token || (await findToken(store, email).catch(() => null)) || "") : "";
  const erased = query.erased === "1";

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
          <p className="eyebrow">Buyers</p>
          {profile ? (
            <Profile store={store} profile={profile} fields={fields} values={values} eraseToken={eraseToken} tasks={tasks} assignees={assignees} companies={companies} />
          ) : (
            <>
              {erased ? (
                <p className="notice notice-success mt-3" role="status">
                  That person was deleted from your store, and your store will not email them again. Their payments stay on your Stripe account.
                  {query.discord === "1" ? " Discord would not take back every role it gave them: remove those in your server." : ""}
                </p>
              ) : null}
              <h1 className="t-h2 mt-3">Everything one buyer has done with your store</h1>
              <p className="mt-2">
                <Link href={studioPath(store, "", "companies")} className="inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4">
                  Companies you sell to
                </Link>
              </p>
              <p className="mt-3 max-w-2xl text-ink-soft">
                What they paid and when, what was given back, where they found you, their memberships, how far they are in
                your courses, the calls coming up, your emails to them, and your team&apos;s notes. Read from your own
                Stripe account each time you open it.
              </p>
              {asked ? (
                <p className="notice notice-warn mt-6" role="status">
                  {lookupFailed
                    ? "Stripe could not be read just now. Nothing was changed. Try again in a moment."
                    : token
                      ? "That search has run out: it works for an hour. Look the address up again below."
                      : who
                        ? "That person is not among the buyers read from your Stripe account just now. Look their address up below."
                        : "That sale is not one of this store's, or it has no email address on it."}
                </p>
              ) : null}
              <section aria-labelledby="find-title" className="card mt-8 p-6 sm:p-8">
                <h2 id="find-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Find a buyer</h2>
                <p className="mt-1 text-sm text-ink-soft">The address they paid with, or the one they joined your list with.</p>
                <div className="mt-4">
                  <PersonFind />
                </div>
              </section>
              <Suspense fallback={<TasksAgendaWaiting />}>
                <TasksAgenda store={store} />
              </Suspense>
              <LatestBuyers store={store} />
            </>
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}

function TasksAgendaWaiting() {
  return (
    <section aria-labelledby="agenda-title" className="card mt-8 p-6 sm:p-8" aria-busy="true">
      <h2 id="agenda-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Tasks to do</h2>
      <p className="mt-2 text-sm text-ink-soft" role="status">Reading your team&apos;s tasks…</p>
    </section>
  );
}

/**
 * Counts reading the store's buyers from Stripe again (BUYER_LEDGER_UNITS
 * studio requests, tests/plan-cost-registry.ts, BUYER_LEDGER), asked only
 * when the ten-minute copy ran out (lib/segments.ts, buyerLedger).
 */
const countLedger = (store: Store) => async () => (await countStudio(store, null, BUYER_LEDGER_UNITS)).ok;

/**
 * Everyone's open tasks (lib/person-tasks.ts), past their date first, each
 * opening the page of the person it is about (lib/person-agenda.ts). The
 * server knows only its own (UTC) day, so the groups are made for each day
 * the creator's may be and the browser shows its own (components/tasks-agenda.tsx).
 */
async function TasksAgenda({ store }: { store: Store }) {
  const today = new Date().toISOString().slice(0, 10);
  // Every task of the store and its rows sent on: AGENDA_UNITS studio requests, counted first (tests/plan-cost-registry.ts, AGENDA_READ).
  const counted = await countStudio(store, null, AGENDA_UNITS).catch(() => null);
  if (!counted?.ok) {
    return (
      <section aria-labelledby="agenda-title" className="card mt-8 p-6 sm:p-8">
        <h2 id="agenda-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Tasks to do</h2>
        <p className="notice notice-warn mt-4">{counted && !counted.ok && counted.message ? counted.message : "Your team's tasks could not be read just now. Nothing was changed. Try again in a moment."}</p>
      </section>
    );
  }
  const all = await readAllTasks(store.statsId).catch((error) => {
    console.error("reading the tasks agenda failed", error);
    return null;
  });
  if (!all) {
    return (
      <section aria-labelledby="agenda-title" className="card mt-8 p-6 sm:p-8">
        <h2 id="agenda-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Tasks to do</h2>
        <p className="notice notice-warn mt-4">Your team&apos;s tasks could not be read just now. Nothing was changed. Try again in a moment.</p>
      </section>
    );
  }
  const agenda = agendaForDays(all, daysAround(today));
  // Only the people of the tasks shown, on any of those days, are looked up.
  const persons = new Set(agenda.rows.map((row) => row.person));
  const found = await personAddresses(store, persons, countLedger(store)).catch((error) => {
    console.error("reading the agenda's buyers failed", error);
    return null;
  });
  const rows = agenda.rows.map((row) => {
    const email = found?.addresses.get(row.person) ?? null;
    return { ...row, email, href: email ? studioPath(store, `who=${row.person}`, "people") : "" };
  });
  const open = all.filter((entry) => !entry.task.done).length;
  return (
    <section aria-labelledby="agenda-title" className="card mt-8 p-6 sm:p-8">
      <h2 id="agenda-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Tasks to do</h2>
      <p className="mt-2 text-sm text-ink-soft">
        {open
          ? `${open} open ${open === 1 ? "task" : "tasks"} across your buyers. Open a person to mark one done or remove it.`
          : "No open tasks. Add one on a person's page, under Tasks."}
      </p>
      {!found && open ? <p className="notice notice-warn mt-4">Stripe could not be read just now, so who each task is about is not shown. Try again in a moment.</p> : null}
      <TasksAgendaList rows={rows} days={agenda.days} serverDay={today} found={found ? { partial: found.partial } : null} />
    </section>
  );
}

/** The newest buyers, each once, opening their page by their latest sale. */
async function LatestBuyers({ store }: { store: Store }) {
  if (!store.stripeAccountId) {
    return <p className="notice notice-info mt-8">Connect your Stripe account, and your latest buyers are listed here.</p>;
  }
  const sold = await listSales(store).catch(() => ({ state: "error" as const }));
  if (sold.state !== "ok") {
    return (
      <p className="notice notice-warn mt-8">
        {sold.state === "error"
          ? "This recent buyer list could not be verified. Check your Stripe dashboard before acting on a purchase."
          : "Recent buyers are unavailable with this store’s current payment setup. Earlier purchases may still be on your Stripe account."}
      </p>
    );
  }
  const seen = new Set<string>();
  const buyers = sold.sales.filter((s) => {
    if (!s.email) return false;
    const key = s.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <section aria-labelledby="latest-title" className="card mt-8 p-6 sm:p-8">
      <h2 id="latest-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Your latest buyers</h2>
      <p className="mt-2 text-sm text-ink-soft">
        A recent view of buyers whose orders include an email address.
        Check your Stripe dashboard for the full history.
      </p>
      {buyers.length === 0 ? (
        <p className="mt-2 text-sm text-ink-soft">No buyer email addresses are available in this recent view. Check your Stripe dashboard for earlier purchases.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {buyers.map((s) => (
            <li key={s.reference} className="flex flex-wrap items-baseline justify-between gap-2 py-3">
              <span className="min-w-0">
                <Link href={studioPath(store, `sale=${s.reference}`, "people")} className="inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4 [overflow-wrap:anywhere]">
                  {s.email}
                </Link>
                <span className="block text-sm text-ink-soft">{`${s.title} · ${day(s.paidAt)}`}</span>
              </span>
              <span className="font-display font-semibold tabular-nums text-ink">{formatMoney(s.amount, s.currency)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Profile({ store, profile, fields, values, eraseToken, tasks, assignees, companies }: { store: Store; profile: BuyerProfile; fields: CrmField[]; values: Record<string, string>; eraseToken: string; tasks: PersonTask[] | null; assignees: string[]; companies: Company[] | null }) {
  const money = (cents: number, currency = profile.currency) => formatMoney(cents, currency);
  const net = profile.paid - profile.refunded;
  const others = Object.entries(profile.otherCurrencies).filter(([, cents]) => cents !== 0);
  const bought = profile.orders.length > 0;
  const tiles = [
    { label: "Spent with you", value: money(net), note: profile.refunded ? `${money(profile.paid)} paid, ${money(profile.refunded)} given back` : "after any refund" },
    { label: "Purchases", value: String(profile.purchases), note: profile.renewals ? `and ${profile.renewals} later ${profile.renewals === 1 ? "payment" : "payments"}` : "no later payments" },
    { label: "First purchase", value: profile.firstAt ? day(profile.firstAt) : "—", note: !profile.channelKnown ? (profile.firstAt ? "channel not recorded" : "nothing bought yet") : profile.firstChannel ? `found you through ${channelName(profile.firstChannel)}` : "came direct, or from somewhere unnamed" },
    { label: "Latest purchase", value: profile.lastAt ? day(profile.lastAt) : "—", note: !profile.channelKnown ? (profile.lastAt ? "channel not recorded" : "nothing bought yet") : profile.lastChannel ? `came through ${channelName(profile.lastChannel)}` : "came direct, or from somewhere unnamed" },
  ];
  const contact = profile.contact;
  const listWords = !contact
    ? "Not on your list."
    : contact.unsub
      ? contact.gone === "bounced"
        ? "Taken off your list: their address could not receive email."
        : contact.gone === "complained"
          ? "Taken off your list: they marked an email as spam."
          : `Left your list${isoDay(contact.unsubAt) ? ` on ${isoDay(contact.unsubAt)}` : ""}. They are not written to again.`
      : contact.agreed
        ? `On your list, and agreed to hear from you${isoDay(contact.agreedAt) ? ` on ${isoDay(contact.agreedAt)}` : ""}.`
        : "On your list, without agreeing to hear from you: only their purchase emails reach them.";

  return (
    <>
      <h1 className="t-h2 mt-3 [overflow-wrap:anywhere]">{profile.name || profile.email}</h1>
      <p className="mt-2 text-ink-soft [overflow-wrap:anywhere]">
        <a href={`mailto:${profile.email}`} className="inline-flex min-h-11 items-center underline underline-offset-4">{profile.name ? profile.email : "Email them"}</a>
        {" · "}
        <Link href={studioPath(store, "", "people")} className="inline-flex min-h-11 items-center underline underline-offset-4">Find another buyer</Link>
      </p>

      {profile.stripeError ? (
        <p className="notice notice-error mt-6" role="alert">
          Stripe could not be read just now, so their payments are not on this page. Nothing was changed. Try again in a moment.
        </p>
      ) : !store.stripeAccountId ? (
        <p className="notice notice-info mt-6">Connect your Stripe account, and what they paid is shown here.</p>
      ) : null}

      <dl className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="card p-5">
            <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-mute">{t.label}</dt>
            <dd className="mt-2 text-2xl font-semibold tabular-nums text-ink">{t.value}</dd>
            <dd className="mt-1 text-sm text-ink-soft">{t.note}</dd>
          </div>
        ))}
      </dl>
      {others.length ? (
        <p className="mt-3 text-sm text-ink-soft">
          {`Also paid in another currency, not in the sums above: ${others.map(([currency, cents]) => money(cents, currency)).join(", ")}.`}
        </p>
      ) : null}

      <section aria-labelledby="orders-title" className="card mt-8 p-6 sm:p-8">
        <h2 id="orders-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">What they bought and paid</h2>
        {!bought ? (
          <p className="mt-2 text-sm text-ink-soft">Nothing bought from this store under this address.</p>
        ) : (
          <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-labelledby="orders-title">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-[0.08em] text-ink-mute">
                  <th scope="col" className="py-2 pr-4 font-semibold">Day</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">What</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Channel</th>
                  <th scope="col" className="py-2 text-right font-semibold">Paid</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {profile.orders.map((o, i) => (
                  <tr key={`${o.reference}-${i}`}>
                    <td className="whitespace-nowrap py-2.5 pr-4 align-top tabular-nums text-ink-soft">{day(o.at)}</td>
                    <td className="py-2.5 pr-4 align-top">
                      <span className="font-semibold text-ink">{o.title}</span>
                      <span className="block text-xs text-ink-soft">
                        {[KIND_WORDS[o.kind], NOTE_WORDS[o.note]].filter(Boolean).join(" · ")}
                        {o.refunded > 0 ? ` · ${o.refunded >= o.cents ? "Refunded" : `${money(o.refunded, o.currency)} refunded`}` : ""}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 align-top text-ink-soft">
                      {o.kind !== "sale" ? "—" : o.recorded ? channelName(o.channel) : "Not recorded"}
                      {o.kind === "sale" && o.campaign ? <span className="block text-xs">{o.campaign}</span> : null}
                    </td>
                    <td className="whitespace-nowrap py-2.5 text-right align-top tabular-nums">
                      {o.kind === "brought" ? "—" : money(o.cents, o.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-soft">
          Amounts are what they paid, after any discount code and before Stripe&apos;s fee.
          {profile.partial ? " Stripe holds more of their payments than one reading takes, so the oldest are not shown or counted." : ""}
          {bought && !profile.channelKnown ? " Sales from before October 11, 2026 have no channel written on them." : ""}
        </p>
      </section>

      {profile.memberships.length ? (
        <section aria-labelledby="members-title" className="card mt-8 p-6 sm:p-8">
          <h2 id="members-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Memberships and payment plans</h2>
          <ul className="mt-4 divide-y divide-line">
            {profile.memberships.map((m, i) => (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm">
                <span className="font-semibold text-ink">{m.title}</span>
                <span className="text-ink-soft">
                  {`${STATUS_WORDS[m.status]} · since ${day(m.since)}${m.until ? `${m.status === "ended" ? ", ended" : ", until"} ${day(m.until)}` : ""}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {profile.courses.length ? (
        <section aria-labelledby="courses-title" className="card mt-8 p-6 sm:p-8">
          <h2 id="courses-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Their courses</h2>
          <ul className="mt-4 space-y-4">
            {profile.courses.map((c, i) => {
              const share = c.lessons ? Math.round((c.done / c.lessons) * 100) : 0;
              return (
                <li key={i} className="text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-semibold text-ink">{c.title}</span>
                    <span className="tabular-nums text-ink-soft">{`${c.done} of ${c.lessons} ${c.lessons === 1 ? "lesson" : "lessons"} done`}</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-sand" role="img" aria-label={`${share}% of the lessons done`}>
                    <div className="h-full rounded-full bg-violet-brand" style={{ width: `${share}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-ink-soft">
                    {c.lastSeen ? `Last opened ${day(c.lastSeen)}` : "Not opened yet"}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {profile.calls.length ? (
        <section aria-labelledby="calls-title" className="card mt-8 p-6 sm:p-8">
          <h2 id="calls-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Calls coming up</h2>
          <ul className="mt-4 divide-y divide-line">
            {profile.calls.map((c) => (
              <li key={c.session} className="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm">
                <span className="font-semibold text-ink">{c.title}</span>
                <span className="tabular-nums text-ink-soft">
                  {new Date(c.start).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="mail-title" className="card mt-8 p-6 sm:p-8">
        <h2 id="mail-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Your emails to them</h2>
        <p className="mt-2 text-sm text-ink-soft">{listWords}</p>
        {profile.sequences.length ? (
          <p className="mt-2 text-sm text-ink-soft">{`Started on ${profile.sequences.length === 1 ? "the sequence" : "the sequences"}: ${profile.sequences.join(", ")}.`}</p>
        ) : null}
        {contact && contact.tags.length ? (
          <p className="mt-2 text-sm text-ink-soft">{`Labels, from your import, a sequence or the API: ${contact.tags.join(", ")}.`}</p>
        ) : null}
      </section>

      <section aria-labelledby="fields-title" className="card mt-8 p-6 sm:p-8">
        <h2 id="fields-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Your fields</h2>
        <p className="mt-1 text-sm text-ink-soft">
          What you keep about each person, in fields of your own. They go into your list&apos;s file as columns.{" "}
          <Link href={studioPath(store, "", "deals")} className="underline underline-offset-4">
            {fields.length ? "Change the fields" : "Make your first field"}
          </Link>
        </p>
        {profile.person && fields.length ? <PersonFields key={profile.person} person={profile.person} fields={fields} initial={values} /> : null}
      </section>

      <section aria-labelledby="company-title" className="card mt-8 p-6 sm:p-8">
        <h2 id="company-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Company</h2>
        {profile.person && companies ? (
          <PersonCompany key={profile.person} person={profile.person} initial={companiesForPerson(companies, profile.person)} />
        ) : profile.person ? (
          <p className="mt-2 text-sm text-ink-soft" role="status">This person&apos;s company could not be read just now. Open this page again in a moment.</p>
        ) : null}
      </section>

      <section aria-labelledby="tasks-title" className="card mt-8 p-6 sm:p-8">
        <h2 id="tasks-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Tasks</h2>
        <p className="mt-1 text-sm text-ink-soft">What you still owe this person, beside any deal. For you and your team only.</p>
        {profile.person && tasks ? (
          <PersonTasks key={profile.person} person={profile.person} initial={tasks} assignees={assignees} today={new Date().toISOString().slice(0, 10)} />
        ) : profile.person ? (
          <p className="mt-2 text-sm text-ink-soft" role="status">This person&apos;s tasks could not be read just now. Open this page again in a moment.</p>
        ) : null}
      </section>

      <section aria-labelledby="notes-title" className="card mt-8 p-6 sm:p-8">
        <h2 id="notes-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Notes</h2>
        <p className="mt-1 text-sm text-ink-soft">For you and your team only. The buyer never sees them.</p>
        {profile.person ? <PersonNotes person={profile.person} initial={profile.notes} /> : null}
      </section>

      {eraseToken ? (
        <section aria-labelledby="erase-title" className="card mt-8 p-6 sm:p-8">
          <h2 id="erase-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Delete this person</h2>
          <p className="mt-1 text-sm text-ink-soft">
            When someone asks you to delete their data, or you no longer want to keep it: their records go from every part of your store, and your store never emails them again. People can also do it themselves from your store&apos;s privacy link.
          </p>
          <PersonErase token={eraseToken} email={profile.email} />
        </section>
      ) : null}
    </>
  );
}
