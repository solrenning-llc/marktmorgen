import { ImageResponse } from "next/og";
import { lookUpVisitorStore, normaliseHandle } from "@/lib/store";
import { storeLookupRefusal } from "@/lib/store-lookup";
import { lookColours } from "@/lib/store-look";
import { storeKey } from "@/lib/learn";
import { CERT_ID_PATTERN, readCertificate } from "@/lib/certificate";
import { coursesWords } from "@/lib/buyer-words/courses";
import { speech } from "@/lib/buyer-words";

/**
 * The picture a certificate's link unfolds into when a student shares it, on
 * LinkedIn or anywhere else: the sheet itself, drawn in the store's colours —
 * who finished which course, taught by whom, and where to check it.
 *
 * Every word is read from the record kept when it was issued, as the page's
 * are (lib/certificate.ts). A certificate that was withdrawn, or an address
 * that names none, unfolds into the store's name alone: a shared link never
 * shows a certificate that does not stand.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "A certificate of completion: who finished which course, and who taught it";

type Params = { params: Promise<{ handle: string; id: string }> };

export default async function OpengraphImage({ params }: Params): Promise<Response> {
  const { handle, id } = await params;
  let decoded = "";
  try {
    decoded = decodeURIComponent(handle);
  } catch {
    // A broken escape names no store: the plain card.
  }
  // The visitor's lookup (lib/store-lookup.ts): a real store always opens; an address leading nowhere asked past the
  // connection's pace is told to wait instead of being drawn the plain card.
  const looked = decoded.startsWith("@") ? await lookUpVisitorStore(normaliseHandle(decoded)).catch(() => null) : null;
  if (looked?.retryAfter) return storeLookupRefusal(looked.retryAfter);
  const store = looked?.store ?? null;
  const found = store && CERT_ID_PATTERN.test(id) ? await readCertificate(id).catch(() => null) : null;
  const certificate = found && store && found.store === storeKey(store) && found.withdrawnAt === 0 ? found : null;
  const colours = lookColours(store?.look ?? { theme: "light", accent: "#5a36ee" });
  const storeName = store?.name ?? "Marktmorgen";
  const w = coursesWords(store?.language);
  const issued = certificate && store ? speech(store).date(certificate.issuedAt * 1000) : "";
  const address = `marktmorgen.com/@${store?.handle ?? ""}/certificate/${certificate?.id ?? ""}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundImage: `linear-gradient(135deg, ${colours.accent}, ${colours.accent2})`,
          fontFamily: "sans-serif",
        }}
      >
        {certificate ? (
          <div
            style={{
              width: 1080,
              height: 520,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "44px 64px 36px",
              borderRadius: 28,
              background: "#fffdf8",
              color: "#1d1a16",
              border: `6px solid ${colours.accent}`,
              boxShadow: "0 30px 60px -30px rgba(0,0,0,0.45)",
            }}
          >
            <div style={{ display: "flex", fontSize: 26, fontWeight: 700, color: colours.accent, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              {/* The sheet's two-part heading as one line, with one space where the two meet. */}
              {`${w.kicker.trim()} ${w.kickerAccent.trim()}`}
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ display: "flex", fontSize: 26, color: "#5b554c" }}>{w.certifies}</div>
              <div
                style={{
                  display: "flex",
                  marginTop: 10,
                  fontSize: certificate.name.length > 34 ? 52 : 68,
                  fontWeight: 800,
                  letterSpacing: "-0.02em",
                  textAlign: "center",
                }}
              >
                {certificate.name}
              </div>
              <div style={{ display: "flex", marginTop: 14, fontSize: 26, color: "#5b554c" }}>{w.hasCompleted}</div>
              <div
                style={{
                  display: "flex",
                  marginTop: 10,
                  fontSize: certificate.title.length > 48 ? 34 : 42,
                  fontWeight: 700,
                  textAlign: "center",
                  maxWidth: 940,
                }}
              >
                {certificate.title}
              </div>
              <div style={{ display: "flex", marginTop: 12, fontSize: 24, color: "#5b554c" }}>{w.taughtBy(certificate.creator, issued)}</div>
            </div>
            <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", fontSize: 20, color: "#6f685d" }}>
              <div style={{ display: "flex", fontWeight: 700, color: "#1d1a16" }}>{storeName}</div>
              <div style={{ display: "flex" }}>{address}</div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", fontSize: 72, fontWeight: 800, color: colours.onAccent }}>{storeName}</div>
        )}
      </div>
    ),
    size,
  );
}
