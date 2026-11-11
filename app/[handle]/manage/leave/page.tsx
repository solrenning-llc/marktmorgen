import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { membershipsFor } from "@/lib/membership-manage";
import { answerFor, offers } from "@/lib/leave-rules";
import { choicesFor, liveTiers } from "@/lib/tier-switch";
import { speech } from "@/lib/buyer-words";
import { membershipWords } from "@/lib/buyer-words/membership";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const decoded = decodeURIComponent((await params).handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return {
    title: `${membershipWords(store?.language).leaveTitle} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/**
 * The page a member reaches by pressing Cancel, when the store asks why first
 * (lib/leave-rules.ts). The way out is on it from the first moment; answering
 * is a choice, and an answer is met with what fits it: a cheaper plan, a
 * pause, a way to write to the creator. Opening it reads and changes nothing.
 */
export default async function LeavePage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();

  const query = await searchParams;
  const read = (name: string) => (typeof query[name] === "string" ? (query[name] as string) : "");
  const token = read("token");
  const sub = read("sub");
  const asked = read("why");
  const why = offers(store.leaving, asked) ? asked : "";

  const memberships = token ? await membershipsFor(store, token) : null;
  const one = memberships?.find((m) => m.id === sub) ?? null;
  const say = speech(store);
  const m = membershipWords(store.language);
  const answer = why ? answerFor(why) : null;
  const cheaper = answer?.cheaper && one ? choicesFor(store, one, await liveTiers(store).catch(() => [])).filter((c) => c.way === "down") : [];
  const pause = Boolean(answer?.pause && one && one.canPause && !one.pause && store.pause > 0);
  const contact = answer?.contact
    ? store.contact.on
      ? `/@${store.handle}/contact`
      : `mailto:${store.email}?subject=${encodeURIComponent(one?.title ?? store.name)}`
    : "";
  const manage = `/@${store.handle}/manage${memberships ? `?token=${token}` : ""}`;
  const choices = [
    ...store.leaving.reasons.map((r) => ({ id: r, label: m.leaveReasons[r] })),
    ...store.leaving.own.map((o) => ({ id: o.id, label: o.text })),
  ];
  const endDate = (at: number) => say.date(at * 1000);

  return (
    <div
      lang={say.lang.locale}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <main id="content" className="relative mx-auto max-w-xl px-4 py-14 sm:py-20">
        <div className="text-center">
          {store.photoId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(store.photoId)} alt="" width={72} height={72} className="st-avatar" style={{ width: 72, height: 72 }} />
          ) : (
            <p aria-hidden="true" className="st-avatar st-avatar-initial" style={{ width: 72, height: 72, fontSize: "1.75rem" }}>
              {store.name.slice(0, 1).toUpperCase()}
            </p>
          )}
          <p className="st-muted mt-4 text-sm font-semibold">{store.name}</p>
        </div>

        <div className="st-card mt-6 p-6 sm:p-9" data-leave-page>
          {!memberships ? (
            <>
              <div className="st-note mb-6">
                <h1 className="font-bold" style={{ color: "var(--st-text)" }}>{m.manageNotices.expired.title}</h1>
                <p className="mt-1 text-sm">{m.manageNotices.expired.body}</p>
              </div>
              <Link href={manage} className="btn st-btn btn-block">
                {m.manageHead}
              </Link>
            </>
          ) : !one || one.endsAt !== null ? (
            <>
              <h1 className="st-muted text-lg leading-relaxed">{m.leaveGone}</h1>
              <Link href={manage} className="btn st-btn btn-block mt-6">
                {m.yourMembership}
              </Link>
            </>
          ) : (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">{one.title === m.yourMembership ? m.leaveHeadPlain : m.leaveHead(one.title)}</h1>

              {!why ? (
                <>
                  <p className="st-muted mt-4 leading-relaxed">{m.leaveIntro(store.name)}</p>
                  <form action="/api/store/manage/leave" method="post" className="mt-6">
                    <input type="hidden" name="handle" value={store.handle} />
                    <input type="hidden" name="token" value={token} />
                    <input type="hidden" name="subscription" value={one.id} />
                    <fieldset>
                      <legend className="st-label">{m.leaveAsk}</legend>
                      <div className="mt-2 space-y-1">
                        {choices.map((c) => (
                          <label key={c.id} className="flex min-h-11 cursor-pointer items-center gap-3 text-base" style={{ color: "var(--st-text)" }}>
                            <input type="radio" name="why" value={c.id} required className="h-5 w-5 shrink-0" />
                            <span>{c.label}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <button type="submit" className="btn st-btn btn-block mt-4">
                      {m.leaveContinue}
                    </button>
                  </form>
                </>
              ) : (
                <div className="mt-4 space-y-6" data-leave-answer>
                  <p className="st-muted leading-relaxed">{m.leaveThanks}</p>

                  {cheaper.length ? (
                    <div>
                      <p className="font-bold" style={{ color: "var(--st-text)" }}>{m.leaveCheaper}</p>
                      <ul className="mt-2 space-y-2">
                        {cheaper.map((c) => (
                          <li key={c.id}>
                            <Link
                              prefetch={false}
                              href={`/@${store.handle}/manage/switch?token=${token}&sub=${one.id}&to=${c.id}&from=leave`}
                              className="st-row text-sm"
                            >
                              <span className="basis-full font-bold" style={{ color: "var(--st-text)" }}>{c.title}</span>
                              <span className="st-muted -mt-2 basis-full">{`${c.words}${m.downgrade}`}</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                      <p className="st-muted mt-2 text-xs">{m.exactFirst}</p>
                    </div>
                  ) : null}

                  {pause ? (
                    <form action="/api/store/manage/pause" method="post" className="space-y-2" data-leave-pause>
                      <input type="hidden" name="handle" value={store.handle} />
                      <input type="hidden" name="token" value={token} />
                      <input type="hidden" name="subscription" value={one.id} />
                      <input type="hidden" name="action" value="pause" />
                      <input type="hidden" name="from" value="leave" />
                      <label className="font-bold block" htmlFor="leave-pause-months" style={{ color: "var(--st-text)" }}>
                        {cheaper.length ? m.leavePause : m.leavePauseOnly}
                      </label>
                      <select id="leave-pause-months" name="months" className="st-field" defaultValue="1">
                        {Array.from({ length: store.pause }, (_, i) => i + 1).map((n) => (
                          <option key={n} value={n}>
                            {m.pause.months(n)}
                          </option>
                        ))}
                      </select>
                      <p className="st-muted text-xs">{m.pause.note(one.periodEnd ? endDate(one.periodEnd) : "")}</p>
                      <button type="submit" className="btn st-btn btn-block">
                        {m.pause.confirm}
                      </button>
                    </form>
                  ) : null}

                  {contact ? (
                    <div>
                      <p className="font-bold" style={{ color: "var(--st-text)" }}>{m.leaveContact(store.name)}</p>
                      <a href={contact} className="btn st-btn btn-block mt-2">
                        {m.leaveWrite(store.name)}
                      </a>
                    </div>
                  ) : null}
                </div>
              )}

              {/* The way out, on the page from the first moment: one press, answer or not. */}
              <form action="/api/store/manage/cancel" method="post" className="mt-8 border-t pt-6" style={{ borderColor: "var(--st-line, rgba(0,0,0,.1))" }}>
                <input type="hidden" name="handle" value={store.handle} />
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="subscription" value={one.id} />
                {why ? <input type="hidden" name="why" value={why} /> : null}
                {why ? <p className="font-bold" style={{ color: "var(--st-text)" }}>{m.leaveStill}</p> : null}
                <button type="submit" className="btn btn-secondary btn-block mt-2" data-leave-cancel>
                  {m.leaveCancel}
                </button>
                <p className="st-muted mt-3 text-sm">{`${m.leaveConfirm} ${m.cancelNote}`}</p>
              </form>
            </>
          )}
        </div>

        <div className="mt-8 text-center">
          <Link href={manage} className="st-footer-link text-sm font-semibold">
            {m.yourMembership}
          </Link>
        </div>
      </main>
    </div>
  );
}
