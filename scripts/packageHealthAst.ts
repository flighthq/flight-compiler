import ts from 'typescript';

export interface ExportedApiDeclaration {
  kind: 'function' | 'type' | 'value';
  name: string;
}

export interface CompilerTextOrderingViolation {
  readonly kind: 'local-text-comparator' | 'locale-compare';
  readonly node: ts.Node;
}

export function collectCompilerTextOrderingViolations(
  sourceFile: ts.SourceFile,
  allowLocalTextComparator: boolean,
): readonly CompilerTextOrderingViolation[] {
  const violations: CompilerTextOrderingViolation[] = [];
  const visit = (node: ts.Node): void => {
    const localComparatorName = ts.isFunctionDeclaration(node)
      ? node.name?.text
      : ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ? node.name.text
        : undefined;
    if (!allowLocalTextComparator && localComparatorName && /^compare.*(?:String|Text)/u.test(localComparatorName)) {
      violations.push({ kind: 'local-text-comparator', node });
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'localeCompare') {
      violations.push({ kind: 'locale-compare', node });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export function collectDescribeNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'describe' &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      names.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

export function isCompilerApiFunctionName(name: string): boolean {
  return compilerApiFunctionNamePattern.test(name);
}

export function isDomainTypeScriptFileName(fileName: string): boolean {
  const concept = fileName.replace(/\.test\.ts$/u, '').replace(/\.ts$/u, '');
  return (
    /^[a-z][A-Za-z0-9]*$/u.test(concept) &&
    !genericSourceConcepts.has(concept) &&
    !sourceVerbPrefixPattern.test(concept)
  );
}

export function collectExportedApiDeclarations(sourceFile: ts.SourceFile): readonly ExportedApiDeclaration[] {
  const localExports = collectLocalExports(sourceFile);
  const declarations = new Map<string, ExportedApiDeclaration>();
  const add = (localName: string, kind: ExportedApiDeclaration['kind'], directlyExported: boolean): void => {
    const exportedNames = new Set(localExports.get(localName) ?? []);
    if (directlyExported) exportedNames.add(localName);
    for (const name of exportedNames) declarations.set(`${kind}\0${name}`, { kind, name });
  };

  for (const statement of sourceFile.statements) {
    const directlyExported = hasExportModifier(statement);
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      add(statement.name.text, 'function', directlyExported);
    } else if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      add(statement.name.text, 'type', directlyExported);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of collectBindingNames(declaration.name)) add(name, 'value', directlyExported);
      }
    }
  }
  return [...declarations.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind),
  );
}

export function containsTransientWorkComment(contents: string): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, contents);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) &&
      /\b(?:FIXME|TODO)\b/u.test(scanner.getTokenText())
    ) {
      return true;
    }
  }
  return false;
}

export function collectLocalExportNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const element of statement.exportClause.elements) names.add((element.propertyName ?? element.name).text);
  }
  return names;
}

export function collectModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers = new Set<string>();
  const add = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) specifiers.add(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...specifiers].sort();
}

export function isExportedContractDeclaration(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  localExportNames: ReadonlySet<string>,
): node is ts.InterfaceDeclaration | ts.TypeAliasDeclaration {
  return (
    (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
    (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true ||
      (node.parent === sourceFile && localExportNames.has(node.name.text)))
  );
}

function collectBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : collectBindingNames(element.name)));
}

function collectLocalExports(sourceFile: ts.SourceFile): ReadonlyMap<string, readonly string[]> {
  const exportsByLocalName = new Map<string, string[]>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      const localName = (element.propertyName ?? element.name).text;
      const exportedNames = exportsByLocalName.get(localName) ?? [];
      exportedNames.push(element.name.text);
      exportsByLocalName.set(localName, exportedNames);
    }
  }
  return exportsByLocalName;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  );
}

const compilerApiFunctionNamePattern =
  /^(?:analyze|apply|collect|combine|compare|compile|convert|create|define|emit|fingerprint|get|has|indent|is|lower|normalize|parse|read|resolve|validate)[A-Z][A-Za-z0-9]*$/u;
const genericSourceConcepts = new Set(['common', 'helper', 'helpers', 'internal', 'shared', 'util', 'utils']);
const sourceVerbPrefixPattern =
  /^(?:analyze|apply|collect|combine|compare|compile|convert|create|define|emit|fingerprint|get|has|indent|is|lower|normalize|parse|read|resolve|validate)(?:$|[A-Z])/u;
