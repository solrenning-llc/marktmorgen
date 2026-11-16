/**
 * 759 [STN6], unit 2: an AutoDM can ask a question with buttons, send the link for the button chosen, and remind once
 * someone who answered and did not click, inside Meta's rules as recorded in docs/meta-requirements.md section 4: one
 * private reply per comment (the question), a follow-up only after the person answers and inside 24 hours of that
 * answer, an automated experience said to be automated, and a request to stop honored at once.
 */
import * as flowModule from "@/lib/autodm-flow-rules";
import { done, is, part } from "./check";

type Flow = { question: string; choices: { label: string; product: string }[]; reminder: string };
const m = flowModule as unknown as Record<string, unknown>;
const readFlow = m.readFlow as (input: unknown, products: readonly { id: string }[]) => { ok: true; flow: Flow } | { ok: false; field: string; problem: string; index?: number; other?: number };
const choiceFor = m.choiceFor as (flow: Flow, answer: unknown) => number | null;
const isStop = m.isStop as (text: unknown) => boolean;
const decideAfterAnswer = m.decideAfterAnswer as (input: Record<string, unknown>) => unknown;
const decideReminder = m.decideReminder as (input: Record<string, unknown>) => unknown;
const firstMessage = m.firstMessage as (flow: Flow, storeName: string) => { note: string; text: string; buttons: { label: string; payload: string }[] };
const flowProblemWords = m.flowProblemWords as (problem: unknown) => string;

const PRODUCTS = [{ id: "p1a2b3c4" }, { id: "k9x8y7z6" }];
const input = (over: Record<string, unknown> = {}) => ({
  question: "Which guide do you want?",
  choices: [
    { label: "Beginner", product: "p1a2b3c4" },
    { label: "Advanced", product: "k9x8y7z6" },
  ],
  ...over,
});

part("The limits are ours and the window is Meta's, as recorded");
is("our own caps", [m.FLOW_MAX_CHOICES, m.CHOICE_LABEL_MAX_CHARS, m.FLOW_QUESTION_MAX_CHARS], [3, 20, 200]);
is("a follow-up only inside 24 hours of the person's answer", m.FOLLOW_UP_WINDOW_SECONDS, 86_400);
is("reminders are off unless the creator turns them on", m.DEFAULT_REMINDER, "off");
is("every reminder delay ends before the window does", (m.REMINDER_CHOICES as { id: string; seconds: number | null }[]).every((c) => c.seconds === null || c.seconds < 86_400), true);

part("A flow is read whole, or its first problem named");
const read = readFlow(input(), PRODUCTS);
is("a good flow, with the reminder off by default", read, { ok: true, flow: { question: "Which guide do you want?", choices: [{ label: "Beginner", product: "p1a2b3c4" }, { label: "Advanced", product: "k9x8y7z6" }], reminder: "off" } });
is("a reminder the creator chose is kept", readFlow(input({ reminder: "6h" }), PRODUCTS).ok && (readFlow(input({ reminder: "6h" }), PRODUCTS) as { flow: Flow }).flow.reminder, "6h");
is("a reminder that is not a choice is refused", readFlow(input({ reminder: "30h" }), PRODUCTS), { ok: false, field: "reminder", problem: "bad" });
is("an empty question", readFlow(input({ question: "  " }), PRODUCTS), { ok: false, field: "question", problem: "empty" });
is("a question with a link typed in it", readFlow(input({ question: "See example.com" }), PRODUCTS), { ok: false, field: "question", problem: "link" });
is("a question too long", readFlow(input({ question: "a".repeat(201) }), PRODUCTS), { ok: false, field: "question", problem: "too_long" });
is("no choices", readFlow(input({ choices: [] }), PRODUCTS), { ok: false, field: "choices", problem: "empty", index: -1 });
is("too many choices", readFlow(input({ choices: [1, 2, 3, 4].map((n) => ({ label: `Pick ${n}`, product: "p1a2b3c4" })) }), PRODUCTS), { ok: false, field: "choices", problem: "too_many", index: 3 });
is("a label too long", readFlow(input({ choices: [{ label: "x".repeat(21), product: "p1a2b3c4" }] }), PRODUCTS), { ok: false, field: "choices", problem: "too_long", index: 0 });
is("two labels that read the same", readFlow(input({ choices: [{ label: "Beginner", product: "p1a2b3c4" }, { label: "BEGINNER!", product: "k9x8y7z6" }] }), PRODUCTS), { ok: false, field: "choices", problem: "duplicate", index: 1, other: 0 });
is("a product the store does not sell now", readFlow(input({ choices: [{ label: "Beginner", product: "gone1234" }] }), PRODUCTS), { ok: false, field: "choices", problem: "product", index: 0 });
is("each problem in plain words", flowProblemWords({ ok: false, field: "choices", problem: "duplicate", index: 1, other: 0 }), "Button 2 reads the same as button 1. Change one of them.");

