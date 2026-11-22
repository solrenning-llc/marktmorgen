/**
 * Every call that opens a checkout asks the EU VAT gate first, read from the syntax tree, not the text (Claude 1 coord's
 * LEVEs on #5121, 20th audit batch): tests/eu-vat-offer-paths-gate.test.ts runs it over app/ and lib/.
 *
 * What it holds, for each call of createCheckout, or of a function that only hands its arguments on to it (written
 * `(...args: Parameters<typeof createCheckout>)`, as lib/held-checkout.ts createCheckoutUnlessHeld in Claude 2's
 * child-safety stack):
 *   - the outermost function around the call (a route's POST, a lib function such as openWelcome) calls consumerGate,
 *     euSaleGate or pressGate before the call, and uses its answer (a gate whose result is thrown away is not asked);
 *   - a call outside any function is named;
 *   - createCheckout, or such a function, is never imported under another name, and never passed or kept as a value,
 *     since the walk could not follow it there.
 * Comments and strings are not code, so they never count as a call or as a gate. It does not prove that the answer is
 * acted on correctly: the journeys in tests/eu-vat-offer-paths-gate.test.ts and tests/eu-vat-checkout-routes.test.ts
 * do that for each path.
 */
import ts from "typescript";

export const CHECKOUT_GATES = ["consumerGate", "euSaleGate", "pressGate"] as const;

export type WalkFinding = { file: string; line: number; why: string };

const functionLike = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);

/** A function that only hands its arguments on to createCheckout: its one parameter is `...args: Parameters<typeof createCheckout>`. */
function handsOn(node: ts.Node): node is ts.FunctionDeclaration {
  if (!ts.isFunctionDeclaration(node) || !node.name || node.parameters.length !== 1) return false;
  const [only] = node.parameters;
  return Boolean(only.dotDotDotToken) && only.type?.getText().replace(/\s+/g, "") === "Parameters<typeofcreateCheckout>";
}

function each(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => each(child, visit));
}

/**
 * The walk. `sources` are the files to read (the module that defines createCheckout left out by the caller). Answers the
 * files with at least one call, and every finding.
 */
export function walkCheckoutCallers(sources: readonly { file: string; source: string }[]): { callers: string[]; findings: WalkFinding[] } {
  const parsed = sources.map(({ file, source }) => ({ file, sf: ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS) }));
  const openers = new Set<string>(["createCheckout"]);
  for (const { sf } of parsed) each(sf, (node) => {
    if (handsOn(node)) openers.add(node.name!.text);
  });

  const callers = new Set<string>();
  const findings: WalkFinding[] = [];
  for (const { file, sf } of parsed) {
    const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const say = (node: ts.Node, why: string) => findings.push({ file, line: line(node), why });
    each(sf, (node) => {
      if (ts.isImportSpecifier(node)) {
        const imported = (node.propertyName ?? node.name).text;
        if (openers.has(imported) && node.name.text !== imported) say(node, `${imported} imported as ${node.name.text}`);
        return;
      }
      if (!ts.isIdentifier(node) || !openers.has(node.text)) return;
      const parent = node.parent;
      // Not a use: its own name where it is defined or imported, a type (`typeof createCheckout`), or a property name.
      if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isTypeQueryNode(parent) || ts.isExportSpecifier(parent)) return;
      if ((ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) && parent.name === node) return;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
      if (!ts.isCallExpression(parent) || parent.expression !== node) {
        say(node, `${node.text} used as a value, where the walk cannot follow it`);
        return;
      }
      // The one hand-on inside a function that only hands its arguments on: not a sale of its own.
      let around: ts.Node | undefined = parent.parent;
      let top: ts.Node | null = null;
      let inside: ts.Node | null = null;
      while (around) {
        if (functionLike(around)) {
          top = around;
          inside ??= around;
        }
        around = around.parent;
      }
      if (inside && handsOn(inside) && node.text === "createCheckout" && parent.arguments.length === 1 && ts.isSpreadElement(parent.arguments[0])) return;
      callers.add(file);
      if (!top) {
        say(node, `${node.text} called outside any function`);
        return;
      }
      let gated = false;
      each(top, (candidate) => {
        if (gated || !ts.isCallExpression(candidate) || !ts.isIdentifier(candidate.expression)) return;
        if (!(CHECKOUT_GATES as readonly string[]).includes(candidate.expression.text)) return;
        if (candidate.getStart(sf) >= parent.getStart(sf)) return;
        // Its answer thrown away is no gate.
        if (ts.isExpressionStatement(candidate.parent) || ts.isVoidExpression(candidate.parent)) return;
        gated = true;
      });
      if (!gated) say(node, `${node.text} called with no EU VAT gate asked before it, its answer used, in the same function`);
    });
  }
  return { callers: [...callers].sort(), findings };
}
