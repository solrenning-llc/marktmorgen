/**
 * What Stripe answers to POST /prices when it made the price it was sent: the
 * same amount, currency, frequency (a recurring price with no count sent is
 * every 1 interval, Stripe's default), tax treatment and metadata, read back
 * from the form. A test's Stripe answers with this so a price made by the code
 * is the price written (rule 30: lib/tier-switch.ts, isPriceWritten; lib/yearly-switch.ts;
 * lib/pay-what-you-want.ts, isPwywPrice); a test about a wrong reply answers
 * with something else.
 */
export function priceEcho(id: string, body: URLSearchParams): Record<string, unknown> {
  const metadata: Record<string, string> = {};
  for (const [name, value] of body) {
    const field = /^metadata\[(.+)\]$/.exec(name);
    if (field) metadata[field[1]] = value;
  }
  const whole = (name: string) => (body.has(name) ? Number(body.get(name)) : null);
  const interval = body.get("recurring[interval]");
  const custom = body.get("custom_unit_amount[enabled]") === "true";
  return {
    id,
    object: "price",
    active: true,
    currency: body.get("currency"),
    unit_amount: whole("unit_amount"),
    recurring: interval ? { interval, interval_count: whole("recurring[interval_count]") ?? 1, usage_type: "licensed" } : null,
    custom_unit_amount: custom
      ? { minimum: whole("custom_unit_amount[minimum]"), preset: whole("custom_unit_amount[preset]"), maximum: whole("custom_unit_amount[maximum]") }
      : null,
    tax_behavior: body.get("tax_behavior") ?? "unspecified",
    type: interval ? "recurring" : "one_time",
    metadata,
  };
}
