"use client";

import { useRef, useState } from "react";
import { useLeaveGuard } from "@/components/leave-guard";
import { crmAnswer, crmRefusalMessage } from "@/lib/crm-response";
import { NewTab } from "@/components/new-tab";
import { toast } from "@/components/toast";
import { type CrmField, crmPhone, crmUrl, MAX_FIELD_VALUE, severalPicked, whatsappLink } from "@/lib/crm-rules";

/**
 * The store's own fields for one person (lib/crm-rules.ts), each saved as
 * soon as it is changed and left: their company, a date, which offer
 * interests them. Seen only by whoever may read orders. A phone field is
 * kept in its international form and, once saved, offers a link that opens a
 * chat with that number in the creator's own WhatsApp; nothing is sent for them.
 */
/** `mark`: the person as the page read them (lib/crm.ts, pageMark), signed by the server and sent with every save, so a person deleted since is never written again, nor from a page read too long ago. */
export function PersonFields({ person, fields, initial, mark }: { person: string; fields: CrmField[]; initial: Record<string, string>; mark: string }) {
  const [values, setValues] = useState(initial);
  const [saved, setSaved] = useState(initial);

  const writing = useRef(false);
  const uncertain = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [writeUnconfirmed, setWriteUnconfirmed] = useState(false);
  const changed = fields.filter(field => (values[field.id] ?? "") !== (saved[field.id] ?? ""));
  useLeaveGuard(pending || writeUnconfirmed || changed.length > 0);

  async function save(field: CrmField, typed: string) {
    if (writing.current || uncertain.current) return;
    // A phone number or a web address is sent and kept in the form the store keeps it, so the link below matches it.
    const value = !typed.trim() ? typed : field.type === "phone" ? crmPhone(typed) ?? typed : field.type === "url" ? crmUrl(typed) ?? typed : typed;
    if ((saved[field.id] ?? "") === value) return;
    writing.current = true;
    setPending(true);
    setMessage("");
    try {
      const response = await fetch("/api/store/crm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "value", person, field: field.id, value, mark }),
      });
      const answer = crmAnswer(response.ok, await response.json().catch(() => null));
      if (answer.ok) {
        setSaved((s) => ({ ...s, [field.id]: value }));
        setValues((v) => (v[field.id] === typed ? { ...v, [field.id]: value } : v));
        toast(`${field.name} saved.`);
        return;
      }
      if (answer.error === "crm_write_unconfirmed") {
        uncertain.current = true;
        setWriteUnconfirmed(true);
        setMessage("This change could not be confirmed and may already be saved. Keep a copy of your values, then reload and check the contact before trying again. Saving is paused until you reload.");
      } else {
        setMessage(crmRefusalMessage(answer.error));
      }
    } catch {
      uncertain.current = true;
      setWriteUnconfirmed(true);
      setMessage("The connection ended before this change could be confirmed. Keep a copy of your values, then reload and check the contact before trying again. Saving is paused until you reload.");
    } finally {
      writing.current = false;
      setPending(false);
    }
  }

  return (
    <div className="mt-4">
      {message ? <p className="notice notice-warn mb-4" role="status">{message}</p> : null}
      <p role="status" className="mb-2 text-sm">{pending ? "Saving contact field…" : changed.length ? `${changed.length} contact field${changed.length === 1 ? " has" : "s have"} unsaved changes.` : "Contact fields match the last confirmed values."}</p>
      <fieldset disabled={pending} aria-busy={pending} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <legend className="sr-only">Contact fields</legend>
        {fields.map((field) => {
          const id = `pf-${field.id}`;
          const value = values[field.id] ?? "";
          const change = (next: string) => setValues((v) => ({ ...v, [field.id]: next }));
          return (
            field.type === "several" ? (
              // Several of a few choices (639 [GL7](2)): one box each, saved as it is ticked.
              <fieldset key={field.id} className="block min-w-0">
                <legend className="field-label">{field.name}</legend>
                <div className="mt-2 grid gap-1">
                  {field.options.map((option) => {
                    const picked = severalPicked(value);
                    const on = picked.includes(option);
                    return (
                      <label key={option} className="flex min-h-11 items-center gap-3">
                        <input
                          type="checkbox"
                          className="h-5 w-5"
                          checked={on}
                          onChange={() => {
                            const next = field.options.filter((o) => (o === option ? !on : picked.includes(o))).join("\n");
                            change(next);
                            void save(field, next);
                          }}
                        />
                        <span>{option}</span>
                      </label>
                    );
                  })}
                </div>
                {(saved[field.id] ?? "") !== value ? (
                  <button type="button" className="btn btn-secondary mt-2" disabled={writeUnconfirmed} onClick={() => void save(field, value)}>Save {field.name}</button>
                ) : null}
              </fieldset>
            ) : (
            <div key={field.id} className="block">
              <label htmlFor={id} className="field-label">{field.name}</label>
              {field.type === "choice" ? (
                <select
                  id={id}
                  className="field mt-2"
                  value={value}
                  onChange={(e) => {
                    change(e.target.value);
                    void save(field, e.target.value);
                  }}
                >
                  <option value="">Not set</option>
                  {field.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  className="field mt-2"
                  type={field.type === "date" ? "date" : field.type === "number" ? "number" : field.type === "phone" ? "tel" : field.type === "url" ? "url" : "text"}
                  inputMode={field.type === "number" ? "decimal" : field.type === "phone" ? "tel" : field.type === "url" ? "url" : undefined}
                  autoComplete={field.type === "phone" || field.type === "url" ? "off" : undefined}
                  aria-describedby={field.type === "phone" ? `${id}-hint` : undefined}
                  maxLength={MAX_FIELD_VALUE}
                  value={value}
                  onChange={(e) => change(e.target.value)}
                  onBlur={(e) => void save(field, e.target.value)}
                />
              )}
              {field.type === "phone" ? <PhoneExtras id={id} saved={saved[field.id] ?? ""} /> : null}
              {field.type === "url" ? <UrlLink saved={saved[field.id] ?? ""} /> : null}
              {(saved[field.id] ?? "") !== value ? (
                <button type="button" className="btn btn-secondary mt-2" disabled={writeUnconfirmed} onClick={() => void save(field, value)}>Save {field.name}</button>
              ) : null}
            </div>
            )
          );
        })}
      </fieldset>
    </div>
  );
}

/** A made-up number in the US range set aside for fiction (555-01xx), built in parts so no file holds a phone number (scripts/check_public_data.py). */
const EXAMPLE_PHONE = ["+1", "555", "010", "0199"].join(" ");

/** The hint under a phone field and, once a number is saved, the link that opens a WhatsApp chat with it. */
function PhoneExtras({ id, saved }: { id: string; saved: string }) {
  const link = whatsappLink(saved);
  return (
    <>
      <p id={`${id}-hint`} className="mt-1 text-sm">Start with + and the country code, for example {EXAMPLE_PHONE}.</p>
      {link ? (
        <a className="btn btn-secondary mt-2" href={link} target="_blank" rel="noopener noreferrer">
          Open a WhatsApp chat with {saved}<NewTab /></a>
      ) : null}
    </>
  );
}

/** Once a web address is saved, a link to open it; only an address the store keeps (http or https) ever becomes one. */
function UrlLink({ saved }: { saved: string }) {
  const href = crmUrl(saved);
  if (!href) return null;
  return (
    <a className="btn btn-secondary mt-2 max-w-full break-all" href={href} target="_blank" rel="noopener noreferrer nofollow">
      Open {href}<NewTab /></a>
  );
}
