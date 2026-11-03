/**
 * 630 [HN6](24) with the phone part of 639 [GL7](2): a contact field kind
 * "Phone number", kept in its international form, and on the contact's record
 * a link that opens a chat with that number in the creator's own WhatsApp.
 * Nothing is sent for the creator and nothing about the chat is kept.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FIELD_TYPES, crmPhone, fieldValue, isFieldType, parseFields, whatsappLink, type CrmField } from "@/lib/crm-rules";
import { flowConfigurationIssues, type FlowReviewContext } from "@/lib/flow-review";
import type { Flow } from "@/lib/flows";
import { PersonFields } from "@/components/person-fields";
import { done, is, part } from "./check";

part("The phone number as it is kept");
is("a kind a store can pick", FIELD_TYPES.some((t) => t.type === "phone") && isFieldType("phone"), true);
is("its name says the country code is needed", FIELD_TYPES.find((t) => t.type === "phone")?.label, "Phone number (with country code)");
is("an unknown kind is still refused", isFieldType("fax"), false);
is("spaces, dashes, dots and brackets go; + stays", crmPhone("+55 (85) 99876-5432"), "+5585998765432");
is("a leading 00 is read as +", crmPhone("0044 20 7946 0958"), "+442079460958");
is("dots are taken", crmPhone("+1.555.010.0199"), "+15550100199");
is("without a country code it is refused", crmPhone("(85) 99876-5432"), null);
is("a country code cannot start with 0", crmPhone("+0 555 010 0199"), null);
is("fewer than 7 digits is refused", crmPhone("+12345"), null);
is("more than 15 digits is refused (E.164)", crmPhone("+1234567890123456"), null);
is("letters are refused", crmPhone("+1 555 CALL NOW"), null);
is("not a string is refused", [crmPhone(5550100199), crmPhone(null), crmPhone(undefined)], [null, null, null]);

const phone: CrmField = { id: "ph0001", name: "Mobile", type: "phone", options: [] };
is("a field keeps the international form", fieldValue(phone, " +55 85 99876 5432 "), "+5585998765432");
is("an empty value clears it", fieldValue(phone, ""), "");
is("a number without a country code cannot be kept", fieldValue(phone, "99876-5432"), null);
is("the store keeps the kind with its fields", parseFields([{ id: "ph0001", name: "Mobile", type: "phone", options: ["ignored"] }]), [{ id: "ph0001", name: "Mobile", type: "phone", options: [] }]);

part("The WhatsApp link");
is("it opens wa.me with the digits only", whatsappLink("+5585998765432"), "https://wa.me/5585998765432");
is("it reads the number as typed, too", whatsappLink("+1 (555) 010-0199"), "https://wa.me/15550100199");
is("no link without a phone number", [whatsappLink(""), whatsappLink("hello"), whatsappLink("5550100199"), whatsappLink(null)], [null, null, null, null]);
is("the link carries no message text", whatsappLink("+15550100199")?.includes("?"), false);

part("A workflow step that sets a phone field");
const flow = { id: "main", name: "Welcome", trigger: "joined", productId: null, active: false, createdAt: 1, steps: [] } as unknown as Flow;
const step = (value: string) => ({ ...flow, steps: [{ id: "step1", delayHours: 0, subject: "Hello", body: "Welcome", action: { do: "field" as const, field: "ph0001", value } }] } as Flow);
const context: FlowReviewContext = { products: [], courses: [], forms: [], fields: [phone], stages: [], flows: [] };
is("a phone field's kind can be checked", flowConfigurationIssues(step("+15550100199"), context), []);
is("a value it cannot keep is named", flowConfigurationIssues(step("call me"), context).some((i) => i.includes("incompatible with contact field “Mobile”")), true);
is("an unknown kind is still flagged", flowConfigurationIssues(step("x"), { ...context, fields: [{ ...phone, type: "fax" }] }).some((i) => i.includes("could not be checked")), true);

part("On the contact's record");
const render = (initial: Record<string, string>) => renderToStaticMarkup(createElement(PersonFields, { person: "p".repeat(16), fields: [phone], initial }));
const empty = render({});
is("the field is a phone input with the phone keyboard", /type="tel"/.test(empty) && /inputMode="tel"|inputmode="tel"/.test(empty), true);
is("it says how to type the number, tied to the field", /aria-describedby="pf-ph0001-hint"/.test(empty) && /id="pf-ph0001-hint"[^>]*>Start with \+ and the country code/.test(empty), true);
is("no WhatsApp link before a number is saved", empty.includes("wa.me"), false);
const saved = render({ ph0001: "+5585998765432" });
is("a saved number offers the WhatsApp link", saved.includes('href="https://wa.me/5585998765432"'), true);
is("the link names what it does and the number", saved.includes("Open a WhatsApp chat with +5585998765432"), true);
is("it opens in a new tab and says so", /target="_blank"/.test(saved) && /rel="noopener noreferrer"/.test(saved) && saved.includes("new-tab-note"), true);
const source = readFileSync("components/person-fields.tsx", "utf8");
is("nothing is sent: the page only links, no fetch to WhatsApp", /fetch\([^)]*wa\.me/.test(source) || /api\.whatsapp|graph\.facebook/.test(source), false);
is("the number is saved in the kept form", source.includes("crmPhone(typed)"), true);

done();
