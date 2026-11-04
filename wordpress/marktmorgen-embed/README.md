# Marktmorgen Embed for WordPress

Puts a Marktmorgen product's checkout card, or a store's sign-up form, on a WordPress page with a shortcode, instead of pasting code into a Custom HTML block. It writes exactly what the studio's "Checkout script" gives (checked by `tests/wordpress-plugin.test.ts` against `lib/embed-sdk.ts`).

## Use

```text
[marktmorgen store="your-store" product="PRODUCT_ID" text="Buy the course"]
```

```text
[marktmorgen store="your-store" text="Join the list"]
```

- `store`: your store's address, without the @.
- `product`: the product's id, from the studio's Checkout script panel. Leave it out for your sign-up form.
- `text`: the link's words, up to 60 characters.
- `mode`: `overlay` (opens over the page; the default) or `page` (opens the card as its own page).
- `place` and `campaign`: the tags your numbers show for this link.
- `fill` and `text_color`: the button's colors, as `#rrggbb`.

The overlay opens only on sites you list in the studio, under Checkout script; anywhere else the link opens the card as a page. Buyers pay on Stripe's page, on your own Stripe account; nothing about a buyer passes through WordPress or this plugin. The checkout script is written into the page once, and only on pages that use the shortcode.

If a security plugin adds a Content-Security-Policy to your site, add the two lines the studio shows under Checkout script.

## State

Built and tested; not published. To install it now, zip the `marktmorgen-embed` folder and upload it under Plugins, Add New, Upload Plugin. Listing it in the WordPress.org plugin directory needs the owner's own WordPress.org account and a license the directory accepts (GPL-compatible), which is the owner's decision; nothing has been submitted.
