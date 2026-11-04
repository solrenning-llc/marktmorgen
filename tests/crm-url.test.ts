/**
 * 639 [GL7](2): a contact field kind "Web address", kept only as an http or
 * https address with a real host, never cut, and shown on the contact's
 * record as a link that opens in a new tab and says so.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FIELD_TYPES, MAX_FIELD_VALUE, crmUrl, fieldValue, isFieldType, parseFields, type CrmField } from "@/lib/crm-rules";
import { flowConfigurationIssues, type FlowReviewContext } from "@/lib/flow-review";
import type { Flow } from "@/lib/flows";
import { PersonFields } from "@/components/person-fields";
import { done, is, part } from "./check";

part("The address as it is kept");
is("a kind a store can pick", FIELD_TYPES.find((t) => t.type === "url")?.label === "Web address" && isFieldType("url"), true);
is("https kept as the browser reads it", crmUrl("https://Example.com/Portfolio"), "https://example.com/Portfolio");
is("http kept", crmUrl("http://example.org"), "http://example.org/");
is("no scheme: read as https", crmUrl("acme.studio/about"), "https://acme.studio/about");
is("spaces around are trimmed", crmUrl("  example.com  "), "https://example.com/");
is("never a script, a mailto or a file", [crmUrl("javascript:alert(1)"), crmUrl("mailto:a@example.com"), crmUrl("data:text/html,hi"), crmUrl("file:///etc/passwd"), crmUrl("ftp://example.com")], [null, null, null, null, null]);
is("never a bare word, a number address or a name with no dot", [crmUrl("hello"), crmUrl("http://127.0.0.1/"), crmUrl("http://localhost/"), crmUrl("https://intranet")], [null, null, null, null]);
is("never with a user and password in it", crmUrl("https://user:pass@example.com"), null);
is("never with spaces inside", crmUrl("https://example.com/a b"), null);
const long = `https://example.com/${"a".repeat(MAX_FIELD_VALUE)}`;
const field: CrmField = { id: "web001", name: "Website", type: "url", options: [] };
is("too long is refused, never cut into another address", [crmUrl(long), fieldValue(field, long)], [null, null]);
is("a field keeps the address; empty clears it", [fieldValue(field, "example.com"), fieldValue(field, "")], ["https://example.com/", ""]);
is("the store keeps the kind with its fields", parseFields([{ id: "web001", name: "Website", type: "url" }]), [{ id: "web001", name: "Website", type: "url", options: [] }]);

part("A workflow step that sets it");
const flow = { id: "main", name: "Welcome", trigger: "joined", productId: null, active: false, createdAt: 1, steps: [] } as unknown as Flow;
const step = (value: string) => ({ ...flow, steps: [{ id: "step1", delayHours: 0, subject: "Hello", body: "Welcome", action: { do: "field" as const, field: "web001", value } }] } as Flow);
const context: FlowReviewContext = { products: [], courses: [], forms: [], fields: [field], stages: [], flows: [] };
is("an address it can keep passes", flowConfigurationIssues(step("example.com"), context), []);
is("one it cannot is named", flowConfigurationIssues(step("javascript:alert(1)"), context).some((i) => i.includes("incompatible with contact field “Website”")), true);

part("On the contact's record");
const render = (initial: Record<string, string>) => renderToStaticMarkup(createElement(PersonFields, { person: "p".repeat(16), fields: [field], initial, generation: 0 }));
const empty = render({});
is("a web address input with its keyboard", /type="url"/.test(empty) && /inputMode="url"|inputmode="url"/.test(empty), true);
is("no link before an address is saved", empty.includes("Open https"), false);
const saved = render({ web001: "https://example.com/portfolio" });
is("a saved address is a link that names it", saved.includes('href="https://example.com/portfolio"') && saved.includes("Open https://example.com/portfolio"), true);
is("it opens in a new tab, says so, and passes nothing on", /target="_blank"/.test(saved) && /rel="noopener noreferrer nofollow"/.test(saved) && saved.includes("new-tab-note"), true);
is("a stored value that is not an address never becomes a link", render({ web001: "javascript:alert(1)" }).includes("href="), false);

done();
