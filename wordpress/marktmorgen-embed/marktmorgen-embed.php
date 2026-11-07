<?php
/**
 * Plugin Name: Marktmorgen Embed
 * Description: Puts a Marktmorgen product's checkout card, or a store's sign-up form, on a WordPress page with a shortcode: the same link and checkout script the Marktmorgen studio gives to paste, without pasting code.
 * Version: 0.1.1
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Author: Marktmorgen
 * Text Domain: marktmorgen-embed
 *
 * 624 [SZ8](5). Usage, in any post or page:
 *
 *   [marktmorgen store="harbor-kitchen" product="abc123" text="Buy the course" mode="overlay"]
 *   [marktmorgen store="harbor-kitchen" text="Join the list"]   (no product: the sign-up form)
 *
 * What it writes is exactly what the studio's "Checkout script" gives
 * (lib/embed-sdk.ts scriptCode, checked by tests/wordpress-plugin.test.ts):
 * a link to https://marktmorgen.com/embed/<store>/<product>, tagged with where
 * it was placed, and, once per page, the checkout script, written into the
 * page so a view costs nothing until a visitor presses the link. The buyer
 * pays on Stripe's page, on the creator's own account; nothing about the
 * buyer passes through WordPress or this plugin. The overlay opens only on
 * sites the creator listed in the studio; anywhere else the link opens the
 * card as a page.
 */

if (!defined('ABSPATH')) {
    exit;
}

const MARKTMORGEN_ORIGIN = 'https://marktmorgen.com';
const MARKTMORGEN_MEDIUM = 'checkout-script';
const MARKTMORGEN_MAX_TEXT = 60;

/** The checkout script, the same bytes as lib/embed-sdk.ts loaderSource(), so its sha256 is the one the studio gives. */
const MARKTMORGEN_LOADER = <<<'MMLOADER'
/* Marktmorgen checkout script v2. What it does: https://marktmorgen.com/developers/checkout-script */
(function(w,d){
if(w.Marktmorgen)return;
var O="https://marktmorgen.com",open=null,api={version:2,purchase:null,close:function(){shut("page")}};
w.Marktmorgen=api;
function copy(a,b){var c={},k;for(k in a)c[k]=a[k];for(k in b)c[k]=b[k];return c}
function fire(t,detail,el){var e;try{e=new CustomEvent("marktmorgen:"+t,{detail:detail,bubbles:true})}catch(x){return}(el&&el.isConnected?el:d).dispatchEvent(e)}
function key(e){if(e.key==="Escape")shut("escape")}
function shut(why){if(!open)return;var o=open;open=null;w.removeEventListener("message",hear);d.removeEventListener("keydown",key,true);if(o.box.parentNode)o.box.parentNode.removeChild(o.box);d.documentElement.style.overflow=o.over;try{o.el.focus()}catch(x){}fire("close",copy(o.info,{reason:why}),o.el)}
function hear(e){if(!open||e.origin!==O||e.source!==open.frame.contentWindow)return;var m=e.data;if(!m||m.marktmorgen!==1||typeof m.type!=="string")return;if(m.type==="close")return shut("frame");if(m.type==="ready"){var h=Number(m.height);if(h>=160&&h<=800)open.frame.style.height=h+"px"}if(m.type!=="ready"&&m.type!=="checkout"&&m.type!=="optin")return;var more={};if(typeof m.status==="string"&&/^[a-z_]{1,20}$/.test(m.status))more.status=m.status;fire(m.type,copy(open.info,more),open.el);if(m.type==="checkout")shut("checkout")}
d.addEventListener("click",function(e){
if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
var a=e.target&&e.target.closest?e.target.closest("a[data-mm]"):null;if(!a)return;
var u;try{u=new URL(a.href)}catch(x){return}var p=u.pathname.split("/");
if(u.origin!==O||p[1]!=="embed"||!p[2]||!p[3])return;
var join=p[3]==="join",info={kind:join?"optin":"product",handle:decodeURIComponent(p[2]),product:join?null:p[3],mode:a.getAttribute("data-mm")==="page"?"page":"overlay"};
if(info.mode==="page"){fire("open",info,a);return}
e.preventDefault();if(open)return;fire("open",info,a);u.searchParams.set("mm","overlay");
var box=d.createElement("dialog"),frame=d.createElement("iframe"),x=d.createElement("button"),name=(a.textContent||"").trim().slice(0,80)||"Checkout";
box.setAttribute("role","dialog");box.setAttribute("aria-modal","true");box.setAttribute("aria-label",name);
box.style.cssText="position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;height:100%;max-width:none;max-height:none;margin:0;border:0;padding:72px 16px 16px;background:rgba(17,14,36,.6)";
frame.src=u.href;frame.title=name;frame.referrerPolicy="origin";frame.onload=function(){frame.onload=null;var f=d.activeElement;if(f===frame||f===box)try{frame.contentWindow.focus()}catch(x){}};
frame.style.cssText="display:block;width:100%;max-width:400px;height:420px;max-height:calc(100vh - 96px);border:0;border-radius:24px;background:transparent";
x.type="button";x.setAttribute("aria-label","Close");x.textContent="\u00d7";
x.style.cssText="position:absolute;top:16px;right:16px;width:44px;height:44px;border:0;border-radius:999px;background:#fff;color:#15112e;font:600 26px/1 system-ui,sans-serif;cursor:pointer";
x.onfocus=function(){x.style.outline="3px solid transparent";x.style.boxShadow="0 0 0 3px #15112e,0 0 0 6px #fff"};x.onblur=function(){x.style.outline="";x.style.boxShadow="none"};
x.onclick=function(){shut("button")};box.onclick=function(ev){if(ev.target===box)shut("backdrop")};box.oncancel=function(ev){ev.preventDefault();shut("escape")};
box.appendChild(frame);box.appendChild(x);
open={box:box,frame:frame,el:a,info:info,over:d.documentElement.style.overflow};
d.documentElement.style.overflow="hidden";w.addEventListener("message",hear);d.addEventListener("keydown",key,true);d.body.appendChild(box);if(box.showModal)try{box.showModal()}catch(x){}frame.focus()
});
var mark=/^#mm-purchase=([a-z0-9]{6,40})\.(evt_[0-9a-f]{32})$/.exec(w.location.hash);
if(mark){api.purchase={product:mark[1],order:mark[2]};try{history.replaceState(history.state,"",w.location.pathname+w.location.search)}catch(x){}
var say=function(){fire("purchase",api.purchase)};if(d.readyState==="loading")d.addEventListener("DOMContentLoaded",say);else setTimeout(say,0)}
})(window,document);
MMLOADER;

