"use client";

import { useEffect, useRef } from "react";
import { GIFT_TYPED_FIELDS, GROUP_TYPED_FIELDS, giftTypedKey, groupTypedKey, packGiftTyped, packGroupTyped, unpackGiftTyped, unpackGroupTyped } from "@/lib/gift-typed";

/**
 * Drawn inside the gift form (components/store-product.tsx, GiftBox), and,
 * with `form="group"`, inside the form to buy for several people (GroupBox),
 * each under its own key and with its own fields. Nothing on screen; with
 * scripts on it:
 *
 *   - keeps what was typed in the tab's own storage as the form is sent
 *     (lib/gift-typed.ts), so a refusal from the server never makes the buyer
 *     type it again (3.3.7);
 *   - when the page opens with that refusal (`problem`), puts it back into
 *     each field that still holds what the page drew (empty, or, for how many
 *     people, the number the form starts with), never over what was typed
 *     since, then removes it;
 *   - moves the focus to the field in error (`focusId`), which reads its
 *     reason through aria-describedby, or, when no field can fix it, to the
 *     reason (`reasonId`), which is then the alert; only while the focus is
 *     still on the page itself (<body>), never away from where the buyer
 *     already is; a refused consent box focuses itself
 *     (components/digital-consent-box.tsx);
 *   - unmarks the field in error (aria-invalid) once it is changed.
 *
 * With scripts off the fields come back empty, as before, but the field in
 * error is still marked and tied to its reason by the server's markup
 * (docs/accessibility-programme.md, "Gift form sent back with scripts off").
 * What is kept is cleared from every page of the store once too old, and all
 * of it back from paying (components/gift-typed-sweeper.tsx).
 */
export function GiftTypedKeeper({
  form: kind = "gift",
  handle,
  productId,
  problem,
  focusId,
  reasonId,
}: {
  form?: "gift" | "group";
  handle: string;
  productId: string;
  problem: string;
  focusId?: string;
  reasonId?: string;
}) {
  const mark = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = mark.current?.closest("form");
    if (!form) return;
    const group = kind === "group";
    const key = group ? groupTypedKey(handle, productId) : giftTypedKey(handle, productId);
    const fields = group ? GROUP_TYPED_FIELDS : GIFT_TYPED_FIELDS;
    if (problem) {
      let raw: string | null = null;
      try {
        raw = window.sessionStorage.getItem(key);
        window.sessionStorage.removeItem(key);
      } catch {
        raw = null;
      }
      const now = Date.now();
      const kept: Record<string, string> | null = group ? unpackGroupTyped(raw, now) : unpackGiftTyped(raw, now);
      if (kept) {
        for (const name of fields) {
          const field = form.elements.namedItem(name);
          const value = kept[name];
          if (!value) continue;
          if (field instanceof HTMLSelectElement) {
            const option = [...field.options].find((o) => o.value === value && !o.disabled);
            if (option && field.value === "") field.value = value;
          } else if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.value === field.defaultValue) {
            // Still what the page drew: empty, or the number of people the group form starts with.
            field.value = value;
            // So a component that follows its field (EmailField's "Did you mean …?") sees the value.
            field.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      }
      const target = (focusId ? document.getElementById(focusId) : null) ?? (problem !== "consent" && reasonId ? document.getElementById(reasonId) : null);
      // Only while nothing holds the focus yet (the page itself): a buyer already somewhere on the page is not moved.
      if (document.activeElement === document.body || document.activeElement === null) target?.focus();
    } else {
      // Nothing to answer: whatever an earlier send kept is not needed any more.
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        // Storage refused (private mode, blocked): nothing was kept either.
      }
    }
    const marked = focusId ? document.getElementById(focusId) : null;
    const unmark = () => marked?.removeAttribute("aria-invalid");
    marked?.addEventListener("input", unmark, { once: true });
    marked?.addEventListener("change", unmark, { once: true });
    const keep = (event: SubmitEvent) => {
      if (event.target !== form) return;
      const data = new FormData(form);
      const values: Record<string, string> = {};
      for (const name of fields) {
        const value = data.get(name);
        if (typeof value === "string") values[name] = value;
      }
      try {
        window.sessionStorage.setItem(key, group ? packGroupTyped(values, Date.now()) : packGiftTyped(values, Date.now()));
      } catch {
        // Storage refused: the form is still sent; only the refill is lost.
      }
    };
    // Bubbling on the window, so a send held back first (EmailField's suggestion) keeps nothing.
    window.addEventListener("submit", keep);
    return () => {
      window.removeEventListener("submit", keep);
      marked?.removeEventListener("input", unmark);
      marked?.removeEventListener("change", unmark);
    };
  }, [kind, handle, productId, problem, focusId, reasonId]);
  return <span ref={mark} hidden />;
}
