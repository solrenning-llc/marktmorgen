/**
 * Ready example forms to start from (487 [IT4], item 5: no empty screen
 * without a ready example; added 2 November 2026). Each opens in the studio's
 * own form editor, unsaved, for the creator to read, change and save
 * (components/forms-editor.tsx). They hold questions only: no claim, figure
 * or promise of ours is put in the creator's mouth. What a person reads after
 * sending is left empty, as on a blank form, so the store's own words in its
 * own language are shown (lib/buyer-words/form.ts).
 */
import type { FormDef } from "@/lib/forms";

export type FormStarter = { id: string; name: string; hint: string; make: (piece: () => string) => FormDef };

const option = (piece: () => string, label: string) => ({ id: piece(), label, outcome: "" });

export const FORM_STARTERS: FormStarter[] = [
  {
    id: "application",
    name: "Application before a call",
    hint: "Who they are, what they want help with and when they would start, before you offer a call.",
    make: (piece) => ({
      id: "",
      name: "Application before a call",
      fields: [
        { id: piece(), type: "email", label: "Your email", required: true, options: [] },
        { id: piece(), type: "short", label: "Your name", required: true, options: [] },
        { id: piece(), type: "long", label: "What would you like help with?", required: true, options: [] },
        {
          id: piece(),
          type: "choice",
          label: "When would you like to start?",
          required: true,
          options: [option(piece, "This month"), option(piece, "In the next three months"), option(piece, "I am just looking for now")],
        },
      ],
      button: "",
      doneHeading: "",
      doneBody: "",
      outcomes: [],
      offerList: false,
      updatedAt: 0,
    }),
  },
  {
    id: "feedback",
    name: "Feedback from buyers",
    hint: "How useful it was, what would have made it better and whether they would buy here again.",
    make: (piece) => ({
      id: "",
      name: "Feedback from buyers",
      fields: [
        { id: piece(), type: "scale", label: "How useful was it to you, from 1 to 10?", required: true, options: [] },
        { id: piece(), type: "long", label: "What would have made it better?", required: false, options: [] },
        { id: piece(), type: "choice", label: "Would you buy here again?", required: true, options: [option(piece, "Yes"), option(piece, "Maybe"), option(piece, "No")] },
        { id: piece(), type: "email", label: "Your email (optional)", required: false, options: [] },
      ],
      button: "",
      doneHeading: "",
      doneBody: "",
      outcomes: [],
      offerList: false,
      updatedAt: 0,
    }),
  },
];
