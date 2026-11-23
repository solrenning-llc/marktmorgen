/** The payday and PayPal passes of the affiliates' job, for tests/affiliate-idle-failed.test.ts: nothing due, all done. */
export async function sendPaydayEmails(): Promise<{ seen: number; due: number; sent: number; failed: number; complete: boolean }> {
  return { seen: 0, due: 0, sent: 0, failed: 0, complete: true };
}

export async function settleAllPayPal(): Promise<number> {
  return 0;
}
