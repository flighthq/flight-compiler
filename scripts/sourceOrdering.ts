import ts from 'typescript';

// Ordering rules that a reader relies on but no formatter enforces: imports arrive in a fixed group
// order so a dependency's tier is visible from its position, and exported functions are
// alphabetized so a file's public surface can be scanned without reading it.
//
// This module only reports. Rewriting a source file to satisfy an ordering rule is a separate,
// riskier capability, so the gate refuses rather than repairs and the bare `order` name stays free
// for the day a writer exists.

export type ImportGroup = 'builtin' | 'external' | 'relative';

export interface SourceOrderIssue {
  readonly detail: string;
  readonly line: number;
  readonly rule: 'export-alphabetization' | 'import-group-order' | 'import-specifier-order';
}

export function getImportGroup(specifier: string): ImportGroup {
  if (specifier.startsWith('node:')) return 'builtin';
  return specifier.startsWith('.') ? 'relative' : 'external';
}

export function collectSourceOrderIssues(sourceFile: ts.SourceFile, alphabetizeExports: boolean): SourceOrderIssue[] {
  return [...collectImportIssues(sourceFile), ...(alphabetizeExports ? collectExportIssues(sourceFile) : [])];
}

const groupRank: Readonly<Record<ImportGroup, number>> = { builtin: 0, external: 1, relative: 2 };

function collectImportIssues(sourceFile: ts.SourceFile): SourceOrderIssue[] {
  const issues: SourceOrderIssue[] = [];
  const imports = sourceFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier),
  );
  let previous: { group: ImportGroup; specifier: string } | undefined;
  for (const statement of imports) {
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
    const group = getImportGroup(specifier);
    const line = lineOf(sourceFile, statement);
    if (previous) {
      if (groupRank[group] < groupRank[previous.group]) {
        issues.push({
          detail: `${group} import '${specifier}' follows a ${previous.group} import`,
          line,
          rule: 'import-group-order',
        });
      } else if (group === previous.group && specifier.localeCompare(previous.specifier) < 0) {
        issues.push({
          detail: `import '${specifier}' precedes '${previous.specifier}' alphabetically`,
          line,
          rule: 'import-specifier-order',
        });
      }
    }
    previous = { group, specifier };
  }
  return issues;
}

// Only exported function declarations are ordered. Exported constants, types and re-export barrels
// carry their own organizing reasons, and a rule that moved them would fight the surrounding file.
function collectExportIssues(sourceFile: ts.SourceFile): SourceOrderIssue[] {
  const issues: SourceOrderIssue[] = [];
  let previousName: string | undefined;
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
    if (!ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const name = statement.name.text;
    if (previousName !== undefined && name.localeCompare(previousName) < 0) {
      issues.push({
        detail: `exported function ${name} precedes ${previousName} alphabetically`,
        line: lineOf(sourceFile, statement),
        rule: 'export-alphabetization',
      });
    }
    previousName = name;
  }
  return issues;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}
