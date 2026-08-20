import ts from 'typescript';

// Mutation operators over the parsed syntax tree rather than over text, so a replacement can never
// land inside a string, a comment, or a longer operator that merely contains the one being replaced.
// Type nodes are skipped for the same reason: a literal in type position is erased before the code
// runs, so mutating it is guaranteed to survive and reads exactly like a real gap in the tests.
//
// Each mutant records the exact source offsets it rewrites. A caller that cannot show the mutated
// text differs from the original has not run a mutation at all, and a survivor from a no-op edit
// reads exactly like a real gap in the tests — so `applyMutant` is the only supported way to build
// the mutated source, and it asserts the change is observable.

export interface Mutant {
  readonly description: string;
  readonly end: number;
  readonly line: number;
  readonly operator: string;
  readonly replacement: string;
  readonly start: number;
}

// Operator substitutions whose survival is meaningful: each changes a decision the code makes, and
// none of them produces source that fails to parse.
const binaryReplacements: ReadonlyMap<ts.SyntaxKind, readonly string[]> = new Map([
  [ts.SyntaxKind.AmpersandAmpersandToken, ['||']],
  [ts.SyntaxKind.BarBarToken, ['&&']],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, ['!==']],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, ['===']],
  [ts.SyntaxKind.GreaterThanEqualsToken, ['>']],
  [ts.SyntaxKind.GreaterThanToken, ['>=']],
  [ts.SyntaxKind.LessThanEqualsToken, ['<']],
  [ts.SyntaxKind.LessThanToken, ['<=']],
  [ts.SyntaxKind.PlusToken, ['-']],
]);

export function applyMutant(source: string, mutant: Readonly<Mutant>): string {
  const mutated = source.slice(0, mutant.start) + mutant.replacement + source.slice(mutant.end);
  if (mutated === source) {
    throw new Error(`Mutant at line ${String(mutant.line)} did not change the source: ${mutant.description}`);
  }
  return mutated;
}

export function collectMutants(sourceFile: ts.SourceFile): Mutant[] {
  const mutants: Mutant[] = [];
  const visit = (node: ts.Node, withinType: boolean): void => {
    if (withinType || ts.isTypeNode(node)) {
      ts.forEachChild(node, (child) => visit(child, true));
      return;
    }
    if (ts.isBinaryExpression(node)) {
      for (const replacement of binaryReplacements.get(node.operatorToken.kind) ?? []) {
        mutants.push(
          describe(
            sourceFile,
            node.operatorToken,
            replacement,
            'binary-operator',
            node.operatorToken.getText(sourceFile),
          ),
        );
      }
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      const original = node.kind === ts.SyntaxKind.TrueKeyword ? 'true' : 'false';
      mutants.push(describe(sourceFile, node, original === 'true' ? 'false' : 'true', 'boolean-literal', original));
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      // Drop the negation, keeping the operand: the strongest single-token change to a guard.
      mutants.push({
        description: `remove ! before ${truncate(node.operand.getText(sourceFile))}`,
        end: node.operand.getStart(sourceFile),
        line: lineOf(sourceFile, node),
        operator: 'negation',
        replacement: '',
        start: node.getStart(sourceFile),
      });
    }
    ts.forEachChild(node, (child) => visit(child, false));
  };
  visit(sourceFile, false);
  return mutants.sort((left, right) => left.start - right.start);
}

function describe(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  replacement: string,
  operator: string,
  original: string,
): Mutant {
  return {
    description: `${original} -> ${replacement}`,
    end: node.getEnd(),
    line: lineOf(sourceFile, node),
    operator,
    replacement,
    start: node.getStart(sourceFile),
  };
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function truncate(text: string): string {
  return text.length > 32 ? `${text.slice(0, 29)}...` : text;
}
