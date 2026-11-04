import type { Metadata } from "next";
import { connection } from "next/server";
import { cache } from "react";
import { type Store, normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { joinOpen } from "@/lib/store-join";
import { joinWords } from "@/lib/buyer-words/join";
import { speech } from "@/lib/buyer-words";
import { canWrite } from "@/lib/mail";
import { ClicksBox } from "@/components/store-product";
import { scriptMode, withTags } from "@/lib/embed-sites";
import { readScriptOpen } from "@/lib/embed-open";
import { EmbedMessenger } from "@/components/embed-messenger";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** The answers the sign-up route sends back here (app/api/store/join), and what the page says to each. */
const STATUSES = ["sent", "email", "limited", "closed", "error"] as const;

/** Its height in a frame: the form, its box and its line, or the answer. */
const FRAME_HEIGHT = 420;

const load = cache(async (raw: string): Promise<Store | null> => {
  let decoded = "";
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const store = await storeForPage(normaliseHandle(decoded.replace(/^@/, ""))).catch(() => null);
  return store && !store.suspended ? store : null;
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const store = await load((await params).handle);
  return { title: store ? `${joinWords(store.language).pageTitle} — ${store.name}` : "Email list", robots: { index: false, follow: false } };
}

/**
 * The store's sign-up form, opened by the checkout script (lib/embed-sdk.ts)
 * over a page of the creator's own site, or as a page of its own.
 *
 * It is the store page's sign-up box (components/store-join-box.tsx) and goes
 * the same way: the address joins the creator's list only once the button in
 * the email it is sent has been pressed (lib/store-join.ts), with the same
 * limits per connection and per inbox. Its second box starts empty. What the
 * route answers comes back here, and in a frame on a site the creator listed
 * the page is told it ("optin", with "sent" meaning the email is on its way);
 * once the address is confirmed, the store's list.joined webhook says so to
 * the creator's server (lib/webhooks.ts).
 *
 * On a site the creator did not list, past the store's visits or past the
 * opens one connection gets (lib/embed-open.ts), it shows a link to the
 * store's page instead, where the same box is.
 */
export default async function EmbedJoin({ params, searchParams }: Params) {
  await connection();
  const store = await load((await params).handle);
  const query = await searchParams;
  const mode = scriptMode(query.mm) ?? "page";
  const framed = mode === "overlay";
  const status = typeof query.status === "string" && (STATUSES as readonly string[]).includes(query.status) ? query.status : "";

  const shell = (body: React.ReactNode, lang: string, look: React.CSSProperties, theme: string) =>
    framed ? (
      <div lang={lang} className={`st-page st-theme-${theme} h-screen`} style={{ ...look, background: "transparent" }}>
        <style>{"html,body{background:transparent!important;min-height:0!important;height:100%;margin:0}"}</style>
        <div className="st-card flex h-full flex-col justify-center overflow-hidden p-6" style={{ boxShadow: "none" }}>
          {body}
        </div>
      </div>
    ) : (
      <div lang={lang} className={`st-page st-theme-${theme} flex min-h-screen items-center justify-center px-4 py-10`} style={look}>
        <main id="content" className="st-card w-full max-w-[440px] p-7">
          {body}
        </main>
      </div>
    );

  if (!store) {
    return shell(<p className="st-muted text-sm">{joinWords("en").notices.closed.title}</p>, "en", {}, "light");
  }

  const open = await readScriptOpen(store, mode, query);
  const w = joinWords(store.language);
  const said = speech(store);
  const look = lookStyle(store.look) as React.CSSProperties;
  const aside = framed ? { target: "_blank", rel: "noopener" } : { target: "_top" };
  const storeLink = withTags(`/@${store.handle}`, open.tags);
  const talking = framed && open.live && open.site ? open.site : null;
  const backHost = open.back ? new URL(open.back).hostname : "";
  const back =
    open.back && !framed ? (
      <a href={open.back} target="_top" className="st-footer-link mt-6 inline-block text-sm font-semibold">
        {said.w.backTo(backHost)}
      </a>
    ) : null;

  if (status) {
    const notice = status === "sent" ? { title: w.sentTitle, body: w.sentBody(store.name) } : w.notices[status] ?? w.notices.error;
    return shell(
      <>
        {status === "sent" ? <p className="st-price text-sm">{w.almost}</p> : null}
        <h1 className="font-display mt-3 text-2xl font-semibold leading-tight">{notice.title}</h1>
        <p className="st-muted mt-3">{notice.body}</p>
        {status === "sent" ? <p className="st-muted mt-3 text-sm">{w.sentNote}</p> : null}
        {back}
        {talking ? <EmbedMessenger to={talking} height={FRAME_HEIGHT} status={status} /> : null}
      </>,
      said.lang.locale,
      look,
      store.look.theme,
    );
  }

  if (!open.live || !joinOpen(store)) {
    return shell(
      <>
        <h1 className="font-display text-xl font-semibold leading-snug">{store.join.heading || w.heading}</h1>
        {joinOpen(store) ? (framed ? <p className="st-muted mt-2">{said.w.cardOpens(store.name)}</p> : null) : <p className="st-muted mt-2">{w.notices.closed.title}</p>}
        <a href={storeLink} {...aside} className="btn st-btn mt-5">
          {said.w.seeStore(store.name)}
        </a>
      </>,
      said.lang.locale,
      look,
      store.look.theme,
    );
  }

  return shell(
    <>
      <h1 className="font-display text-xl font-semibold leading-snug">{store.join.heading || w.heading}</h1>
      <p className="st-muted mt-2">{store.join.line || w.line(store.name)}</p>
      <form action="/api/store/join" method="post" className="mt-5">
        <input type="hidden" name="handle" value={store.handle} />
        <input type="hidden" name="embed" value={mode} />
        {open.site ? <input type="hidden" name="site" value={open.site} /> : null}
        {open.back ? <input type="hidden" name="return" value={open.back} /> : null}
        {Object.entries(open.tags).map(([name, value]) => (value ? <input key={name} type="hidden" name={name} value={value} /> : null))}
        {/* Left empty by a person; filled in by something that fills in every field. */}
        <div aria-hidden="true" className="hidden">
          <label>
            {said.w.leaveEmpty}
            <input type="text" name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
        <label htmlFor="embed-join-email" className="sr-only">
          {w.label}
        </label>
        <div className="flex flex-col gap-2">
          {/* A plain field here: the frame on the creator's site has a fixed height, and the suggestion line would be cut off in it (308 [TC1]). */}
          <input id="embed-join-email" type="email" name="email" required maxLength={254} autoComplete="email" placeholder={said.w.emailPlaceholder} className="st-field min-w-0" />
          <button type="submit" className="btn st-btn btn-block">
            {w.button}
          </button>
        </div>
        {/* Joining is the yes to the list; this one is its own, and starts empty. */}
        {canWrite(store) ? <ClicksBox id="embed-join-clicks" label={said.w.alsoClicks(store.mail?.fromName || store.name)} className="mt-3" always /> : null}
      </form>
      {back}
      {talking ? <EmbedMessenger to={talking} height={FRAME_HEIGHT} /> : null}
    </>,
    said.lang.locale,
    look,
    store.look.theme,
  );
}
