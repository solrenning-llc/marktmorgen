/**
 * How a scroll started by a press moves (WCAG 2.3.3, AX274): instantly for a person who asked their system for less
 * motion, smoothly otherwise. The stylesheet's `scroll-behavior: auto` under prefers-reduced-motion does not reach a
 * script that names `behavior: "smooth"`, so every scripted smooth scroll asks here.
 */
export function scrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "smooth";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
