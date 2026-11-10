import Link from "next/link";
import { sectionId } from "@/components/legal-page";
import { ENDED_STORE_EXPORTS } from "@/lib/plan-closing-rules";
import type { PrivacyChoices } from "@/lib/studio-privacy";

const LINK = "inline-flex min-h-11 items-center font-bold text-ink underline underline-offset-4";
const RIGHTS = `/privacy#${sectionId("8. Your rights, including under the GDPR")}`;

/**
 * The studio's Privacy page (757 [STN4] unit 4): the person's own data and logins in one place. Every
 * control here already works elsewhere in the studio; this page adds no new data handling. A plain
 * server-drawn page: links and forms only, so it works without JavaScript, with no time limit.
 */
export function StudioPrivacy({
  email,
  sid,
  studioHref,
  devicesHref,
  choices,
}: {
  email: string;
  sid: string;
  /** The studio home of this store. */
  studioHref: string;
  /** The page that asks before it logs out the other devices. */
  devicesHref: string;
  choices: PrivacyChoices;
}) {
  return (
    <main id="content" className="container-page max-w-3xl pb-20 pt-10 sm:pt-14">
      <p className="eyebrow">Your account</p>
      <h1 className="t-h2 mt-3">Privacy</h1>
      <p className="mt-6 max-w-2xl text-ink-soft">
        Your own data and your logins, in one place. Nothing changes until you press a button.
      </p>
      <p className="mt-3 max-w-2xl text-ink-soft [overflow-wrap:anywhere]">
        {"You log in as "}
        <strong className="text-ink">{email}</strong>.
      </p>

      <section aria-labelledby="privacy-data" className="mt-10">
        <h2 id="privacy-data" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          A copy of your data
        </h2>
        {choices.data === "file" ? (
          <>
            <p className="mt-2 max-w-2xl text-ink-soft">
              One file with your store&rsquo;s page, products, posts, the text of your courses, forms and their answers, contacts and a summary of your orders. Files and videos download from their own pages. It is counted from your studio&rsquo;s requests by its size.
            </p>
            {/* A GET form, not a link: a link may be prefetched, and each prefetch would read the whole store. */}
            <form action="/api/store/export" method="get" className="mt-4 max-w-full">
              <input type="hidden" name="store" value={sid} />
              <input type="hidden" name="what" value="store" />
              <button type="submit" className="btn btn-primary">
                Download my store&rsquo;s data
              </button>
            </form>
          </>
        ) : choices.data === "after-plan" ? (
          <p className="mt-2 max-w-2xl text-ink-soft">
            {`The file can be downloaded while your store has a plan or a free trial. After a plan ends, a store that is closing can download it ${ENDED_STORE_EXPORTS === 1 ? "once more" : `${ENDED_STORE_EXPORTS} more times`}, from the closing notice on your studio home.`}
          </p>
        ) : (
          <p className="mt-2 max-w-2xl text-ink-soft">The store&rsquo;s owner and its admins can download it.</p>
        )}
      </section>

      <section aria-labelledby="privacy-logins" className="mt-10">
        <h2 id="privacy-logins" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Where you are logged in
        </h2>
        <ul className="mt-2 max-w-2xl space-y-4">
          <li>
            <Link href={devicesHref} className={LINK}>
              Log out of other devices
            </Link>
            <p className="text-ink-soft">You stay logged in here. The next page asks before it logs anything out.</p>
          </li>
          <li>
            <form action="/api/auth/signout-all" method="post">
              <button type="submit" className="btn btn-secondary">
                Log out of all devices
              </button>
            </form>
            <p className="mt-1 text-ink-soft">This one logs you out here too, at once. To come back, log in again.</p>
          </li>
          <li>
            <Link href={`${studioHref}#account`} className={LINK}>
              Passkeys, two-step login and your recovery address
            </Link>
            <p className="text-ink-soft">On your studio home, under &ldquo;The email that logs you in&rdquo;.</p>
          </li>
        </ul>
      </section>

      <section aria-labelledby="privacy-delete" className="mt-10">
        <h2 id="privacy-delete" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Deleting
        </h2>
        {choices.deleteStore === "here" ? (
          <>
            <p className="mt-2 max-w-2xl text-ink-soft">
              A store can be deleted only while it has no products, no plan running and no domain of its own. Your studio home says what is left to remove.
            </p>
            <Link href={`${studioHref}#delete-store`} className={LINK}>
              Delete this store, on your studio home
            </Link>
          </>
        ) : choices.deleteStore === "first" ? (
          <p className="mt-2 max-w-2xl text-ink-soft">Your first store has no delete button in the studio.</p>
        ) : (
          <p className="mt-2 max-w-2xl text-ink-soft">
            Only the store&rsquo;s owner can delete it. To leave it, use &ldquo;Leaving this store&rdquo; on your studio home.
          </p>
        )}
        <p className="mt-4 max-w-2xl text-ink-soft">
          {"There is no button to delete your whole account. To ask us to delete it, with what we keep about you, email "}
          <a href="mailto:support@marktmorgen.com" className={LINK}>
            support@marktmorgen.com
          </a>
          {" from the address you log in with."}
        </p>
        <Link href={RIGHTS} className={LINK}>
          What you can ask us for, in the Privacy Policy
        </Link>
      </section>

      <section aria-labelledby="privacy-kept" className="mt-10">
        <h2 id="privacy-kept" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          What we keep and why
        </h2>
        <ul className="mt-2 max-w-2xl space-y-1">
          <li>
            <Link href="/privacy" className={LINK}>
              The whole Privacy Policy
            </Link>
          </li>
          <li>
            <Link href="/privacy#signing-in" className={LINK}>
              What logging in keeps about you
            </Link>
          </li>
          <li>
            <Link href="/privacy#closed-stores" className={LINK}>
              What happens to a store&rsquo;s data when it closes
            </Link>
          </li>
        </ul>
      </section>
    </main>
  );
}
