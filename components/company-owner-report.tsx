import React from "react";
import { companyOwnerReport } from "../lib/company-owner-report";

/** Server-renderable private view. The caller must authenticate the owner first. */
export function CompanyOwnerReportView({ snapshot, month, now }: { snapshot: string | null; month: string; now?: number }) {
  const report = companyOwnerReport(snapshot, month, now);
  return (
    <article lang="pt-BR" aria-label="Observações operacionais da empresa">
      <h1>Observações operacionais da empresa</h1>
      <p>Mês de referência: {report.month ?? "desconhecido"}.</p>
      <p>Estas observações são separadas da margem financeira. Fonte desconhecida não significa zero.</p>
      {report.sections.map(section => (
        <section key={section.id} aria-labelledby={`owner-${section.id}`}>
          <h2 id={`owner-${section.id}`}>{section.title}</h2>
          <p>{section.observedAtMs === null ? "Observação não confirmada." : <>Observado em <time dateTime={new Date(section.observedAtMs).toISOString()}>{new Date(section.observedAtMs).toISOString()} (UTC)</time>.</>}</p>
          <ul>{section.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
        </section>
      ))}
      <p>Coleta, página autenticada e envio automático ainda não estão ligados por esta apresentação.</p>
    </article>
  );
}
