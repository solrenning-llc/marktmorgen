export const MAX_BLOCKED = 500;
export const BLOCK_REASON_MAX = 200;
export const BLOCK_ENTRY_BYTES = 0;
export const blockKey = (sid: string) => `nl:blk:${sid}`;
export function personMark(email: string): string | null { void email; return null; }
export async function blockedState(store: unknown, email: string): Promise<unknown> { void store; void email; return "unknown"; }
export async function mayWrite(store: unknown, email: string): Promise<boolean> { void store; void email; return true; }
export async function blockPerson(store: unknown, email: string, reason: unknown): Promise<string> { void store; void email; void reason; return "error"; }
export async function unblockPerson(store: unknown, email: string): Promise<unknown> { void store; void email; return "error"; }
export async function forgetBlockedPerson(store: unknown, email: string): Promise<number> { void store; void email; return -1; }
