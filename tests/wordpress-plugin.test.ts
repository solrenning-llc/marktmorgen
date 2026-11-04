/**
 * 624 [SZ8](5), unit 1: the WordPress plugin writes exactly what the studio's
 * checkout script gives (lib/embed-sdk.ts scriptCode), with the very same
 * script, once per page, and nothing for a store or product that is not one.
 * Runs the plugin's own PHP with WordPress's three functions stood in.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loaderSource, loaderTag, scriptCode } from "@/lib/embed-sdk";
import { SITE_URL } from "@/lib/site-url";
import { done, is, part } from "./check";

const PLUGIN = "wordpress/marktmorgen-embed/marktmorgen-embed.php";

/** Runs PHP with ABSPATH defined and add_shortcode/add_action recorded, then `body`. */
function php(body: string): string {
  const code = `define('ABSPATH', '/');
$GLOBALS['mm_shortcodes'] = array(); $GLOBALS['mm_actions'] = array();
function add_shortcode($tag, $fn) { $GLOBALS['mm_shortcodes'][$tag] = $fn; }
function add_action($hook, $fn) { $GLOBALS['mm_actions'][$hook][] = $fn; }
require ${JSON.stringify(PLUGIN)};
${body}`;
  return execFileSync("php", ["-r", code], { encoding: "utf8" });
}
const shortcode = (attrs: Record<string, string>) => php(`echo call_user_func($GLOBALS['mm_shortcodes']['marktmorgen'], json_decode(${JSON.stringify(JSON.stringify(attrs))}, true));`);

part("The same link the studio gives");
const cases: { attrs: Record<string, string>; studio: Parameters<typeof scriptCode>[0] }[] = [
  { attrs: { store: "harbor-kitchen", product: "abc123def", text: "Buy the course", mode: "overlay" }, studio: { handle: "harbor-kitchen", productId: "abc123def", place: "", text: "Buy the course", mode: "overlay", fill: "#15112e", onFill: "#ffffff", withScript: false } },
  { attrs: { store: "harbor_kitchen.co", text: "Join the list", mode: "page", place: "Blog", campaign: "Spring Sale!" }, studio: { handle: "harbor_kitchen.co", productId: null, place: "blog", campaign: "springsale", text: "Join the list", mode: "page", fill: "#15112e", onFill: "#ffffff", withScript: false } },
  { attrs: { store: "harbor-kitchen", product: "abc123def", text: "Bob's \"best\" <course>", fill: "#ff6600", text_color: "#000000" }, studio: { handle: "harbor-kitchen", productId: "abc123def", place: "", text: "Bob's \"best\" <course>", mode: "overlay", fill: "#ff6600", onFill: "#000000", withScript: false } },
  { attrs: { store: "harbor-kitchen", product: "abc123def" }, studio: { handle: "harbor-kitchen", productId: "abc123def", place: "", text: "", mode: "overlay", fill: "#15112e", onFill: "#ffffff", withScript: false } },
];
for (const [i, c] of cases.entries()) is(`case ${i + 1}: identical to the studio's code`, shortcode(c.attrs), scriptCode(c.studio));

part("Nothing for what is not a store or a product");
is("no store", shortcode({ product: "abc123def" }), "");
is("a store with a slash in it", shortcode({ store: "../evil", product: "abc123def" }), "");
is("a product with a quote in it", shortcode({ store: "harbor-kitchen", product: 'abc"><script>' }), "");
is("a color that is not one falls back", shortcode({ store: "harbor-kitchen", product: "abc123def", fill: "red;background:url(x)" }).includes("background:#15112e"), true);

part("The script: the very same bytes, once per page, only when used");
is("the plugin's script is the studio's, byte for byte", php("echo MARKTMORGEN_LOADER;"), loaderSource(SITE_URL));
is("no shortcode on the page: no script", php("ob_start(); foreach ($GLOBALS['mm_actions']['wp_footer'] as $f) { $f(); } echo ob_get_clean();"), "");
const twice = php(`call_user_func($GLOBALS['mm_shortcodes']['marktmorgen'], array('store' => 'harbor-kitchen', 'product' => 'abc123def'));
call_user_func($GLOBALS['mm_shortcodes']['marktmorgen'], array('store' => 'harbor-kitchen'));
foreach ($GLOBALS['mm_actions']['wp_footer'] as $f) { $f(); }`);
is("two links: the script once", [twice.split("<script>").length - 1, twice.trim()], [1, loaderTag(SITE_URL)]);

part("Plain PHP, no request anywhere");
const source = readFileSync(PLUGIN, "utf8");
is("no outside request, no file or database access", /\b(wp_remote_|curl_|file_get_contents|fopen|\$wpdb|eval\s*\()/.test(source), false);
is("stops when loaded outside WordPress", source.includes("if (!defined('ABSPATH'))"), true);

done();
