import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { speech } from "@/lib/buyer-words";
import { discordWords } from "@/lib/buyer-words/discord";
import { SNOWFLAKE } from "@/lib/discord-rules";
import { isResting } from "@/lib/traffic";
import { StoreResting } from "@/components/store-resting";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** The tab's title, in the store's language. */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  let language: unknown;
  try {
    const decoded = decodeURIComponent(handle);
    language = decoded.startsWith("@") ? (await storeForPage(normaliseHandle(decoded)))?.language : undefined;
  } catch {
    language = undefined;
  }
  return { title: discordWords(language).pageTitle, robots: { index: false, follow: false } };
}

/**
 * Where a buyer lands back from Discord's page (app/api/discord/callback):
 * in, with the way to open the server, or why not. In the store's language.
 */
export default async function DiscordPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  // One of the store's public requests, as its other pages take (lib/traffic.ts):
  // past them the page rests with the store (R20 finding 3).
  if (await isResting(store)) return <StoreResting store={store} />;
  const said = speech(store);
  const w = discordWords(store.language);
  const query = await searchParams;
  const status = typeof query.status === "string" ? query.status : "";
  const server = typeof query.server === "string" && SNOWFLAKE.test(query.server) ? query.server : null;
  const joined = status === "joined";
  const notice = joined ? null : (w.notices[status as keyof typeof w.notices] ?? w.notices.expired);

  return (
    <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <div className="st-card p-7 sm:p-10" data-discord-status={joined ? "joined" : status || "expired"}>
          <p className="st-price text-sm">Discord</p>
          {joined ? (
            <>
              <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{w.joinedTitle}</h1>
              <p className="st-muted mt-4 text-lg">{w.joinedBody(store.name)}</p>
              <a href={server ? `https://discord.com/channels/${server}` : "https://discord.com/app"} className="btn st-btn btn-block mt-7" rel="noopener noreferrer">
                {w.openDiscord}
              </a>
              <p className="st-muted mt-5 text-sm">{w.keepNote}</p>
            </>
          ) : notice ? (
            <>
              <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{notice.title}</h1>
              <p className="st-muted mt-4 text-lg">{notice.body}</p>
            </>
          ) : null}
          <p className="mt-7 text-center text-sm">
            <Link href={`/@${store.handle}`} className="st-footer-link font-semibold">{w.backToStore(store.name)}</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
