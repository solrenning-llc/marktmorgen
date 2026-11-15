import Link from "next/link";
import { PendingSubmit } from "@/components/pending-submit";
import { lookStyle } from "@/lib/store-look";
import { speech } from "@/lib/buyer-words";
import { openLinkWords } from "@/lib/buyer-words/open-link";
import type { Store } from "@/lib/store";

/**
 * The page an emailed community, course or letter link lands on (MM-SA-41,
 * MM-SA-53): landing
 * here spends nothing, and the one button posts the link's token back to its
 * route, which spends one open and gives this browser the store's pass. Mail
 * filters open every link in a message to check it; only a person's tap
 * makes the POST. One heading, one sentence, one button, and why it is asked.
 */
export function OpenLinkTap({ store, token, kind }: { store: Store; token: string; kind: "community" | "course" | "letters" }) {
  const say = speech(store);
  const words = openLinkWords(store.language);
  const complete = /^[0-9a-f]{64}$/.test(token);
  return (
    <div lang={say.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <div className="st-card p-7 sm:p-10">
          <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{words.heading}</h1>
          {complete ? (
            <>
              <p className="st-muted mt-4 text-lg">{words.lead(store.name)}</p>
              <form method="post" action={`/api/store/${kind}/open`} className="mt-7">
                <input type="hidden" name="token" value={token} />
                <PendingSubmit label={kind === "community" ? words.community : kind === "course" ? words.course : words.letter} pending={words.pending} className="btn st-btn btn-lg btn-block" />
              </form>
              <p className="st-muted mt-6 text-sm">{words.why}</p>
            </>
          ) : (
            <p className="st-muted mt-4 text-lg">{words.bad}</p>
          )}
          <div className="mt-8">
            <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
              {say.w.backTo(store.name)}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
