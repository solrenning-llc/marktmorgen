/**
 * VR (owner, 25/10/2026, Part A item 2): a server page or server component
 * that hands a client component ("use client") a function, or an object that
 * holds one, makes the whole page answer 500 in production ("Functions cannot
 * be passed directly to Client Components"). Rendering a component in a test
 * never crosses that boundary, so tests stayed green while two pages failed for
 * every visitor: the studio Business card (app/studio/card/page.tsx, words with
 * `store`) and every store page with a form of four questions or more
 * (components/sales-blocks.tsx, FormKeep with the form's words). Found by
 * Claude 4 on 11/11/2026 with this same check.
 *
 * It reads every .tsx under app/ and components/ with the type checker: for
 * each JSX element in a file without "use client" whose component comes from
 * a file with "use client", the type of each attribute (and of each spread
 * property) must hold no function and no instance React cannot send (URL,
 * RegExp, Error, Headers, Request, Response, FormData, Blob, streams). It
 * looks three levels into objects and into arrays and tuples. A value typed
 * `any` is not seen; nothing here certifies such a value.
 */
import { createRequire } from "node:module";
import { relative } from "node:path";
import { done, is } from "./check";

type TS = typeof import("typescript");
const root = process.cwd();
const ts = createRequire(`${root}/package.json`)("typescript") as TS;
const config = ts.getParsedCommandLineOfConfigFile(`${root}/tsconfig.json`, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
if (!config) throw new Error("tsconfig.json could not be read");
const roots = config.fileNames.filter((f) => /\/(app|components)\//.test(f) && f.endsWith(".tsx"));
const program = ts.createProgram(roots, config.options);
const checker = program.getTypeChecker();
const isClient = (sf: import("typescript").SourceFile) => /^\s*(['"])use client\1/.test(sf.getFullText());
const NOT_SENDABLE = /^(URL|RegExp|Error|URLSearchParams|Headers|Request|Response|WeakMap|WeakSet|NextRequest|NextResponse|ReadableStream|Blob|File|FormData)$/;
const REACT_OWN = /^(ReactNode|ReactElement|JSX\.Element|Element|Date|Promise)|Element<|CSSProperties|RefObject/;

/** The paths in a type that React cannot send to the browser ("" for the value itself). */
function unsendable(type: import("typescript").Type, depth: number, seen = new Set<import("typescript").Type>()): string[] {
  if (depth > 3 || seen.has(type)) return [];
  seen.add(type);
  if (type.isUnion()) {
    for (const member of type.types) {
      const found = unsendable(member, depth, seen);
      if (found.length) return found;
    }
    return [];
  }
  if (type.getCallSignatures().length) return [""];
  if (!(type.flags & ts.TypeFlags.Object)) return [];
  const name = checker.typeToString(type);
  if (NOT_SENDABLE.test(name)) return [` (${name})`];
  if (REACT_OWN.test(name)) return [];
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return checker.getTypeArguments(type as import("typescript").TypeReference).flatMap((item) => unsendable(item, depth + 1, seen).map((p) => `[]${p}`));
  }
  return type.getProperties().flatMap((prop) => {
    const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!declaration) return [];
    return unsendable(checker.getTypeOfSymbolAtLocation(prop, declaration), depth + 1, seen).map((p) => `.${prop.getName()}${p}`);
  });
}

const found: string[] = [];
let crossings = 0;
for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || !sf.fileName.startsWith(`${root}/`) || sf.fileName.includes("/node_modules/") || sf.fileName.includes("/tests/")) continue;
  if (!sf.fileName.endsWith(".tsx") || isClient(sf)) continue;
  const visit = (node: import("typescript").Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const symbol = checker.getSymbolAtLocation(node.tagName);
      const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const home = target?.declarations?.[0]?.getSourceFile();
      if (home && home !== sf && isClient(home)) {
        crossings += 1;
        const at = `${relative(root, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} <${node.tagName.getText()}`;
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxSpreadAttribute(attribute)) {
            for (const prop of checker.getTypeAtLocation(attribute.expression).getProperties()) {
              if (prop.getName() === "children" || prop.getName() === "key") continue;
              const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
              if (!declaration) continue;
              for (const p of unsendable(checker.getTypeOfSymbolAtLocation(prop, declaration), 1)) found.push(`${at} {...}.${prop.getName()}${p}>`);
            }
            continue;
          }
          const name = attribute.name.getText();
          if (name === "children" || name === "key") continue;
          const expression = attribute.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : undefined;
          if (!expression) continue;
          for (const p of unsendable(checker.getTypeAtLocation(expression), 0)) found.push(`${at} ${name}${p}>`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

is("the check reads the server-to-client crossings (hundreds of them)", crossings > 100, true);
is("no server page hands a client component a function or an instance it cannot send (it would answer 500)", found, []);
done();
