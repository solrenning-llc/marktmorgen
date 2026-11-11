import { jsx as reactJsx, jsxs as reactJsxs } from "react/jsx-runtime";
import { contentMainProps } from "./main-props";
export { Fragment, type JSX } from "react/jsx-runtime";

/** Delegate to React; only main#content receives the shared native focus contract. */
export const jsx: typeof reactJsx = (type, props, key) => reactJsx(type, contentMainProps(type, props), key);
export const jsxs: typeof reactJsxs = (type, props, key) => reactJsxs(type, contentMainProps(type, props), key);
