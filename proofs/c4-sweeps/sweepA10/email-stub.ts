export * from "/home/user/marktmorgen/.claude/worktrees/sweepA10/lib/email.ts";
export const sent: { to: string; subject: string }[] = [];
export function isSenderConfigured() { return true; }
export async function sendEmail(m: { to: string; subject: string }) { sent.push({ to: m.to, subject: m.subject }); return true; }
