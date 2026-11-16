import { AFTER_CANCEL_TITLE, afterCancelWords } from "@/lib/plan-cancel-words";

/**
 * What canceling leads to, as a short list in the order it happens
 * (lib/plan-cancel-words.ts). Plain text in a list, so a screen reader
 * announces how many steps there are; nothing here moves, opens or times out.
 */
export function AfterCancel({ endsOn, trialing, id }: { endsOn: string | null; trialing: boolean; id: string }) {
  return (
    <div className="mt-3 max-w-[80ch] text-sm text-ink-soft" data-after-cancel="">
      <p id={id} className="font-bold text-ink">
        {AFTER_CANCEL_TITLE}
      </p>
      <ul aria-labelledby={id} className="mt-2 list-disc space-y-2 pl-5 leading-relaxed">
        {afterCancelWords(endsOn, trialing).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
