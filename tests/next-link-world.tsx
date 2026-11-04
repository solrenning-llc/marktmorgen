/**
 * next/link for the tests that measure what a page sends (tests/page-response.ts):
 * the App Router's Link is a "use client" component, so the page's RSC payload
 * carries its props and the HTML its <a>. This one draws the same <a> and is
 * marked a client component by the test, as Next's bundler marks the real one.
 */
import type { AnchorHTMLAttributes, ReactNode } from "react";

export default function Link({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean; children?: ReactNode }) {
  delete (rest as { prefetch?: boolean }).prefetch;
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
