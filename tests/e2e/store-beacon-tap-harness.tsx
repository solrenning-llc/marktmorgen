// The store's visit count (components/store-beacon.tsx) with one button beside it, for
// tests/e2e/store-beacon-first-tap.mjs: the real component, the real browser check client and
// the real pause. The button does a little work and draws, as a product card's first tap does.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { StoreBeacon } from "@/components/store-beacon";

function Card() {
  const [n, setN] = useState(0);
  return (
    <button
      id="tap"
      type="button"
      style={{ minWidth: 44, minHeight: 44 }}
      onClick={() => {
        const t = performance.now();
        while (performance.now() - t < 8) {
          // A small piece of work, as opening a card does.
        }
        setN((v) => v + 1);
      }}
    >
      Tapped {n}
    </button>
  );
}

const host = document.getElementById("root");
if (host)
  createRoot(host).render(
    <>
      <Card />
      <StoreBeacon handle="harborkitchen" />
    </>,
  );
