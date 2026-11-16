/**
 * The two plain scripts the root layout writes into every page (app/layout.tsx):
 * the switch that lets `.reveal` sections start hidden, and the observer that
 * brings them into view. Why they are plain scripts and not React is written
 * there.
 *
 * They are kept here, apart, because the pages rendered per visit run only
 * scripts the browser is told it may (lib/csp.ts): Next puts the nonce on its
 * own scripts, but these two are written by the layout, which is shared with
 * the pages built ahead of time and so has no nonce to give them. They are
 * allowed instead by their SHA-256 hashes, which work beside a nonce and
 * 'strict-dynamic'. Change a single character of either and its hash must
 * change with it — tests/reveal-scripts.test.ts checks the two agree, so a
 * page never silently loses its animation to the policy again.
 */

export const REVEAL_ON = 'try{if(window.IntersectionObserver&&!window.matchMedia("(prefers-reduced-motion: reduce)").matches){document.documentElement.setAttribute("data-reveal","on")}}catch(e){}';

export const REVEAL_WATCH =
  '(function(){try{var d=document,r=d.documentElement;' +
  'if(r.getAttribute("data-reveal")!=="on")return;' +
  'var n=d.querySelectorAll(".reveal");if(!n.length)return;' +
  'var o=new IntersectionObserver(function(e){e.forEach(function(x){' +
  'if(x.isIntersecting){x.target.classList.add("is-in");o.unobserve(x.target)}})},' +
  '{rootMargin:"0px 0px -6% 0px",threshold:0});' +
  'var h=window.innerHeight||0,i,v=[];' +
  // Read every position before any class write: no layout/read-write alternation.
  'for(i=0;i<n.length;i++){v[i]=n[i].getBoundingClientRect().top<h}' +
  'for(i=0;i<n.length;i++){' +
  'if(v[i]){n[i].classList.add("is-in")}else{o.observe(n[i])}}' +
  '}catch(e){try{document.documentElement.removeAttribute("data-reveal")}catch(_){}}})()';

/** Their hashes, as a Content-Security-Policy source list writes them. */
export const REVEAL_HASHES = ["'sha256-UzjXCD2NFSKilatygvZxFi37JZElmzLnHlfQpL3R7Ss='", "'sha256-lQ+CzFpsEfynlk8+zSFlLISRuRj0eEZXhBCBgsuazcg='"];
