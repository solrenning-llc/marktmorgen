/**
 * What the "log out of other devices" route answered (app/api/auth/signout-others), as the page shows it: done, or
 * not known, never "done" when it is not known (757 [STN4], unit 1). Pure, so the page and its test read the same words.
 */
export type DevicesResult = Readonly<{ tone: "notice-success" | "notice-warn"; words: string }>;

export const DEVICES_RESULT: Readonly<Record<string, DevicesResult>> = {
  "out-others": {
    tone: "notice-success",
    words: "Done. Every other device that was logged in is now logged out. This browser is still logged in. A login finished at that very moment may stay open, so if you still see one, press the button again.",
  },
  "out-others-reauth": {
    tone: "notice-warn",
    words: "For your safety, log in again to log out your other devices. Nothing was logged out. This needs a login from the last 15 minutes. After you log in, your studio opens. Choose “Log out of other devices” there again.",
  },
  "out-others-unknown": {
    tone: "notice-warn",
    words: "We could not log out your other devices just now, so none of them is known to be logged out. Try again in a moment. If it keeps failing, use “Log out of all devices” in your studio.",
  },
};

/** The notice for a `status` in the address, or none. */
export function devicesResult(status: unknown): DevicesResult | undefined {
  return typeof status === "string" ? DEVICES_RESULT[status] : undefined;
}
