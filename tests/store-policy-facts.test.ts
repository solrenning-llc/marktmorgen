/**
 * 617 [SZ1], unit 1: the factual part of a store's policies follows its real
 * settings, says only what applies, never promises compliance, and its
 * fingerprint changes when a setting does (lib/store-policy-facts.ts).
 */
import { NOT_ADVICE, type PolicyFactsInput, policyFacts, policyFingerprint } from "@/lib/store-policy-facts";
import { done, is, part } from "./check";

const base: PolicyFactsInput = { storeName: "Harbor Kitchen", sellsDigital: true, sellsMemberships: false, stripe: true, paypal: false, pixels: [], postalAddress: "1 Main St, Portland, OR 97201", membersSelfCancel: true };
const ids = (input: Partial<PolicyFactsInput>) => policyFacts({ ...base, ...input }).map((s) => s.id);
const text = (input: Partial<PolicyFactsInput>) => policyFacts({ ...base, ...input }).flatMap((s) => s.sentences).join(" ");

part("Who sells: always; the money goes only into the accounts the store takes it with (Codex N1's MEDIUM on #1824)");
is("the creator is the seller, Marktmorgen is not the merchant of record", text({}).includes("Harbor Kitchen is the seller") && text({}).includes("is not the merchant of record"), true);
const seller = (input: Partial<PolicyFactsInput>) => policyFacts({ ...base, ...input }).find((s) => s.id === "seller")?.sentences ?? [];
is("Stripe only: Stripe, not PayPal", seller({ stripe: true, paypal: false })[2], "Payments go into Harbor Kitchen's own Stripe account.");
is("Stripe and PayPal: both", seller({ stripe: true, paypal: true })[2], "Payments go into Harbor Kitchen's own Stripe account, or its own PayPal account when you pay with PayPal.");
is("PayPal only: PayPal, never a Stripe account it may not have", seller({ stripe: false, paypal: true })[2], "Payments go into Harbor Kitchen's own PayPal account.");
is("neither: no account named, the seller still said", [seller({ stripe: false, paypal: false }).length, /Stripe|PayPal|Payments go/.test(seller({ stripe: false, paypal: false }).join(" "))], [2, false]);

part("Only what the store sells");
is("digital only: the digital rule, no membership rule", [text({}).includes("For digital content"), text({}).includes("A membership is at least partly a service")], [true, false]);
is("memberships: their rule and how to cancel them", ids({ sellsDigital: false, sellsMemberships: true }), ["seller", "cancel", "memberships", "contact"]);
is("canceling ends at the end of the period paid for", text({ sellsMemberships: true }).includes("end of the period you already paid for"), true);
is("neither: no 14-day section", ids({ sellsDigital: false, sellsMemberships: false }), ["seller", "contact"]);

part("Ad measurement only with a pixel on");
is("no pixel: no sentence", ids({}).includes("measurement"), false);
is("pixels named, consent and Global Privacy Control said", [text({ pixels: ["Meta", "TikTok"] }).includes("with Meta and TikTok"), text({ pixels: ["Meta"] }).includes("Global Privacy Control")], [true, true]);
is("three names read naturally", text({ pixels: ["Meta", "Google", "TikTok"] }).includes("with Meta, Google and TikTok"), true);

part("Contact only when set");
is("the postal address", text({}).includes("Harbor Kitchen's postal address: 1 Main St, Portland, OR 97201."), true);
is("none set: no sentence about a contact page that may not exist", ids({ postalAddress: " " }).includes("contact"), false);

part("Honest: never a promise of compliance");
const all = `${NOT_ADVICE} ${text({ sellsMemberships: true, pixels: ["Meta"], paypal: true })}`;
is("says it is not legal advice", NOT_ADVICE.includes("It is not legal advice"), true);
is("no word promising compliance", /\b(fully compliant|complies with|compliant with|GDPR[- ]compliant|guarantee)/i.test(all.replace("does not say that the store meets any particular law", "")), false);

part("A changed setting makes a new version");
const before = policyFingerprint(policyFacts(base));
is("the same settings, the same fingerprint", policyFingerprint(policyFacts({ ...base })), before);
is("a pixel switched on, a new one", policyFingerprint(policyFacts({ ...base, pixels: ["Meta"] })) === before, false);
is("a new address, a new one", policyFingerprint(policyFacts({ ...base, postalAddress: "2 Main St" })) === before, false);

// Claude 1 on #1824: the cancel-from-a-link sentence only where membership emails carry that link (canManage).
is("memberships with the link: they can cancel themselves", text({ sellsMemberships: true }).includes("cancel a membership yourself"), true);
is("memberships without it: no promise of a link, the end of the period still said", [text({ sellsMemberships: true, membersSelfCancel: false }).includes("cancel a membership yourself"), text({ sellsMemberships: true, membersSelfCancel: false }).includes("end of the period you already paid for")], [false, true]);

done();
