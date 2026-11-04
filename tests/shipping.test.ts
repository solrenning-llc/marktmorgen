/**
 * Physical products, shipped by the creator (lib/shipping.ts,
 * lib/shipments.ts, added 11 October 2026). What is checked:
 *
 *   - what is stored or sent is read safely: a cost, a region or a list of
 *     countries Stripe ships to, and a short note;
 *   - only a product sold once, at one price, handing over nothing else can
 *     be shipped, and once it is, nothing else can be attached to it;
 *   - it can be sold, and its checkout asks Stripe for an address in one of
 *     its countries and adds the shipping as its own line, taxed as shipping
 *     where the store collects tax; it is never a gift;
 *   - the address is read from either of Stripe's places for it, said after
 *     paying and in the confirmation email;
 *   - marking it as shipped emails the buyer once, with the tracking link.
 */
import { activeShipping, parseShipping, readShippingSku, readCountries, shipProblem, shipsToWords } from "@/lib/shipping";
import { shippingAddressOf } from "@/lib/shipping-address";
import { SHIPPING_WORDS } from "@/lib/buyer-words/shipping";
import { addOption, editOption, addProduct, claimHandle, ensureStatsId, setProductLink, setProductShipping, setStripeAccount, setSubscription, setTax, storeForEmail } from "@/lib/store";
import { parseProduct, readProduct } from "@/lib/catalog";
import { parseOptions } from "@/lib/product-option";
import { canSellProduct, createCheckout } from "@/lib/store-checkout";
import { confirmationFor } from "@/lib/purchase-email";
import { markShipped, readTracking } from "@/lib/shipments";
import { shipmentOutboxFixture, shipmentPolicy } from "./shipment-mail-outbox-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
const checkouts: URLSearchParams[] = [];
const emails: { to: string; subject: string; text: string }[] = [];
let session: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return answer({ id: `email_${emails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"s".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path.startsWith("/checkout/sessions/") && method === "GET") return answer(session);
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const ADDRESS = { name: "Ana Souza", address: { line1: "1 Main St", line2: "Apt 2", city: "Austin", state: "TX", postal_code: "78701", country: "US" } };

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_shipping_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_shipping_only_a_stand_in";

  part("Read safely");
  is("a cost, a region and a note", parseShipping({ cents: 500, region: "na", note: " Ships  in 3 days " }), { cents: 500, region: "na", countries: ["US", "CA"], note: "Ships in 3 days" });
  is("a list of countries, kept to those Stripe ships to, once each", readCountries("us, ca, CA, xx, KP, gb"), ["US", "CA", "GB"]);
  is("nothing else is shipping", [parseShipping(null), parseShipping({ cents: -1, region: "us" }), parseShipping({ cents: 0, region: "custom", countries: ["XX"] })], [null, null, null]);
  is("where it goes, in the reader's language", [shipsToWords({ region: "na", countries: ["US", "CA"] }, "en-US", SHIPPING_WORDS.en), shipsToWords({ region: "world", countries: [] }, "de-DE", SHIPPING_WORDS.de)], ["United States and Canada", "die meisten Länder"]);

  part("Unknown stored shipping never becomes free or digital");
  const rawPhysical={id:"physical-proof",title:"Synthetic physical product",priceCents:3500,shipping:{cents:600,region:"us",note:"Ships tomorrow",sku:"Book-藍-01"}};
  for(const cents of [undefined,null,false,true,"0","600",[],[0],{},NaN,Infinity,-1,0.5]) {
    const unknown={...rawPhysical.shipping,cents};
    is("unverified charge is not shipping",parseShipping(unknown),null);
    is("unverified physical product is not offered as digital",parseProduct({...rawPhysical,shipping:unknown}),null);
  }
  for(const unknown of [false,0,"",[],{}, {cents:600,region:"custom",countries:[]}]) {
    is("malformed physical record refuses the product",parseProduct({...rawPhysical,shipping:unknown}),null);
  }
  const physical=parseProduct(rawPhysical);
  is("verified physical facts retain identifier price and creator reference",[physical?.id,physical?.priceCents,physical?.shipping?.cents,physical?.shipping?.sku],["physical-proof",3500,600,"Book-藍-01"]);
  const freeShipping=parseProduct({...rawPhysical,shipping:{...rawPhysical.shipping,cents:0}});
  is("explicit numeric zero remains free physical shipping",[freeShipping?.shipping?.cents,freeShipping?.shipping?.countries],[0,["US"]]);
  is("older digital records still read without shipping",[parseProduct({...rawPhysical,shipping:undefined})?.id,parseProduct({...rawPhysical,shipping:null})?.id],["physical-proof","physical-proof"]);

  part("Only on something sold once that hands over nothing else");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const book = await addProduct(OWNER, "The Supper Book", "Printed, 120 pages.", "35", null);
  const pdf = await addProduct(OWNER, "Supper PDF", "", "12", null);
  if (!book.ok || !pdf.ok) throw new Error("no product");
  await setProductLink(OWNER, pdf.product.id, "https://example.com/pdf");
  const shipping = parseShipping({ cents: 600, region: "na", note: "Ships within 3 business days" })!;
  const refused = await setProductShipping(OWNER, pdf.product.id, shipping);
  is("not on a product that already hands something over", refused.ok ? "saved" : refused.reason, "ship_delivery");
  is("the rules, said", [shipProblem({ priceCents: 0, recurring: null, call: null, options: [], pwyw: null, plan: null, file: null, link: null, course: null, bundle: null }), shipProblem({ priceCents: 100, recurring: null, call: null, options: [{ file: { pathname: "x" } }], pwyw: null, plan: null, file: null, link: null, course: null, bundle: null })], ["free", "delivery"]);
  const saved = await setProductShipping(OWNER, book.product.id, shipping);
  is("saved on a product with nothing else", saved.ok ? saved.product.shipping : null, shipping);
  is("then no link can be put on it", (await setProductLink(OWNER, book.product.id, "https://example.com/x")).ok ? "attached" : "refused", "refused");
  const signed = await addOption(OWNER, book.product.id, "Signed", "45", { sku: "Signed-01" });
  await addOption(OWNER, book.product.id, "Unsigned", "35");
  is("its prices are versions of the same thing, each shipped", signed.ok, true);
  const withOptions = (await readProduct((await storeForEmail(OWNER))!, book.product.id))!;
  is("and nothing can be attached to one of them either", (await setProductLink(OWNER, withOptions.options[0].id, "https://example.com/x")).ok ? "attached" : "refused", "refused");

  part("Inventory references preserve product and price identifiers");
  is("inventory references retain case and creator language", readShippingSku("  Book-藍-01  "), "Book-藍-01");
  is("unknown, oversized or multiline references are refused", [readShippingSku(null), readShippingSku(7), readShippingSku("x".repeat(65)), readShippingSku("two\nlines")], [null, null, null, null]);
  const corruptMetadata = parseShipping({ cents: 600, region: "na", note: "", sku: 7 });
  is("bad optional metadata does not disable physical shipping", [corruptMetadata?.cents, corruptMetadata?.countries, corruptMetadata?.sku], [600, ["US", "CA"], undefined]);
  const skuSaved = await setProductShipping(OWNER, book.product.id, { ...shipping, sku: "Book-藍-01" });
  is("reference is saved", skuSaved.ok ? skuSaved.product.shipping?.sku : null, "Book-藍-01");
  const skuRoundTrip = (await readProduct((await storeForEmail(OWNER))!, book.product.id))!;
  is("reference survives a catalog round trip without changing IDs", [skuRoundTrip.shipping?.sku, skuRoundTrip.id, skuRoundTrip.options.map(option => option.id)], ["Book-藍-01", withOptions.id, withOptions.options.map(option => option.id)]);
  const olderEdit = await setProductShipping(OWNER, book.product.id, { ...shipping, note: "Ships tomorrow" });
  is("older clients may edit shipping without erasing a reference", olderEdit.ok ? [olderEdit.product.shipping?.sku, olderEdit.product.shipping?.note] : null, ["Book-藍-01", "Ships tomorrow"]);
  const rejectedSku = await setProductShipping(OWNER, book.product.id, { ...shipping, sku: "x".repeat(65) });
  is("invalid write is refused", rejectedSku.ok ? "saved" : rejectedSku.reason, "ship_sku");
  const afterRefusal = (await readProduct((await storeForEmail(OWNER))!, book.product.id))!;
  is("refused edit leaves the existing shipping unchanged", [afterRefusal.shipping?.sku, afterRefusal.shipping?.note], ["Book-藍-01", "Ships tomorrow"]);
  await setProductShipping(OWNER, book.product.id, { ...shipping, sku: "" });
  const clearedSku = (await readProduct((await storeForEmail(OWNER))!, book.product.id))!;
  is("an explicit empty reference clears it without disabling shipping", [clearedSku.shipping?.sku, activeShipping(clearedSku)?.cents, clearedSku.id, clearedSku.options.map(option => option.id)], [undefined, 600, withOptions.id, withOptions.options.map(option => option.id)]);

  part("Physical variant references keep each existing price ID");
  is("a new physical variant stores its reference", withOptions.options[0].sku, "Signed-01");
  const optionId = withOptions.options[0].id;
  const variantSaved = await editOption(OWNER, optionId, "Signed", "45", { sku: "  Book-藍-Signed  " });
  is("a physical variant accepts its own inventory reference", variantSaved.ok, true);
  let variantProduct = (await readProduct((await storeForEmail(OWNER))!, book.product.id))!;
  is("variant reference survives storage with the same IDs and price", [variantProduct.options[0].sku, variantProduct.id, variantProduct.options.map(option => option.id), variantProduct.options[0].priceCents], ["Book-藍-Signed", withOptions.id, withOptions.options.map(option => option.id), 4500]);
  await editOption(OWNER, optionId, "Signed", "45", { details: "Signed by the author" });
  variantProduct = (await readProduct((await storeForEmail(OWNER))!, book.product.id))!;
  is("older option edits preserve a variant reference", variantProduct.options[0].sku, "Book-藍-Signed");
  const badVariant = await editOption(OWNER, optionId, "Changed", "46", { sku: "x".repeat(65) });
  is("an oversized variant reference refuses the whole edit", badVariant.ok ? "saved" : badVariant.reason, "sku");
  variantProduct = (await readProduct((await storeForEmail(OWNER))!, book.product.id))!;
  is("refused variant edits preserve label price and reference", [variantProduct.options[0].label, variantProduct.options[0].priceCents, variantProduct.options[0].sku], ["Signed", 4500, "Book-藍-Signed"]);
  const badAddedVariant = await addOption(OWNER, book.product.id, "Another", "45", { sku: null });
  is("unknown reference input does not create another variant", [badAddedVariant.ok ? "saved" : badAddedVariant.reason, (await readProduct((await storeForEmail(OWNER))!, book.product.id))!.options.length], ["sku", 2]);
  const digitalSku = await addOption(OWNER, pdf.product.id, "PDF", "12", { sku: "Physical-only" });
  is("a digital price cannot acquire a physical inventory reference", digitalSku.ok ? "saved" : digitalSku.reason, "sku_kind");
  const corruptVariant = parseOptions([{ ...variantProduct.options[0], sku: { unknown: true } }]);
  is("bad optional variant metadata preserves the price option", [corruptVariant.length, corruptVariant[0]?.id, corruptVariant[0]?.sku], [1, optionId, undefined]);
  await editOption(OWNER, optionId, "Signed", "45", { sku: "" });
  variantProduct = (await readProduct((await storeForEmail(OWNER))!, book.product.id))!;
  is("explicitly clearing a variant reference keeps shipping and all IDs", [variantProduct.options[0].sku, activeShipping(variantProduct)?.cents, variantProduct.options.map(option => option.id)], [undefined, 600, withOptions.options.map(option => option.id)]);

  part("Its checkout");
  const load = async () => {
    const store = (await storeForEmail(OWNER))!;
    return { store, product: (await readProduct(store, book.product.id))! };
  };
  let { store, product } = await load();
  is("it can be sold", [activeShipping(product) !== null, canSellProduct(store, product)], [true, true]);
  await createCheckout(store, product, "https://marktmorgen.com", product.options[0].id, {});
  let sent = checkouts.at(-1)!;
  is("the version picked, at its price", [sent.get("line_items[0][price_data][unit_amount]"), sent.get("line_items[0][price_data][product_data][name]"), sent.get("metadata[option]")], ["4500", "The Supper Book (Signed)", product.options[0].id]);
  await createCheckout(store, product, "https://marktmorgen.com", product.options[1].id, {});
  sent = checkouts.at(-1)!;
  is("Stripe asks for an address in one of its countries", [sent.get("shipping_address_collection[allowed_countries][0]"), sent.get("shipping_address_collection[allowed_countries][1]")], ["US", "CA"]);
  is("and adds the shipping as its own line", [sent.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"), sent.get("shipping_options[0][shipping_rate_data][display_name]"), sent.get("line_items[0][price_data][unit_amount]")], ["600", "Shipping · Ships within 3 business days", "3500"]);
  is("the order says it is shipped", sent.get("metadata[ship]"), "yes");
  await setTax(OWNER, { enabled: true, included: false, ids: false, invoices: false } as never);
  ({ store, product } = await load());
  await createCheckout(store, product, "https://marktmorgen.com", product.options[1].id, {});
  sent = checkouts.at(-1)!;
  is("with tax on: shipping taxed as shipping, the book as goods", [sent.get("shipping_options[0][shipping_rate_data][tax_code]"), sent.get("line_items[0][price_data][product_data][tax_code]"), sent.get("shipping_options[0][shipping_rate_data][tax_behavior]")], ["txcd_92010001", "txcd_99999999", "exclusive"]);
  let gift = "sent";
  await createCheckout(store, product, "https://marktmorgen.com", product.options[1].id, { gift: "g".repeat(16) }).catch(() => (gift = "refused"));
  is("never as a gift", gift, "refused");

  part("Where it is going");
  const older = { shipping_details: ADDRESS };
  const newer = { collected_information: { shipping_details: ADDRESS } };
  is("read from either of Stripe's places", [shippingAddressOf(older)?.lines, shippingAddressOf(newer)?.name], [["1 Main St", "Apt 2", "Austin, TX 78701", "United States"], "Ana Souza"]);
  session = {
    id: `cs_test_${"s".repeat(24)}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    amount_total: 4100,
    currency: "usd",
    created: Math.floor(Date.now() / 1000),
    customer_details: { email: "ana@example.com" },
    metadata: { store: "harbor", product: book.product.id, ship: "yes", title: "The Supper Book" },
    ...newer,
  };
  const letter = confirmationFor(store, session as never, Date.now() / 1000, [], [product]);
  is("in the confirmation email, with who sends it", [letter?.text.includes("Shipping to:\nAna Souza\n1 Main St"), letter?.text.includes("Harbor Kitchen ships it and emails you when it is on its way.")], [true, true]);

  part("Marked as shipped");
  is("a tracking link is an https address, or nothing", [readTracking(""), readTracking("http://x.com"), readTracking("https://tools.usps.com/go?x=1")], ["", null, "https://tools.usps.com/go?x=1"]);
  is("a link that is not one is refused", (await markShipped(store, session.id as string, "javascript:alert(1)")).ok ? "marked" : "refused", "refused");
  is("tracking URLs cannot carry credentials", readTracking("https://user:secret@tools.usps.com/go"), null);
  const originalPipeline: typeof redis.pipeline = redis.pipeline.bind(redis);
  const outbox = shipmentOutboxFixture();
  const runtime = { lifecycle: "active" as const, policy: shipmentPolicy(), pipeline: outbox.pipeline };
  const noFunding = await markShipped(store, session.id as string, "", undefined, { lifecycle: "active", policy: null });
  is("unreviewed pending storage is explicit unavailability before marking", noFunding, { ok: false, reason: "mail_unavailable" });
  is("unreviewed storage never creates a physical shipment mark", redis.run(["GET", `nl:ship:done:${session.id}`]), null);
  part("Never-activated deployments retain the original guarded one-shot action");
  const originalSession = session;
  const legacySender = installSesMailFixture({ fallback: globalThis.fetch, onResend: () => { throw new Error("synthetic unknown fallback outcome"); } });
  legacySender.configure();
  const observed: (string | number)[][] = [];
  try {
    session = { ...originalSession, id: "cs_test_legacycompat000001" };
    redis.pipeline = async commands => { observed.push(...commands.filter(c => String(c[1]).startsWith("nl:ship:done:"))); return originalPipeline(commands); };
    const first = await markShipped(store, String(session.id), "https://example.test/original");
    is("the default action marks and uses the guarded SES sender", [first.ok, first.ok && first.emailed, legacySender.sent.length], [true,true,1]);
    is("a new legacy mark keeps SET NX first without an extra GET", observed.map(c=>c[0]), ["SET"]);
    is("the original claim retains its 400-day expiry", observed[0]?.slice(3), ["NX","EX",400*86400]);
    is("legacy acceptance is truthful, never a pending source", first.ok && first.mail, {state:"accepted",delayed:false});
    const again = await markShipped(store, String(session.id), "https://example.test/loser");
    is("a second press reads the original winner and sends nothing more", [again.ok && again.shipped.tracking,again.ok && again.emailed,legacySender.sent.length], ["https://example.test/original",false,1]);
    is("an occupied claim needs only the original SET and GET", observed.map(c=>c[0]), ["SET","SET","GET"]);
    is("no queue or budget-pool is silently created", [redis.run(["EXISTS","nl:ship:mail:due"]),redis.run(["EXISTS","nl:ship:mail:all"]),redis.run(["EXISTS","nl:ship:mail:pool"])], [0,0,0]);
    is("the legacy path does not bypass the Resend guard", legacySender.resend.length, 0);
    session={...originalSession,id:"cs_test_legacycompat000002",customer_details:{email:"not an address"}};
    const invalid=await markShipped(store,String(session.id),"");
    is("an invalid recipient still permits the old shipment record without mail",[invalid.ok,invalid.ok&&invalid.emailed,legacySender.sent.length],[true,false,1]);
    session={...originalSession,id:"cs_test_legacycompatrace01"};
    const raced=await Promise.all([markShipped(store,String(session.id),"https://example.test/race-a"),markShipped(store,String(session.id),"https://example.test/race-b")]);
    is("concurrent legacy presses return one stored winner and invoke only one accepted send",[raced.every(r=>r.ok),raced[0].ok&&raced[1].ok&&raced[0].shipped.tracking===raced[1].shipped.tracking,raced.filter(r=>r.ok&&r.emailed).length,legacySender.sent.length],[true,true,1,2]);
    const before=legacySender.sent.length;
    session={...originalSession,id:"cs_test_legacycompat000003"};
    for(const reply of [undefined,false,0,1,"true",{},[],["OK",null],[null,"OK"]]){
      redis.pipeline=async commands=>commands.some(c=>c[0]==="SET"&&String(c[1]).startsWith("nl:ship:done:")) ? (Array.isArray(reply)&&reply.length===2?reply:[reply]) : originalPipeline(commands);
      const result=await markShipped(store,String(session.id),"");
      is("legacy unknown claim ACK never authorizes email",[result.ok,legacySender.sent.length],[false,before]);
    }
    redis.pipeline=async commands=>{
      if(commands.some(c=>c[0]==="SET"&&String(c[1]).startsWith("nl:ship:done:"))){await originalPipeline(commands);throw Error("synthetic lost claim ACK");}
      return originalPipeline(commands);
    };
    is("a committed lost ACK never sends",[(await markShipped(store,String(session.id),"https://example.test/kept")).ok,legacySender.sent.length],[false,before]);
    redis.pipeline=originalPipeline;
    const recovered=await markShipped(store,String(session.id),"https://example.test/not-kept");
    is("retry after a lost ACK returns its stored winner without sending",[recovered.ok&&recovered.shipped.tracking,recovered.ok&&recovered.emailed,legacySender.sent.length],["https://example.test/kept",false,before]);
    session={...originalSession,id:"cs_test_legacycompat000004"};
    const denied=await markShipped(store,String(session.id),"",undefined,{lifecycle:"retired",policy:null});
    is("retired cannot fall back to a new legacy mark",[denied.ok,redis.run(["GET",`nl:ship:done:${session.id}`]),legacySender.sent.length],[false,null,before]);
    const unknown=await markShipped(store,String(session.id),"",undefined,{lifecycle:"unknown" as never});
    is("unknown lifecycle cannot become legacy",[unknown.ok,redis.run(["GET",`nl:ship:done:${session.id}`])],[false,null]);
    session={...originalSession,id:"cs_test_legacycompat000005"};
    legacySender.setSesOutcome("lost");
    const uncertain=await markShipped(store,String(session.id),"");
    is("provider uncertainty preserves the shipment without inventing a queue",[uncertain.ok,uncertain.ok&&uncertain.emailed,uncertain.ok&&uncertain.mail],[true,false,{state:"not_recorded",delayed:false}]);
  } finally { legacySender.restore(); redis.pipeline=originalPipeline; session=originalSession; }
  for (const acknowledgement of [undefined, false, 0, 1, "true", {}, []]) {
    const refusedClaim = await markShipped(store, session.id as string, "", undefined, {
      ...runtime, pipeline: async commands => commands.some(command => command[0] === "EVAL")
        ? [acknowledgement] : outbox.pipeline(commands),
    });
    is("unknown durable claim acknowledgment refuses before mail", [refusedClaim.ok, emails.length], [false, 0]);
  }
  is("claim transport failure refuses before mail", [(await markShipped(store, session.id as string, "", undefined, {
    ...runtime, pipeline: async () => { throw new Error("synthetic storage outage"); },
  })).ok, emails.length], [false, 0]);

  part("A single durable shipment claim requires exactly one reply");
  const malformedClaimReplies: unknown[] = [null,undefined,false,0,"OK",{},[],Array(1),["OK",null],[null,"OK"],{0:"OK",length:1}];
  for (const receipt of malformedClaimReplies) {
    const shipmentCommands: (string | number)[][] = [];
    const emailsBefore = emails.length;
    const result = await markShipped(store, session.id as string, "", undefined, {
      ...runtime, pipeline: async commands => {
        shipmentCommands.push(...commands);
        return receipt as unknown[];
      },
    });
    is("an unknown outer claim cannot grant success or email", [result.ok ? "marked" : result.reason,emails.length], ["unknown",emailsBefore]);
    is("unknown claims are neither retried nor destructively removed",shipmentCommands.map(command => command[0]),["EVAL"]);
  }
  part("An occupied shipment claim needs a readable existing record");
  const badRecords: unknown[] = [undefined, null, "broken", "null", "[]", JSON.stringify({ at: -1, tracking: "" }), JSON.stringify({ at: 1.5, tracking: "" }), JSON.stringify({ at: 1, tracking: "https://user:secret@example.com/track" }), JSON.stringify({ at: 1, tracking: 7 })];
  const beforeClaimEmails = emails.length;
  for (const badRecord of badRecords) {
    let sourceReads = 0;
    try {
      redis.pipeline = async commands => {
        if (commands.some(command => String(command[1]).startsWith("nl:ship:done:"))) {
          sourceReads++;
          return commands.map(() => sourceReads === 1 ? null : badRecord);
        }
        return originalPipeline(commands);
      };
      const refusedClaim = await markShipped(store, session.id as string, "", undefined, {
        ...runtime, pipeline: async commands => commands.some(command => command[0] === "EVAL")
          ? [["legacy", JSON.stringify({ at: 1_790_000_000, tracking: "" })]] : outbox.pipeline(commands),
      });
      is("an unreadable occupied claim never fabricates shipment success", [refusedClaim.ok ? "marked" : refusedClaim.reason, emails.length], ["unknown", beforeClaimEmails]);
    } finally { redis.pipeline = originalPipeline; }
  }
  try {
    const keptShipment = { at: 1_790_000_000, tracking: "https://example.com/old-tracking" };
    redis.pipeline = async commands => {
      if (commands.some(command => String(command[1]).startsWith("nl:ship:done:"))) return commands.map(() => JSON.stringify(keptShipment));
      return originalPipeline(commands);
    };
    const keptClaim = await markShipped(store, session.id as string, "https://example.com/new-tracking", undefined, runtime);
    is("a readable occupied claim returns its original record without another email", [keptClaim.ok ? keptClaim.shipped : null, keptClaim.ok ? keptClaim.emailed : null, emails.length], [keptShipment, false, beforeClaimEmails]);
  } finally { redis.pipeline = originalPipeline; }

  part("An active funded shipment without a recipient still requires an exact claim ACK");
  const noRecipientSession = session;
  try {
    session={...noRecipientSession,id:"cs_test_invalidrecipientack01",customer_details:{email:"not an address"}};
    const malformedNoRecipient: unknown[] = [["OK","unexpected"],["OK",null],null,undefined,false,0,"OK",{},[],Array(1),[undefined],[null],[false],[0],["true"]];
    for(const receipt of malformedNoRecipient){
      const seen:(string|number)[][]=[];
      redis.pipeline=async commands=>{seen.push(...commands.filter(c=>String(c[1]).startsWith("nl:ship:done:")));return commands.some(c=>c[0]==="SET"&&String(c[1]).startsWith("nl:ship:done:"))?receipt as unknown[]:originalPipeline(commands);};
      const beforeEmails=emails.length,beforeOutbox=outbox.commands.length;
      const result=await markShipped(store,String(session.id),"",undefined,runtime);
      is("a malformed no-recipient claim cannot confirm a shipment",result.ok?"marked":result.reason,"unknown");
      is("malformed no-recipient claims add no re-read, outbox work or email",[seen.map(c=>c[0]),outbox.commands.length-beforeOutbox,emails.length-beforeEmails],[["GET","SET"],0,0]);
    }
    redis.pipeline=async commands=>{
      if(commands.some(c=>c[0]==="SET"&&String(c[1]).startsWith("nl:ship:done:")))throw Error("synthetic no-recipient SET outage");
      return originalPipeline(commands);
    };
    const failed=await markShipped(store,String(session.id),"",undefined,runtime);
    is("a no-recipient claim transport exception returns unknown",failed.ok?"marked":failed.reason,"unknown");
    session={...session,id:"cs_test_invalidrecipientlost01"};
    redis.pipeline=async commands=>{
      const reply=await originalPipeline(commands);
      return commands.some(c=>c[0]==="SET"&&String(c[1]).startsWith("nl:ship:done:"))?[...reply,"unexpected"]:reply;
    };
    const lost=await markShipped(store,String(session.id),"https://example.test/committed",undefined,runtime);
    is("a committed mark with an extra reply remains unconfirmed and is never deleted",[lost.ok,JSON.parse(String(redis.run(["GET",`nl:ship:done:${session.id}`]))).tracking],[false,"https://example.test/committed"]);
    redis.pipeline=originalPipeline;
    session={...session,id:"cs_test_invalidrecipientvalid01"};
    const accepted=await markShipped(store,String(session.id),"https://example.test/no-recipient",undefined,runtime);
    is("one real OK still confirms the no-recipient mark without sending",[accepted.ok,accepted.ok&&accepted.emailed,accepted.ok&&accepted.mail,emails.length],[true,false,{state:"not_recorded",delayed:false},0]);
    is("the no-recipient mark keeps its existing TTL",Number(redis.run(["TTL",`nl:ship:done:${session.id}`]))>399*86400,true);
  }finally{redis.pipeline=originalPipeline;session=noRecipientSession;}
  part("The active producer deadline begins before the Stripe read");
  const clockSession = session, priorFetch = globalThis.fetch;
  const started = Date.now(); let clock = started, capturedAuthorization: number | null = null;
  try {
    session={...clockSession,id:"cs_test_activeclock000001"};
    globalThis.fetch=(async(input,init)=>{ if(new URL(String(input)).pathname.includes("/checkout/sessions/"))clock=started+11*60_000; return priorFetch(input,init); }) as typeof fetch;
    const result=await markShipped(store,String(session.id),"",undefined,{...runtime,now:()=>clock,pipeline:async commands=>{
      for(const c of commands)if(c[0]==="EVAL"&&c[13]==="enqueue")capturedAuthorization=JSON.parse(String(c[15])).authorizedAt;
      return [["unknown"]];
    }});
    is("the original pre-await timestamp is preserved in the real enqueue argument",[capturedAuthorization,clock],[started,started+11*60_000]);
    is("an unknown durable ACK after the delayed read still authorizes no mark",result.ok,false);
  }finally{globalThis.fetch=priorFetch;session=clockSession;}
  // The route and the SES sender are real; only Redis ACKs and remote HTTP
  // are synthetic. The Lua itself is separately verified on real Redis.
  const sender = installSesMailFixture({ fallback: globalThis.fetch });
  sender.configure();
  try {
    const marked = await markShipped(store, session.id as string, "https://tools.usps.com/go?x=1", undefined, runtime);
    const mail = sender.sent.at(-1)!;
    is("the buyer gets one email, with unchanged tracking and address", [marked.ok && marked.emailed, mail.to[0], mail.subject, mail.text.includes("https://tools.usps.com/go?x=1"), mail.text.includes("Austin, TX 78701")], [true, "ana@example.com", "The Supper Book is on its way", true, true]);
    const again = await markShipped(store, session.id as string, "", undefined, runtime);
    is("and never a second one", [again.ok && again.emailed, sender.sent.length], [false, 1]);
    is("no unbudgeted Resend fallback was used", sender.resend.length, 0);
  } finally { sender.restore(); }
  session = { ...session, id: `cs_test_${"t".repeat(24)}`, metadata: { store: "harbor", product: pdf.product.id } };
  is("an order that was not shipped cannot be marked", (await markShipped(store, session.id as string, "")).ok ? "marked" : "refused", "refused");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
