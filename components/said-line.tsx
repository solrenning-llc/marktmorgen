"use client";

import { useCallback, useState } from "react";

/**
 * A polite status line, for screen readers only, that says what a press did
 * (WCAG 2.2 4.1.3 Status Messages), such as a move in a list
 * (lib/move-words.ts). `say` empties the line first, so the same words said
 * twice in a row are said again.
 */
export function useSaid(): [string, (words: string) => void] {
  const [said, setSaid] = useState("");
  const say = useCallback((words: string) => {
    setSaid("");
    requestAnimationFrame(() => setSaid(words));
  }, []);
  return [said, say];
}

export function SaidLine({ said }: { said: string }) {
  return (
    <p role="status" className="sr-only">
      {said}
    </p>
  );
}
