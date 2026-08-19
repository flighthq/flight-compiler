import ts from 'typescript';

import { getImportGroup } from './sourceOrdering.js';

// Rewrites the leading import block into group order: `node:` builtins, then external packages, then
// relative specifiers, alphabetized within each group and separated by one blank line.
//
// It refuses two cases rather than guessing. A comment inside the import block would have to be
// re-attached to whichever import it describes, and getting that wrong moves a comment onto an
// unrelated line — worse than leaving the file alone. A rewrite that changes the set of imported
// specifiers is a bug in this function, so the result is verified before it is offered and discarded
// if it does not match.
//
// Exported-function order is deliberately not rewritten. Moving a function body is a different class
// of edit, and `order:check` reporting it costs a reader one manual move against the risk of a
// mechanical one going wrong silently.

export type ImportBlockRewrite =
  | { readonly kind: 'ordered'; readonly text: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'unchanged' };

export function rewriteImportBlock(sourceFile: ts.SourceFile, contents: string): ImportBlockRewrite {
  const imports: ts.ImportDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) break;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) return { kind: 'refused', reason: 'a non-literal specifier' };
    imports.push(statement);
  }
  if (imports.length < 2) return { kind: 'unchanged' };

  const start = imports[0]!.getStart(sourceFile);
  const end = imports.at(-1)!.getEnd();
  const block = contents.slice(start, end);
  if (/\/\/|\/\*/u.test(block)) return { kind: 'refused', reason: 'a comment inside the import block' };

  const entries = imports.map((statement) => ({
    group: getImportGroup((statement.moduleSpecifier as ts.StringLiteral).text),
    specifier: (statement.moduleSpecifier as ts.StringLiteral).text,
    text: contents.slice(statement.getStart(sourceFile), statement.getEnd()),
  }));
  const groups: readonly ('builtin' | 'external' | 'relative')[] = ['builtin', 'external', 'relative'];
  const ordered = groups
    .map((group) =>
      entries
        .filter((entry) => entry.group === group)
        .sort((left, right) => left.specifier.localeCompare(right.specifier))
        .map((entry) => entry.text)
        .join('\n'),
    )
    .filter((text) => text.length > 0)
    .join('\n\n');
  if (ordered === block) return { kind: 'unchanged' };

  const rewritten = contents.slice(0, start) + ordered + contents.slice(end);
  const verified = ts.createSourceFile(sourceFile.fileName, rewritten, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (!sameSpecifiers(sourceFile, verified)) return { kind: 'refused', reason: 'the rewrite changed the imported set' };
  return { kind: 'ordered', text: rewritten };
}

function sameSpecifiers(left: ts.SourceFile, right: ts.SourceFile): boolean {
  const specifiers = (source: ts.SourceFile): string[] =>
    source.statements
      .filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement))
      .map((statement) => (ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '?'))
      .sort();
  return JSON.stringify(specifiers(left)) === JSON.stringify(specifiers(right));
}
