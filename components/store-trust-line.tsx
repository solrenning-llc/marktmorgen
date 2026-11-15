/**
 * 254 [WH3]: the store page's trust line (lib/store-trust.ts), in plain words:
 * no logo, no seal, no picture.
 */
export function StoreTrustLine({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="st-muted mx-auto mt-3 grid max-w-md gap-1 text-sm">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
