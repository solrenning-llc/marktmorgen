import { trustFacts, trustWords } from "@/lib/store-trust";

/**
 * "About this store" on a store page (94 [D2-BUYER-TRUST]; lib/store-trust.ts):
 * a heading and a list, each fact a sentence with where it comes from, no icon
 * carrying meaning and no seal image (docs/buyer-trust-card.md, Accessibility).
 * Nothing is drawn when the store shows no fact.
 */
export function StoreTrustCard({ store }: { store: { createdAt: unknown; language: unknown; look: { since?: boolean } } }) {
  const facts = trustFacts(store);
  if (!facts.length) return null;
  const w = trustWords(store.language);
  return (
    <section className="st-card mt-8 px-5 py-5 sm:px-6" aria-labelledby="store-trust" data-store-trust="">
      <h2 id="store-trust" className="st-section-title" style={{ marginBottom: 0 }}>{w.heading}</h2>
      <ul className="mt-3 space-y-3">
        {facts.map((fact) => (
          <li key={fact.key} data-trust-fact={fact.key}>
            <span className="block">{fact.text}</span>
            <span className="st-muted mt-0.5 block text-sm">{fact.source}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
