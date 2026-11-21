# Held: the inbox's look at a buyer's past refunds and disputes

Held on 16 November 2026 (Claude 7's MEDIUM 2 on #3841, rule VR 2: what does not work today does not appear). The
inbox route's "history" action and `lib/buyer-history.ts` are built and tested, but no studio screen asks for the
look yet (`components/inbox-history.tsx` is future work). Until that screen ships, `REFUND_HISTORY_SCREEN.shown` is
false: the route refuses the action before anything is read, counted or kept, and buyers are not told about a use of
their data that does not happen.

The screen's change turns `REFUND_HISTORY_SCREEN.shown` on and puts back, word for word, the two texts below.
`tests/buyer-history-privacy.test.ts` holds what they must say; `tests/buyer-history-held.test.ts` holds that they are
absent while the switch is off.

## The Privacy Policy paragraph (`app/privacy/page.tsx`)

```tsx
        <p id="inbox-refund-history" className="scroll-mt-24">
          <strong className="text-black">Past refunds and disputes, in a store&apos;s inbox.</strong>{" "}
          When a store&apos;s team asks, in one conversation of its inbox, we
          read from that store&apos;s own Stripe account how many of the paid
          checkouts made with the conversation&apos;s address in that store
          were refunded in full or in part, or had a dispute opened. We show
          those counts only to that store&apos;s team, so it can decide how to
          answer; they are read at that moment and we keep nothing but how
          many such checks the store made that day. Subscriptions, payments not
          made yet, checkouts under another spelling of the address and any
          past the newest 100 are said as not checked, never as none.
        </p>
```

## The person-data entry (`lib/person-data.ts`)

```ts
  { file: "lib/buyer-history.ts", how: "none", what: "Their past refunds and disputes in your store, read from your own Stripe account when your team asks in a conversation, shown to your team and never kept" },
```
