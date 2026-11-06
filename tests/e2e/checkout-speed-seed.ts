/**
 * After tests/e2e/seed.ts: open payment requests on the local store, so
 * scripts/checkout-speed.mjs can open each one's page (/@localshop/pay/<id>)
 * and press its button once (the stand-in Stripe answers every checkout as
 * paid, so a request is used for one run only). CHECKOUT_SPEED_REQUESTS says
 * how many. Synthetic only: an example.test address, nothing is sent.
 */
import { storeForEmail } from "@/lib/store";
import { createRequest } from "@/lib/payment-request-store";

async function main(): Promise<void> {
  const store = await storeForEmail("owner@example.com");
  if (!store)
    throw new Error("the local store is missing; run tests/e2e/seed.ts first");
  const count = Math.max(
    1,
    Math.min(20, Number(process.env.CHECKOUT_SPEED_REQUESTS) || 1),
  );
  const requests: string[] = [];
  for (let n = 0; n < count; n++) {
    const made = await createRequest(store, {
      email: "payer@example.test",
      name: "Sam Payer",
      lines: [
        { text: "Menu planning session", quantity: 1, cents: 12000 },
        { text: "Printed recipe cards", quantity: 2, cents: 1500 },
      ],
      note: "",
      dueDate: "",
      autoReminders: 0,
      total: 15000,
    });
    if (!made.ok)
      throw new Error(`payment request ${n + 1} was refused: ${made.reason}`);
    requests.push(made.request.id);
  }
  console.log(JSON.stringify({ requests }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
