# PR #2895 — removed-product delivery proof

Exact reviewed head: `8c93eedf4bb257da4e7d7ce50413aea7d7d06cfa`.

The proof uses synthetic PayPal, Redis and mail stand-ins. It opens a real order, removes its product before the PayPal return, and then exercises the real return route and `handOverPayPal` callback.

Confirmed finding on that head (2/2 proof cases pass):

- PayPal capture: exactly 1;
- paid record: present;
- grant and receipt: 0;
- pending entry: absent.

The control keeps the product and proves one capture, one grant, and removal from pending only after delivery.

Cause: `handOverPayPal` resolves `false` when the product is absent. Both callbacks introduced/used by the reviewed flow await it but discard that boolean. `settle` therefore treats the hand-over as successful, performs `settledWrites`, and removes the only pending recovery entry. The buyer has paid, the payment is recorded, and there is no product grant or remaining retry path.

Run with:

```sh
node proofs/z-2895-product-gone.mjs .
```