/** The same escaping as lib/embed-rules.ts escapeHtml. */
function marktmorgen_escape($text)
{
    return str_replace(array('&', '<', '>', '"', "'"), array('&amp;', '&lt;', '&gt;', '&quot;', '&#39;'), (string) $text);
}

/** A campaign tag cleaned as lib/source-rules.ts cleanTag cleans it. */
function marktmorgen_tag($raw)
{
    return substr(preg_replace('/[^a-z0-9._-]/', '', strtolower(trim((string) $raw))), 0, 30);
}

/** A color as #rrggbb, or the default the studio uses. */
function marktmorgen_color($raw, $fallback)
{
    return preg_match('/^#[0-9a-f]{6}$/i', (string) $raw) ? (string) $raw : $fallback;
}

/** The link's address, as lib/embed-sdk.ts scriptHref builds it. */
function marktmorgen_href($store, $product, $place, $campaign)
{
    $path = MARKTMORGEN_ORIGIN . '/embed/' . rawurlencode($store) . '/' . ($product !== '' ? rawurlencode($product) : 'join');
    $tags = array('utm_source' => $place !== '' ? $place : 'website', 'utm_medium' => MARKTMORGEN_MEDIUM);
    if ($campaign !== '') {
        $tags['utm_campaign'] = $campaign;
    }
    return $path . '?mm=page&' . http_build_query($tags, '', '&', PHP_QUERY_RFC1738);
}

/** The link, as lib/embed-sdk.ts scriptCode writes it; null when the store or product is not one. */
function marktmorgen_link($attrs)
{
    $store = strtolower(trim((string) ($attrs['store'] ?? '')));
    $product = strtolower(trim((string) ($attrs['product'] ?? '')));
    // The same shapes as lib/store-handle-pattern.ts and a product's id.
    if (!preg_match('/^[a-z0-9](?:[a-z0-9._-]{1,22}[a-z0-9])$/', $store) || ($product !== '' && !preg_match('/^[a-z0-9]{6,40}$/', $product))) {
        return null;
    }
    $mode = ($attrs['mode'] ?? 'overlay') === 'page' ? 'page' : 'overlay';
    $text = trim(preg_replace('/\s+/u', ' ', (string) ($attrs['text'] ?? '')));
    $text = function_exists('mb_substr') ? mb_substr($text, 0, MARKTMORGEN_MAX_TEXT) : substr($text, 0, MARKTMORGEN_MAX_TEXT);
    if ($text === '') {
        $text = $product !== '' ? 'Buy now' : 'Join the list';
    }
    $fill = marktmorgen_color($attrs['fill'] ?? '', '#15112e');
    $on_fill = marktmorgen_color($attrs['text_color'] ?? '', '#ffffff');
    $style = 'display:inline-block;padding:14px 28px;border-radius:999px;background:' . $fill . ';color:' . $on_fill
        . ";font:600 16px/1.25 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;text-decoration:none;";
    $href = marktmorgen_href($store, $product, marktmorgen_tag($attrs['place'] ?? ''), marktmorgen_tag($attrs['campaign'] ?? ''));
    return '<a href="' . marktmorgen_escape($href) . '" data-mm="' . $mode . '" referrerpolicy="origin" style="'
        . marktmorgen_escape($style) . '">' . marktmorgen_escape($text) . '</a>';
}

/** Whether the script has been asked for on this page. */
function marktmorgen_wants_script($set = null)
{
    static $wanted = false;
    if ($set !== null) {
        $wanted = (bool) $set;
    }
    return $wanted;
}

/** [marktmorgen …]: the link; the script is written once, at the foot of the page. */
function marktmorgen_shortcode($attrs)
{
    $link = marktmorgen_link(is_array($attrs) ? $attrs : array());
    if ($link === null) {
        return '';
    }
    marktmorgen_wants_script(true);
    return $link;
}

function marktmorgen_footer()
{
    if (marktmorgen_wants_script()) {
        echo '<script>' . MARKTMORGEN_LOADER . '</script>' . "\n";
    }
}

if (function_exists('add_shortcode')) {
    add_shortcode('marktmorgen', 'marktmorgen_shortcode');
}
if (function_exists('add_action')) {
    add_action('wp_footer', 'marktmorgen_footer');
}