if (read.ok) {
  const flow = read.flow;
  part("The first message: the question, its buttons, and that it is automated");
  const first = firstMessage(flow, "Chef Mara");
  is("the note is drawn by the code, never typed by the creator", first.note, "Automated reply from Chef Mara. Reply STOP to get no more messages.");
  is("the question as typed", first.text, "Which guide do you want?");
  is("one button per choice, its payload only its place", first.buttons, [{ label: "Beginner", payload: "mm_c0" }, { label: "Advanced", payload: "mm_c1" }]);

  part("Which choice an answer is");
  is("a button's payload", [choiceFor(flow, "mm_c0"), choiceFor(flow, "mm_c1")], [0, 1]);
  is("a payload past the choices is none", choiceFor(flow, "mm_c2"), null);
  is("the label typed, in any case and with punctuation", choiceFor(flow, "advanced!"), 1);
  is("a sentence that holds a label is not a choice", choiceFor(flow, "I am a beginner"), null);
  is("anything else is none", [choiceFor(flow, ""), choiceFor(flow, 3), choiceFor(flow, null)], [null, null, null]);

  part("Stop is honored at once");
  is("stop words", ["STOP", "stop.", "Unsubscribe", "cancel", "opt out"].map(isStop), [true, true, true, true, true]);
  is("a sentence is not a stop", [isStop("don't stop"), isStop("stop sending me the beginner one, I want advanced")], [false, false]);

  const T = 1_000_000;
  const after = (over: Record<string, unknown>) => decideAfterAnswer({ flow, answer: "mm_c1", answeredAtSeconds: T, nowSeconds: T + 5, stopped: false, linkSent: false, ...over });
  part("After an answer: the chosen product's link, once, inside the window");
  is("the chosen product", after({}), { send: true, choice: 1, product: "k9x8y7z6" });
  is("a stop answer stops", after({ answer: "STOP" }), { send: false, why: "stopped" });
  is("a person who stopped before gets nothing", after({ stopped: true }), { send: false, why: "stopped" });
  is("an answer that is no choice", after({ answer: "hello" }), { send: false, why: "no_choice" });
  is("the link already went", after({ linkSent: true }), { send: false, why: "already_sent" });
  is("24 hours after the answer the window is shut", after({ nowSeconds: T + 86_400 }), { send: false, why: "window_closed" });
  is("an unknown time is never inside the window", after({ answeredAtSeconds: Number.NaN }), { send: false, why: "window_closed" });

  const on = { ...flow, reminder: "6h" };
  const remind = (over: Record<string, unknown>) => decideReminder({ flow: on, answeredAtSeconds: T, linkSentAtSeconds: T + 5, clicked: false, reminded: false, stopped: false, nowSeconds: T + 6 * 3600, ...over });
  part("A reminder: once, only to someone who answered and did not click, inside the window");
  is("due: sent", remind({}), { send: true });
  is("off unless chosen", decideReminder({ flow, answeredAtSeconds: T, linkSentAtSeconds: T + 5, clicked: false, reminded: false, stopped: false, nowSeconds: T + 6 * 3600 }), { send: false, why: "off" });
  is("never to someone who did not answer", remind({ answeredAtSeconds: null, linkSentAtSeconds: null }), { send: false, why: "not_answered" });
  is("never after a click", remind({ clicked: true }), { send: false, why: "clicked" });
  is("never twice", remind({ reminded: true }), { send: false, why: "already_reminded" });
  is("never after a stop", remind({ stopped: true }), { send: false, why: "stopped" });
  is("not before its time", remind({ nowSeconds: T + 6 * 3600 - 1 }), { send: false, why: "not_yet" });
  is("never once the window is shut", remind({ nowSeconds: T + 86_400 }), { send: false, why: "window_closed" });
}

done();
