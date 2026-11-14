import { MemberPriceEditor } from "@/components/member-price-editor";
import { memberEditChoices } from "@/lib/member-price-choices";
import type { Store } from "@/lib/store";

/**
 * The studio's member prices (620 [SZ4], unit 3), as a server part of the
 * settings: it reads what the editor can pick itself, so the page's own JSX
 * gains no await. A read that fails shows that it failed, never an empty
 * store.
 */
export async function MemberPriceSection({ store, connected }: { store: Store; connected: boolean }) {
  const choices = await memberEditChoices(store).catch((error: unknown) => {
    console.error("reading what member prices can pick failed", error);
    return null;
  });
  return <MemberPriceEditor initial={store.memberPrices} currency={store.currency} choices={choices} connected={connected} />;
}
