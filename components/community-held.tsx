import type { Store } from "@/lib/store";
import type { Held } from "@/lib/community-approval";
import { approvalWords } from "@/lib/buyer-words/community-approval";
import { Carry, storeWhen } from "@/components/community-parts";

/**
 * A member's own posts, or comments under one post, that wait for the
 * creator's approval (543 [CM2]), and the notes about the ones that were not
 * published. Shown only to their author: the page reads them with heldOf,
 * under the member's own key. The state is said in words, not only by
 * color, and announced to a screen reader with the list's heading.
 *
 * `items` null means they could not be read: said so, never shown as none.
 */
export function HeldList({
  store,
  items,
  kind,
  from,
  post,
  space,
  heading = 2,
}: {
  store: Store;
  items: Held[] | null;
  kind: "post" | "comment";
  from: "feed" | "space" | "post";
  /** The post a comment list sits under, for the form's way back. */
  post?: string;
  space?: string | null;
  /** The heading's level where the list sits: 3 inside a post's comments. */
  heading?: 2 | 3;
}) {
  const w = approvalWords(store.language);
  if (items === null) {
    return (
      <p className="cm-flash cm-flash-warn mb-5" role="status">
        {w.unreadable}
      </p>
    );
  }
  if (!items.length) return null;
  const headingId = `held-${kind}-title`;
  const Heading = heading === 3 ? "h3" : "h2";
  return (
    <section aria-labelledby={headingId} className="mb-6">
      <Heading id={headingId} className="font-display text-lg font-semibold tracking-[-0.02em]">
        {kind === "post" ? w.minePosts : w.mineComments}
      </Heading>
      <ul className="mt-3 space-y-3">
        {items.map((item) => {
          const waiting = item.state === "held";
          const why = item.state === "removed" ? w.removed(item.why) : item.state === "expired" ? w.expired : item.state === "gone" ? w.postGone : w.waitingNote;
          return (
            <li key={item.id} id={`held-${item.id}`} className="st-card scroll-mt-28 p-4 sm:p-5">
              <p className="text-sm font-semibold">
                <strong>{waiting ? w.waiting : w.notPublished}</strong>
                <span className="st-muted font-normal"> · {storeWhen(store, item.at)}</span>
              </p>
              {item.title ? <p className="mt-2 font-semibold break-words">{item.title}</p> : null}
              {item.text ? <p className="mt-1 whitespace-pre-line break-words">{item.text}</p> : null}
              <p className="st-muted mt-2 text-sm">{why}</p>
              <form action="/api/store/community" method="post" className="mt-2" data-confirm={waiting ? w.takeBackSure : undefined}>
                <Carry store={store} action="withdraw" post={post} from={from} space={space} extra={{ item: item.id }} />
                <button type="submit" className="cm-pill">
                  {waiting ? w.takeBack : w.dismiss}
                </button>
              </form>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
