"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_MEMBER_LINKS, memberLinkFrom } from "@/lib/member-links";

/** A box the server would turn away: something typed that is not a profile it keeps. */
const bad = (value: string) => Boolean(value.trim()) && !memberLinkFrom(value);

/**
 * The boxes on a member's own page for links to their profiles elsewhere
 * (601 [KB22], unit U12; lib/member-links.ts). Each box is checked with the
 * rule the server keeps by, when the member leaves it and again on sending:
 * a box it would refuse says why beside it and is marked invalid, and sending
 * stops there and moves to it, so what was typed stays to be fixed instead of
 * being lost (WCAG 3.3.1, 3.3.3, 3.3.7). Without script the form still sends,
 * the server keeps what passes and says that one was turned away.
 */
export function MemberLinkBoxes({
  kept,
  words,
}: {
  kept: string[];
  words: { legend: string; note: string; labels: string[]; refused: string };
}) {
  const [values, setValues] = useState<string[]>(() => Array.from({ length: MAX_MEMBER_LINKS }, (_, i) => kept[i] ?? ""));
  const [shown, setShown] = useState<boolean[]>(() => Array.from({ length: MAX_MEMBER_LINKS }, () => false));
  const box = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    const form = box.current?.form;
    if (!form) return;
    const check = (event: SubmitEvent) => {
      const inputs = Array.from(box.current?.querySelectorAll<HTMLInputElement>('input[name="link"]') ?? []);
      const wrong = inputs.map((input) => bad(input.value));
      if (!wrong.some(Boolean)) return;
      event.preventDefault();
      setShown(wrong);
      inputs[wrong.indexOf(true)]?.focus();
    };
    form.addEventListener("submit", check);
    return () => form.removeEventListener("submit", check);
  }, []);

  return (
    <fieldset ref={box} className="space-y-3">
      <legend className="st-label">{words.legend}</legend>
      <p id="you-links-note" className="st-muted text-sm">{words.note}</p>
      {/* The page says it sends links, so a form from an older page never wipes the ones kept. */}
      <input type="hidden" name="links" value="1" />
      {values.map((value, i) => {
        const wrong = shown[i] && bad(value);
        const errorId = `you-link-${i}-error`;
        return (
          <div key={i}>
            <label htmlFor={`you-link-${i}`} className="block text-sm font-semibold">{words.labels[i]}</label>
            <input
              id={`you-link-${i}`}
              name="link"
              type="text"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              value={value}
              onChange={(event) => {
                const next = event.target.value;
                setValues((all) => all.map((v, j) => (j === i ? next : v)));
                // A message already shown goes away as soon as the box is right.
                if (shown[i] && !bad(next)) setShown((all) => all.map((s, j) => (j === i ? false : s)));
              }}
              onBlur={() => setShown((all) => all.map((s, j) => (j === i ? bad(value) : s)))}
              aria-invalid={wrong || undefined}
              aria-describedby={wrong ? `you-links-note ${errorId}` : "you-links-note"}
              className="st-field mt-2"
            />
            {wrong ? (
              <p id={errorId} className="cm-alert mt-2" role="alert">
                {words.refused}
              </p>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}
