"use client";

import { useId, useState } from "react";
import { GONE_PRODUCT, PREVIEW_LEAVES_OUT, type Unlock, previewLine, previewLocked, previewName, previewSpaces } from "@/lib/community-gate";
import { LockedSpaces } from "@/components/community-locked";
import { LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { type LookPaint, lookStyle } from "@/lib/store-look";

type PreviewSpace = { id: string; name: string; about: string; only: string[]; shown?: true };

/** What the studio page worked out for the locked spaces (unlocksOf), and how the store's pages look and speak. */
export type LockedPreviewData = { unlocks: Record<string, Unlock> | null; language: LanguageCode; look: LookPaint };

/**
 * The spaces shown "Visible and locked" (542 [CM1]) that a member holding
 * exactly the products checked would see locked, drawn by the real
 * community page's own LockedSpaces, in the store's language and look, from
 * the way in the studio page worked out with the real page's unlocksOf. So
 * it is what that member sees, word for word: name, one line, Locked, and
 * the way in; nothing from inside a space. Only its headings sit one level
 * deeper, under this preview's own, so the studio's outline stays in order.
 */
export function LockedPreview({ spaces, access, chosen, unlocks, language, look }: { spaces: PreviewSpace[]; access: string[]; chosen: string[] } & LockedPreviewData) {
  const locked = previewLocked(spaces, access, chosen, unlocks);
  if (locked.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-sm font-semibold text-ink">And what they see of the spaces kept from them, as on your community page:</p>
      <div lang={LANGUAGES[language].locale} className={`st-page st-theme-${look.theme} mt-2 rounded-[var(--r-md)] p-4`} style={lookStyle(look) as React.CSSProperties}>
        <LockedSpaces spaces={locked} language={language} level={4} />
      </div>
    </div>
  );
}

/**
 * "Which spaces a member sees" (399 [SL3], unit 2; added 1 November 2026):
 * the creator checks what a member bought, and the studio says which spaces
 * a member holding exactly those would see, by the rule the real gate uses
 * (lib/community-gate.ts). Worked out here from the community the studio
 * already has: no buyer is read, no route is called, nothing is changed and
 * nobody is told. Shown only when some space is kept for some products.
 *
 * What can be checked is every product that opens the community, including
 * one no longer in the store, whose buyers still get in.
 */
export function MemberPreview({
  spaces,
  access,
  open,
  locked = null,
}: {
  spaces: PreviewSpace[];
  access: string[];
  open: { id: string; title: string }[];
  /** For the spaces shown locked; without it they are left out of the preview. */
  locked?: LockedPreviewData | null;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const help = useId();
  if (!access.length || !spaces.some((space) => space.only.length)) return null;
  const pick = access.map((id) => open.find((product) => product.id === id) ?? { id, title: GONE_PRODUCT });
  const picked = chosen.filter((id) => access.includes(id));
  const shown = previewSpaces(spaces, access, picked);
  return (
    <section className="mt-6 rounded-[var(--r-md)] bg-paper p-4" aria-labelledby={`${help}-title`}>
      <h3 id={`${help}-title`} className="font-semibold text-ink">Which spaces a member sees</h3>
      <p id={help} className="mt-1 text-sm text-ink-soft">{PREVIEW_LEAVES_OUT}</p>
      <fieldset className="mt-3" aria-describedby={help}>
        <legend className="field-label">A member who bought</legend>
        <div className="mt-2 space-y-1.5">
          {pick.map((product) => (
            <label key={product.id} className="flex min-h-11 items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 shrink-0"
                checked={chosen.includes(product.id)}
                onChange={(e) => setChosen((now) => (e.target.checked ? [...now, product.id] : now.filter((id) => id !== product.id)))}
              />
              <span className="min-w-0 break-words">{product.title}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-3 text-sm text-ink" aria-live="polite">
        <p>{previewLine(picked.length, shown.length, spaces.length)}</p>
        {picked.length && shown.length ? (
          <ul className="mt-1 list-disc pl-5">
            {shown.map((space) => (
              <li key={space.id} className="break-words">{previewName(spaces, space.id)}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {locked ? <LockedPreview spaces={spaces} access={access} chosen={picked} {...locked} /> : null}
    </section>
  );
}
