import { jsxDEV as reactJsxDEV } from "react/jsx-dev-runtime";
import { contentMainProps } from "./main-props";
export { Fragment, type JSX } from "react/jsx-dev-runtime";

/** Development uses the same contract, retaining React's source/key diagnostics. */
export const jsxDEV: typeof reactJsxDEV = (type, props, key, isStatic, source, self) =>
  reactJsxDEV(type, contentMainProps(type, props), key, isStatic, source, self);
