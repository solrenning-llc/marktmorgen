/**
 * The Store assistant's line of replies this month says so when the month's pool could not be read, never vanishes
 * (Claude 1 cloud's LEVEs on #3878: components/store-assistant-editor.tsx with app/studio/page.tsx). An unread pool
 * is neither the full 700 nor nothing: the creator is told it could not be read just now (rule 24, in words).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { StoreAssistantEditor } from "@/components/store-assistant-editor";
import { NO_ASSISTANT } from "@/lib/store-assistant-rules";
import { NO_NEXT_OFFER } from "@/lib/next-offer-rules";
import { NO_ASSIST_REMINDER } from "@/lib/assistant-reminder-rules";
import { done, is, part } from "./check";

const plan = { subscriptionId: "sub_Usage0000001", active: true, period: { start: 1_790_000_000, end: 1_792_600_000, renews: true }, cancelsAtEnd: false, disputedAt: "" };
const shown = (usage: unknown) => {
  try {
    return renderToStaticMarkup(
      createElement(
        AppRouterContext.Provider,
        { value: {} as never },
        createElement(StoreAssistantEditor, { setting: NO_ASSISTANT, next: NO_NEXT_OFFER, remind: NO_ASSIST_REMINDER, postal: true, plan, onSale: true, canBill: false, refusal: null, usage: usage as never, missed: [], notice: "", pin: "" }),
      ),
    );
  } catch {
    return "threw";
  }
};

part("The month's replies, read");
is("said in numbers", shown({ left: 650, answered: 50 }).includes("50 replies this month; room for at least 650 more"), true);

part("The month's replies, not readable");
const unread = shown("unknown");
is("said in words, not left out", unread.includes("We could not read this month&#x27;s replies just now"), true);
is("and never as a number", /replies this month; room for at least/.test(unread), false);

part("The studio passes an unread pool as unknown, never as nothing");
const page = readFileSync("app/studio/page.tsx", "utf8");
is("assistantLeft's catch gives \"unknown\"", /usage=\{await assistantLeft\(own\)\.catch\(\(\) => "unknown" as const\)\}/.test(page), true);

done();
