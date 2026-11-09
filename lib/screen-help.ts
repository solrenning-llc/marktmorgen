// RED stub (766 [STN13], unit 3): replaced by the real rules in the next commit.
export type ScreenAnswer = { q: string; id: string };
export const MOST_SCREEN_ANSWERS = 0;
export const HELP_CENTER_SEARCH = "";
export const SCREEN_HELP: Readonly<Record<string, readonly string[]>> = {};
export function helpAnchor(q: string): string {
  return q;
}
export function screenOf(pathname: string | null): string | null {
  void pathname;
  return null;
}
export function screenAnswers(pathname: string | null): ScreenAnswer[] {
  void pathname;
  return [];
}
