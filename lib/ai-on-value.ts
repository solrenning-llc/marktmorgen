/**
 * What a studio page hands AiOn (components/ai-assist.tsx) for the month's AI allowance. `left` is aiLeft's count,
 * or null when it could not be read (lib/ai.ts throws UnknownReplyError then; the page catches it as null). An
 * unread allowance becomes `known: false`, which every AiOn reader says in words ("We could not check your AI
 * allowance"), with its AI buttons off; the server still checks and reserves before any model call. Rule 24: an
 * unknown is never shown as "0 left".
 */
export type AiOnValue = { on: boolean; left: number; known?: false };

export function aiOnValue(on: boolean, left: number | null): AiOnValue {
  if (!on) return { on: false, left: 0 };
  return left === null ? { on: true, left: 0, known: false } : { on: true, left };
}
