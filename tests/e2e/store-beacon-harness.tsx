// The store's visit count (components/store-beacon.tsx) alone on a page, for
// tests/e2e/store-beacon-short-visit.mjs: the real component, the real
// browser check client (botid/client/core through lib/browser-check-client.ts)
// and the real pause (lib/quiet-moment.ts). Nothing else of the store page.
import { createRoot } from "react-dom/client";
import { StoreBeacon } from "@/components/store-beacon";

const host = document.getElementById("root");
if (host) createRoot(host).render(<StoreBeacon handle="harborkitchen" />);
