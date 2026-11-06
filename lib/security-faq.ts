/**
 * The questions someone starting out asks about keeping an account safe
 * (534 [FQ1], unit 21, added 2 November 2026), answered only by what the
 * code does today: the studio's Account section and its own words
 * (components/passkey-manager.tsx, components/recovery-address-manager.tsx,
 * components/two-step-manager.tsx), the login page's code step
 * (app/signin/code/page.tsx), and none of it asking for a plan (the
 * app/api/auth routes and the libraries behind them read no plan). The
 * Account section is drawn once the store has its address. No figure but the
 * code's own, no claim of being safer than anyone. Shown first in the page's own "Questions" block.
 */

/** The studio's and the login page's own words. */
export const SECURITY_WORDS = {
  account: "Account",
  passkeys: "Passkeys",
  addPasskey: "Add a passkey",
  recovery: "Recovery address",
  twoStep: "Two-step login",
  turnOn: "Turn on two-step login",
  confirm: "Turn it on",
  emailRecovery: "Email my recovery address",
  remove: "Remove",
} as const;

export function securityBeginnerQuestions(): { q: string; a: string }[] {
  const w = SECURITY_WORDS;
  return [
    {
      q: "What do I need to do to keep my account safe?",
      a: `Protect your email inbox first: the link we send there is how you log in. Then, in your studio under “${w.account}”, you can turn on two-step login, which asks for a code from your phone after that link, and add a passkey or a recovery address, which are ways back in if you ever lose that inbox. Each is optional. Pick a recovery address only you can open: a link sent there lets you in too.`,
    },
    {
      q: "How do I turn on two-step login?",
      a: `In your studio, open “${w.account}” and find “${w.twoStep}”. If it first asks you to log in again, do that and come back. Type a recovery address if you have none yet, and press “${w.turnOn}”. Scan the square code, or type the key shown beside it, into your authenticator app. Type the six digits it shows and, if you typed the recovery address here, the code we email to it, then press “${w.confirm}”. Save the recovery codes it shows you: they are shown only once. If it says the code could not be emailed, check the address and try again. If it says two-step login is not available yet, it cannot be turned on for now.`,
    },
    {
      q: "Do these need a plan or a payment?",
      a: `No. Adding a passkey, a recovery address or two-step login asks for no plan and no payment, and none of them is charged. They are under “${w.account}” in your studio once you have taken your store's address.`,
    },
    {
      q: "What if I lose my phone?",
      a: `With two-step login off, nothing changes: the emailed link logs you in. With it on, type one of your saved recovery codes at the code step, or log in with a passkey kept on another device. If you kept a recovery address, the code page offers “${w.emailRecovery}”. If none of these works, the same page says what opens at once and what waits. Then, under “${w.account}”, remove the lost phone's passkey with “${w.remove}”.`,
    },
  ];
}
