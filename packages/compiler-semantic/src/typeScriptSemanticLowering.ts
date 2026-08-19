import path from 'node:path';

import ts from 'typescript';

import type {
  CompilerDiagnostic,
  IrClassDeclaration,
  IrClassField,
  IrClassMethod,
  IrDeclaration,
  IrEnumDeclaration,
  IrExpression,
  IrExport,
  IrFunctionDeclaration,
  IrFunctionSignature,
  IrImport,
  IrInterfaceDeclaration,
  IrObjectMember,
  IrObjectTypeMember,
  IrParameter,
  IrStatement,
  IrType,
  IrTypeDeclaration,
  IrTypeParameter,
  IrVariable,
  IrVariableDeclaration,
  LoweringResult,
  LowerTypeScriptSourceOptions,
  SourceOrigin,
} from '../../compiler-types/src/index.js';
import { fingerprintTypeScriptNode } from '../../compiler-provenance/src/index.js';

interface LoweringContext {
  diagnostics: CompilerDiagnostic[];
  options: Readonly<LowerTypeScriptSourceOptions>;
  sourceFile: ts.SourceFile;
}

interface UnsupportedSyntaxFailure extends Error {
  kind: 'unsupported-syntax';
  node: ts.Node;
}

export function lowerTypeScriptSource(
  sourceFile: ts.SourceFile,
  options: Readonly<LowerTypeScriptSourceOptions>,
): LoweringResult {
  const context: LoweringContext = { diagnostics: [], options, sourceFile };
  const declarations: IrDeclaration[] = [];
  const exports: IrExport[] = [];
  const pendingOverloads = new Map<string, IrFunctionSignature[]>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      continue;
    }
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      try {
        exports.push(...lowerExport(statement, context));
      } catch (error) {
        if (!isUnsupportedSyntaxFailure(error)) throw error;
        context.diagnostics.push(diagnostic(error.node, error.message, context));
      }
      continue;
    }
    try {
      if (ts.isFunctionDeclaration(statement)) {
        const name = requiredDeclarationName(statement, context);
        if (!statement.body) {
          const overloads = pendingOverloads.get(name) ?? [];
          overloads.push(lowerFunctionSignature(statement, context));
          pendingOverloads.set(name, overloads);
          continue;
        }
        declarations.push(lowerFunction(statement, pendingOverloads.get(name) ?? [], context));
        if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
          exports.push({ exported: 'default', kind: 'local', local: name, typeOnly: false });
        }
        pendingOverloads.delete(name);
      } else if (ts.isVariableStatement(statement)) {
        declarations.push(...lowerVariableStatement(statement, context));
      } else if (ts.isTypeAliasDeclaration(statement)) {
        declarations.push(lowerTypeAlias(statement, context));
      } else if (ts.isInterfaceDeclaration(statement)) {
        declarations.push(lowerInterface(statement, context));
      } else if (ts.isEnumDeclaration(statement)) {
        declarations.push(lowerEnum(statement, context));
      } else if (ts.isClassDeclaration(statement)) {
        declarations.push(lowerClass(statement, context));
        if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
          exports.push({
            exported: 'default',
            kind: 'local',
            local: requiredDeclarationName(statement, context),
            typeOnly: false,
          });
        }
      } else if (ts.isModuleDeclaration(statement)) {
        unsupported(statement, 'namespace declarations are not represented in the neutral IR yet');
      } else if (!ts.isEmptyStatement(statement)) {
        unsupported(statement, `unsupported top-level ${ts.SyntaxKind[statement.kind]}`);
      }
    } catch (error) {
      if (!isUnsupportedSyntaxFailure(error)) throw error;
      context.diagnostics.push(diagnostic(error.node, error.message, context));
    }
  }

  for (const [name, overloads] of pendingOverloads) {
    context.diagnostics.push(
      diagnostic(
        sourceFile,
        `function overload ${name} has no implementation (${String(overloads.length)} signature(s))`,
        context,
      ),
    );
  }

  return {
    diagnostics: context.diagnostics,
    module: {
      declarations,
      exports,
      imports: lowerImports(sourceFile),
      name: moduleNameFromSource(sourceFile.fileName),
      packageName: options.packageName,
      source: relativeSource(sourceFile.fileName, options.upstreamDirectory),
    },
  };
}

function diagnostic(node: ts.Node, message: string, context: LoweringContext): CompilerDiagnostic {
  const start = node.getStart(context.sourceFile);
  const position = context.sourceFile.getLineAndCharacterOfPosition(start);
  return {
    code: 'unsupported-typescript',
    column: position.character + 1,
    line: position.line + 1,
    message,
    source: relativeSource(context.sourceFile.fileName, context.options.upstreamDirectory),
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function lowerClass(node: ts.ClassDeclaration, context: LoweringContext): IrClassDeclaration {
  const constructors = node.members.filter(ts.isConstructorDeclaration);
  if (constructors.length > 1) {
    unsupported(node, `class ${requiredDeclarationName(node, context)} has constructor overloads`);
  }
  const constructor = constructors[0];
  const parameterProperty = constructor?.parameters.find((parameter) =>
    [
      ts.SyntaxKind.PrivateKeyword,
      ts.SyntaxKind.ProtectedKeyword,
      ts.SyntaxKind.PublicKeyword,
      ts.SyntaxKind.ReadonlyKeyword,
    ].some((kind) => hasModifier(parameter, kind)),
  );
  if (parameterProperty) unsupported(parameterProperty, 'constructor parameter properties require field lowering');
  const fields: IrClassField[] = [];
  const methods: IrClassMethod[] = [];
  for (const member of node.members) {
    if (ts.isConstructorDeclaration(member)) continue;
    if (ts.isPropertyDeclaration(member)) {
      if (!member.type && !member.initializer) unsupported(member, 'class fields require a type or initializer');
      fields.push({
        ...(member.initializer ? { initializer: lowerExpression(member.initializer, context) } : {}),
        name: propertyName(member.name, context),
        optional: member.questionToken !== undefined,
        readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
        static: hasModifier(member, ts.SyntaxKind.StaticKeyword),
        type: member.type ? lowerType(member.type, context) : inferInitializerType(member.initializer!, context),
        visibility: visibility(member),
      });
      continue;
    }
    if (ts.isMethodDeclaration(member)) {
      if (!member.body) unsupported(member, 'class method overloads are not represented yet');
      const signature = lowerFunctionSignature(member, context);
      methods.push({
        ...signature,
        async: hasModifier(member, ts.SyntaxKind.AsyncKeyword),
        body: lowerStatementList(member.body.statements, context),
        name: propertyName(member.name, context),
        static: hasModifier(member, ts.SyntaxKind.StaticKeyword),
        visibility: visibility(member),
      });
      continue;
    }
    unsupported(member, `unsupported class member ${ts.SyntaxKind[member.kind]}`);
  }
  const extendsClause = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
  const implementsClause = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword);
  if (extendsClause && extendsClause.types.length !== 1)
    unsupported(extendsClause, 'classes must extend one base type');
  return {
    abstract: hasModifier(node, ts.SyntaxKind.AbstractKeyword),
    constructorBody: constructor?.body ? lowerStatementList(constructor.body.statements, context) : [],
    constructorParameters: constructor
      ? constructor.parameters.map((parameter) => lowerParameter(parameter, context))
      : [],
    exported: isExported(node),
    ...(extendsClause?.types[0] ? { extends: lowerExpressionWithTypeArguments(extendsClause.types[0], context) } : {}),
    fields,
    implements: implementsClause?.types.map((type) => lowerExpressionWithTypeArguments(type, context)) ?? [],
    kind: 'class',
    methods,
    name: requiredDeclarationName(node, context),
    origin: origin(node, context),
    typeParameters: lowerTypeParameters(node.typeParameters, context),
  };
}

function lowerEnum(node: ts.EnumDeclaration, context: LoweringContext): IrEnumDeclaration {
  const values = new Map<string, number | string>();
  let previous: number | undefined;
  const members = node.members.map((member, index) => {
    const name = propertyName(member.name, context);
    if (!member.initializer && index > 0 && previous === undefined) {
      unsupported(member, 'enum member after a string value requires an initializer');
    }
    const value = member.initializer
      ? evaluateEnumConstant(member.initializer, values, node.name.text)
      : previous === undefined
        ? 0
        : previous + 1;
    previous = typeof value === 'number' ? value : undefined;
    values.set(name, value);
    return { name, value };
  });
  return {
    exported: isExported(node),
    kind: 'enum',
    members,
    name: node.name.text,
    origin: origin(node, context),
  };
}

function evaluateEnumConstant(
  node: ts.Expression,
  values: ReadonlyMap<string, number | string>,
  enumName: string,
): number | string {
  if (ts.isParenthesizedExpression(node)) return evaluateEnumConstant(node.expression, values, enumName);
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''));
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) {
    const value = values.get(node.text);
    if (value !== undefined) return value;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === enumName) {
    const value = values.get(node.name.text);
    if (value !== undefined) return value;
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
  ) {
    const operand = evaluateEnumConstant(node.operand, values, enumName);
    if (typeof operand === 'number') return node.operator === ts.SyntaxKind.MinusToken ? -operand : operand;
  }
  if (ts.isBinaryExpression(node)) {
    const left = evaluateEnumConstant(node.left, values, enumName);
    const right = evaluateEnumConstant(node.right, values, enumName);
    if (typeof left === 'number' && typeof right === 'number') {
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken:
          return left + right;
        case ts.SyntaxKind.MinusToken:
          return left - right;
        case ts.SyntaxKind.AsteriskToken:
          return left * right;
        case ts.SyntaxKind.SlashToken:
          return left / right;
        case ts.SyntaxKind.PercentToken:
          return left % right;
        case ts.SyntaxKind.AsteriskAsteriskToken:
          return left ** right;
        case ts.SyntaxKind.LessThanLessThanToken:
          return left << right;
        case ts.SyntaxKind.GreaterThanGreaterThanToken:
          return left >> right;
        case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
          return left >>> right;
        case ts.SyntaxKind.AmpersandToken:
          return left & right;
        case ts.SyntaxKind.BarToken:
          return left | right;
        case ts.SyntaxKind.CaretToken:
          return left ^ right;
      }
    }
  }
  unsupported(node, 'enum initializer must be a constant number, string, or prior member reference');
}

function lowerExport(node: ts.ExportDeclaration | ts.ExportAssignment, context: LoweringContext): IrExport[] {
  if (ts.isExportAssignment(node)) {
    if (node.isExportEquals) unsupported(node, 'export = assignments are not ECMAScript exports');
    return [{ expression: lowerExpression(node.expression, context), kind: 'default' }];
  }
  const typeOnly = node.isTypeOnly;
  const specifier =
    node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
  if (!node.exportClause) {
    if (!specifier) unsupported(node, 'export-all declaration requires a module specifier');
    return [{ kind: 'all', specifier, typeOnly }];
  }
  if (ts.isNamespaceExport(node.exportClause)) {
    if (!specifier) unsupported(node, 'namespace re-export requires a module specifier');
    return [{ exported: node.exportClause.name.text, kind: 'namespace', specifier, typeOnly }];
  }
  return node.exportClause.elements.map((element): IrExport => {
    const imported = element.propertyName?.text ?? element.name.text;
    const exported = element.name.text;
    const bindingTypeOnly = typeOnly || element.isTypeOnly;
    return specifier
      ? { exported, imported, kind: 'reexport', specifier, typeOnly: bindingTypeOnly }
      : { exported, kind: 'local', local: imported, typeOnly: bindingTypeOnly };
  });
}

function lowerExpression(node: ts.Expression, context: LoweringContext): IrExpression {
  if (ts.isParenthesizedExpression(node)) return lowerExpression(node.expression, context);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
    return { expression: lowerExpression(node.expression, context), kind: 'cast', type: lowerType(node.type, context) };
  }
  if (ts.isNonNullExpression(node)) return lowerExpression(node.expression, context);
  if (ts.isIdentifier(node)) return { kind: 'identifier', name: node.text };
  if (node.kind === ts.SyntaxKind.ThisKeyword) return { kind: 'identifier', name: 'this' };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'literal', value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: 'literal', value: null };
  if (ts.isNumericLiteral(node)) return { kind: 'literal', value: Number(node.text.replaceAll('_', '')) };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { kind: 'literal', value: node.text };
  if (ts.isArrayLiteralExpression(node)) {
    return {
      elements: node.elements.map((element) =>
        ts.isOmittedExpression(element) ? undefined : lowerExpression(element, context),
      ),
      kind: 'array',
    };
  }
  if (ts.isObjectLiteralExpression(node)) {
    return { kind: 'object', members: node.properties.map((member) => lowerObjectMember(member, context)) };
  }
  if (ts.isPropertyAccessExpression(node)) {
    return {
      kind: 'property',
      name: node.name.text,
      object: lowerExpression(node.expression, context),
      optional: node.questionDotToken !== undefined,
    };
  }
  if (ts.isElementAccessExpression(node)) {
    if (!node.argumentExpression) unsupported(node, 'element access requires an index');
    return {
      index: lowerExpression(node.argumentExpression, context),
      kind: 'element',
      object: lowerExpression(node.expression, context),
      optional: node.questionDotToken !== undefined,
    };
  }
  if (ts.isCallExpression(node)) {
    return {
      arguments: node.arguments.map((argument) => lowerExpression(argument, context)),
      callee: lowerExpression(node.expression, context),
      kind: 'call',
      optional: node.questionDotToken !== undefined,
      typeArguments: node.typeArguments?.map((type) => lowerType(type, context)) ?? [],
    };
  }
  if (ts.isNewExpression(node)) {
    return {
      arguments: node.arguments?.map((argument) => lowerExpression(argument, context)) ?? [],
      callee: lowerExpression(node.expression, context),
      kind: 'new',
      typeArguments: node.typeArguments?.map((type) => lowerType(type, context)) ?? [],
    };
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.getText(context.sourceFile);
    if (isAssignmentOperator(node.operatorToken.kind)) {
      return {
        kind: 'assignment',
        left: lowerExpression(node.left, context),
        operator,
        right: lowerExpression(node.right, context),
      };
    }
    return {
      kind: 'binary',
      left: lowerExpression(node.left, context),
      operator,
      right: lowerExpression(node.right, context),
    };
  }
  if (ts.isPrefixUnaryExpression(node)) {
    return {
      kind: 'unary',
      operand: lowerExpression(node.operand, context),
      operator: ts.tokenToString(node.operator) ?? node.getText(context.sourceFile).slice(0, 1),
      postfix: false,
    };
  }
  if (ts.isPostfixUnaryExpression(node)) {
    return {
      kind: 'unary',
      operand: lowerExpression(node.operand, context),
      operator: ts.tokenToString(node.operator) ?? node.getText(context.sourceFile).slice(-2),
      postfix: true,
    };
  }
  if (ts.isTypeOfExpression(node) || ts.isVoidExpression(node) || ts.isDeleteExpression(node)) {
    const operator = ts.isTypeOfExpression(node) ? 'typeof' : ts.isVoidExpression(node) ? 'void' : 'delete';
    return { kind: 'unary', operand: lowerExpression(node.expression, context), operator, postfix: false };
  }
  if (ts.isConditionalExpression(node)) {
    return {
      condition: lowerExpression(node.condition, context),
      kind: 'conditional',
      whenFalse: lowerExpression(node.whenFalse, context),
      whenTrue: lowerExpression(node.whenTrue, context),
    };
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const signature = lowerFunctionSignature(node, context);
    return {
      async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
      ...(ts.isBlock(node.body)
        ? { body: lowerStatementList(node.body.statements, context) }
        : { body: [], expression: lowerExpression(node.body, context) }),
      kind: 'function',
      ...(node.name ? { name: node.name.text } : {}),
      ...signature,
    };
  }
  if (ts.isAwaitExpression(node)) return { expression: lowerExpression(node.expression, context), kind: 'await' };
  if (ts.isTemplateExpression(node)) {
    const parts: Array<IrExpression | string> = [node.head.text];
    for (const span of node.templateSpans) {
      parts.push(lowerExpression(span.expression, context), span.literal.text);
    }
    return { kind: 'template', parts };
  }
  if (ts.isSpreadElement(node)) return { expression: lowerExpression(node.expression, context), kind: 'spread' };
  if (ts.isRegularExpressionLiteral(node)) {
    const lastSlash = node.text.lastIndexOf('/');
    return { flags: node.text.slice(lastSlash + 1), kind: 'regexp', pattern: node.text.slice(1, lastSlash) };
  }
  unsupported(node, `unsupported expression ${ts.SyntaxKind[node.kind]}`);
}

function lowerExpressionWithTypeArguments(node: ts.ExpressionWithTypeArguments, context: LoweringContext): IrType {
  return {
    kind: 'named',
    name: node.expression.getText(context.sourceFile),
    typeArguments: node.typeArguments?.map((type) => lowerType(type, context)) ?? [],
  };
}

function lowerFunction(
  node: ts.FunctionDeclaration,
  overloads: readonly IrFunctionSignature[],
  context: LoweringContext,
): IrFunctionDeclaration {
  if (!node.body) unsupported(node, 'function declaration requires a body');
  return {
    async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
    body: lowerStatementList(node.body.statements, context),
    exported: isExported(node),
    kind: 'function',
    name: requiredDeclarationName(node, context),
    origin: origin(node, context),
    overloads: [...overloads],
    ...lowerFunctionSignature(node, context),
  };
}

function lowerFunctionSignature(node: ts.SignatureDeclaration, context: LoweringContext): IrFunctionSignature {
  return {
    parameters: node.parameters
      .filter((parameter) => !isThisParameter(parameter))
      .map((item) => lowerParameter(item, context)),
    returns: node.type ? lowerType(node.type, context) : { kind: 'unknown', source: 'any' },
    typeParameters: lowerTypeParameters(node.typeParameters, context),
  };
}

function lowerImports(sourceFile: ts.SourceFile): IrImport[] {
  return sourceFile.statements.flatMap((statement): IrImport[] => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const bindings: IrImport['bindings'] = [];
    const clause = statement.importClause;
    if (clause?.name) bindings.push({ imported: 'default', local: clause.name.text, typeOnly: clause.isTypeOnly });
    const namedBindings = clause?.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      bindings.push({ imported: '*', local: namedBindings.name.text, typeOnly: clause.isTypeOnly });
    } else if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const binding of namedBindings.elements) {
        bindings.push({
          imported: binding.propertyName?.text ?? binding.name.text,
          local: binding.name.text,
          typeOnly: clause.isTypeOnly || binding.isTypeOnly,
        });
      }
    }
    return [{ bindings, specifier: statement.moduleSpecifier.text }];
  });
}

function lowerInterface(node: ts.InterfaceDeclaration, context: LoweringContext): IrInterfaceDeclaration {
  return {
    exported: isExported(node),
    extends:
      node.heritageClauses?.flatMap((clause) =>
        clause.types.map((type) => lowerExpressionWithTypeArguments(type, context)),
      ) ?? [],
    kind: 'interface',
    members: lowerTypeMembers(node.members, context),
    name: node.name.text,
    origin: origin(node, context),
    typeParameters: lowerTypeParameters(node.typeParameters, context),
  };
}

function lowerObjectMember(node: ts.ObjectLiteralElementLike, context: LoweringContext): IrObjectMember {
  if (ts.isSpreadAssignment(node)) return { expression: lowerExpression(node.expression, context), kind: 'spread' };
  if (ts.isShorthandPropertyAssignment(node)) {
    return { kind: 'property', name: node.name.text, value: { kind: 'identifier', name: node.name.text } };
  }
  if (ts.isPropertyAssignment(node)) {
    if (ts.isComputedPropertyName(node.name)) {
      return {
        key: lowerExpression(node.name.expression, context),
        kind: 'computedProperty',
        value: lowerExpression(node.initializer, context),
      };
    }
    return {
      kind: 'property',
      name: propertyName(node.name, context),
      value: lowerExpression(node.initializer, context),
    };
  }
  if (ts.isMethodDeclaration(node)) {
    if (!node.body) unsupported(node, 'object methods require a body');
    const signature = lowerFunctionSignature(node, context);
    return {
      kind: 'property',
      name: propertyName(node.name, context),
      value: {
        async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
        body: lowerStatementList(node.body.statements, context),
        kind: 'function',
        ...signature,
      },
    };
  }
  unsupported(node, `unsupported object member ${ts.SyntaxKind[node.kind]}`);
}

function lowerParameter(node: ts.ParameterDeclaration, context: LoweringContext): IrParameter {
  if (!ts.isIdentifier(node.name)) unsupported(node.name, 'destructured parameters are not represented yet');
  return {
    ...(node.initializer ? { initializer: lowerExpression(node.initializer, context) } : {}),
    name: node.name.text,
    optional: node.questionToken !== undefined || node.initializer !== undefined,
    rest: node.dotDotDotToken !== undefined,
    type: node.type
      ? lowerType(node.type, context)
      : node.initializer
        ? inferInitializerType(node.initializer, context)
        : { kind: 'unknown', source: 'any' },
  };
}

function lowerStatement(node: ts.Statement, context: LoweringContext): IrStatement {
  if (ts.isBlock(node)) return { kind: 'block', statements: lowerStatementList(node.statements, context) };
  if (ts.isExpressionStatement(node))
    return { expression: lowerExpression(node.expression, context), kind: 'expression' };
  if (ts.isReturnStatement(node)) {
    return { ...(node.expression ? { expression: lowerExpression(node.expression, context) } : {}), kind: 'return' };
  }
  if (ts.isVariableStatement(node))
    return { declarations: lowerVariables(node.declarationList, context), kind: 'variable' };
  if (ts.isIfStatement(node)) {
    return {
      condition: lowerExpression(node.expression, context),
      consequent: lowerStatement(node.thenStatement, context),
      kind: 'if',
      ...(node.elseStatement ? { otherwise: lowerStatement(node.elseStatement, context) } : {}),
    };
  }
  if (ts.isWhileStatement(node)) {
    return {
      body: lowerStatement(node.statement, context),
      condition: lowerExpression(node.expression, context),
      kind: 'while',
    };
  }
  if (ts.isDoStatement(node)) {
    return {
      body: lowerStatement(node.statement, context),
      condition: lowerExpression(node.expression, context),
      kind: 'do',
    };
  }
  if (ts.isForStatement(node)) {
    return {
      body: lowerStatement(node.statement, context),
      ...(node.condition ? { condition: lowerExpression(node.condition, context) } : {}),
      ...(node.incrementor ? { increment: lowerExpression(node.incrementor, context) } : {}),
      ...(node.initializer
        ? {
            initializer: ts.isVariableDeclarationList(node.initializer)
              ? lowerVariables(node.initializer, context)
              : lowerExpression(node.initializer, context),
          }
        : {}),
      kind: 'for',
    };
  }
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    if (!ts.isVariableDeclarationList(node.initializer) || node.initializer.declarations.length !== 1) {
      unsupported(node.initializer, 'for bindings must be a single variable declaration');
    }
    const variable = lowerVariables(node.initializer, context)[0]!;
    return ts.isForOfStatement(node)
      ? {
          await: node.awaitModifier !== undefined,
          body: lowerStatement(node.statement, context),
          iterable: lowerExpression(node.expression, context),
          kind: 'forOf',
          variable,
        }
      : {
          body: lowerStatement(node.statement, context),
          kind: 'forIn',
          object: lowerExpression(node.expression, context),
          variable,
        };
  }
  if (ts.isSwitchStatement(node)) {
    return {
      cases: node.caseBlock.clauses.map((clause) => ({
        ...(ts.isCaseClause(clause) ? { expression: lowerExpression(clause.expression, context) } : {}),
        statements: lowerStatementList(clause.statements, context),
      })),
      expression: lowerExpression(node.expression, context),
      kind: 'switch',
    };
  }
  if (ts.isBreakStatement(node)) return { kind: 'break' };
  if (ts.isContinueStatement(node)) return { kind: 'continue' };
  if (ts.isThrowStatement(node)) return { expression: lowerExpression(node.expression, context), kind: 'throw' };
  if (ts.isTryStatement(node)) {
    const catchName = node.catchClause?.variableDeclaration?.name;
    if (catchName && !ts.isIdentifier(catchName))
      unsupported(catchName, 'destructured catch bindings are not represented');
    return {
      ...(node.catchClause
        ? {
            catchBody: lowerStatement(node.catchClause.block, context),
            ...(catchName ? { catchName: catchName.text } : {}),
          }
        : {}),
      ...(node.finallyBlock ? { finallyBody: lowerStatement(node.finallyBlock, context) } : {}),
      kind: 'try',
      tryBody: lowerStatement(node.tryBlock, context),
    };
  }
  if (ts.isEmptyStatement(node)) return { kind: 'block', statements: [] };
  unsupported(node, `unsupported statement ${ts.SyntaxKind[node.kind]}`);
}

function lowerStatementList(nodes: readonly ts.Statement[], context: LoweringContext): IrStatement[] {
  return nodes.map((node) => lowerStatement(node, context));
}

function lowerType(node: ts.TypeNode, context: LoweringContext): IrType {
  switch (node.kind) {
    case ts.SyntaxKind.AnyKeyword:
      return { kind: 'unknown', source: 'any' };
    case ts.SyntaxKind.UnknownKeyword:
      return { kind: 'unknown', source: 'unknown' };
    case ts.SyntaxKind.ObjectKeyword:
      return { kind: 'unknown', source: 'object' };
    case ts.SyntaxKind.ThisType:
      return { kind: 'unknown', source: 'this' };
    case ts.SyntaxKind.NeverKeyword:
      return { kind: 'never' };
    case ts.SyntaxKind.UndefinedKeyword:
      return { kind: 'undefined' };
    case ts.SyntaxKind.BooleanKeyword:
      return { kind: 'primitive', name: 'boolean' };
    case ts.SyntaxKind.NumberKeyword:
      return { kind: 'primitive', name: 'number' };
    case ts.SyntaxKind.BigIntKeyword:
      return { kind: 'primitive', name: 'bigint' };
    case ts.SyntaxKind.StringKeyword:
      return { kind: 'primitive', name: 'string' };
    case ts.SyntaxKind.SymbolKeyword:
      return { kind: 'primitive', name: 'symbol' };
    case ts.SyntaxKind.VoidKeyword:
      return { kind: 'primitive', name: 'void' };
  }
  if (ts.isParenthesizedTypeNode(node)) return lowerType(node.type, context);
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText(context.sourceFile);
    const arguments_ = node.typeArguments?.map((type) => lowerType(type, context)) ?? [];
    if ((name === 'Array' || name === 'ReadonlyArray') && arguments_.length === 1) {
      return { element: arguments_[0]!, kind: 'array', readonly: name === 'ReadonlyArray' };
    }
    return { kind: 'named', name, typeArguments: arguments_ };
  }
  if (ts.isArrayTypeNode(node))
    return { element: lowerType(node.elementType, context), kind: 'array', readonly: false };
  if (ts.isTupleTypeNode(node)) {
    return {
      elements: node.elements.map((element) => {
        if (ts.isOptionalTypeNode(element))
          return { optional: true, rest: false, type: lowerType(element.type, context) };
        if (ts.isRestTypeNode(element)) return { optional: false, rest: true, type: lowerType(element.type, context) };
        if (ts.isNamedTupleMember(element)) {
          return {
            optional: element.questionToken !== undefined,
            rest: element.dotDotDotToken !== undefined,
            type: lowerType(element.type, context),
          };
        }
        return { optional: false, rest: false, type: lowerType(element, context) };
      }),
      kind: 'tuple',
      readonly: false,
    };
  }
  if (ts.isUnionTypeNode(node)) return { kind: 'union', types: node.types.map((type) => lowerType(type, context)) };
  if (ts.isIntersectionTypeNode(node)) {
    return { kind: 'intersection', types: node.types.map((type) => lowerType(type, context)) };
  }
  if (ts.isFunctionTypeNode(node)) return { kind: 'function', ...lowerFunctionSignature(node, context) };
  if (ts.isTypeLiteralNode(node)) return { kind: 'object', members: lowerTypeMembers(node.members, context) };
  if (ts.isLiteralTypeNode(node)) {
    if (node.literal.kind === ts.SyntaxKind.NullKeyword) return { kind: 'null' };
    if (ts.isStringLiteral(node.literal)) return { kind: 'literal', value: node.literal.text };
    if (ts.isNumericLiteral(node.literal)) return { kind: 'literal', value: Number(node.literal.text) };
    if (
      ts.isPrefixUnaryExpression(node.literal) &&
      node.literal.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(node.literal.operand)
    ) {
      return { kind: 'literal', value: -Number(node.literal.operand.text) };
    }
    if (node.literal.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'literal', value: true };
    if (node.literal.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: false };
    unsupported(node, 'unsupported literal type');
  }
  if (ts.isTypeOperatorNode(node)) {
    if (node.operator === ts.SyntaxKind.KeyOfKeyword) return { kind: 'keyof', type: lowerType(node.type, context) };
    if (node.operator === ts.SyntaxKind.ReadonlyKeyword) {
      const type = lowerType(node.type, context);
      if (type.kind === 'array' || type.kind === 'tuple') return { ...type, readonly: true };
      return type;
    }
    unsupported(node, `unsupported type operator ${ts.tokenToString(node.operator) ?? String(node.operator)}`);
  }
  if (ts.isIndexedAccessTypeNode(node)) {
    return {
      index: lowerType(node.indexType, context),
      kind: 'indexedAccess',
      object: lowerType(node.objectType, context),
    };
  }
  if (ts.isTypeQueryNode(node)) return { kind: 'typeOf', name: node.exprName.getText(context.sourceFile) };
  unsupported(node, `unsupported type ${ts.SyntaxKind[node.kind]}`);
}

function lowerTypeAlias(node: ts.TypeAliasDeclaration, context: LoweringContext): IrTypeDeclaration {
  return {
    exported: isExported(node),
    kind: 'type',
    name: node.name.text,
    origin: origin(node, context),
    type: lowerType(node.type, context),
    typeParameters: lowerTypeParameters(node.typeParameters, context),
  };
}

function lowerTypeMembers(members: readonly ts.TypeElement[], context: LoweringContext): IrObjectTypeMember[] {
  return members.map((member): IrObjectTypeMember => {
    if (ts.isPropertySignature(member)) {
      if (!member.type) unsupported(member, 'property signature requires a type');
      return {
        name: propertyName(member.name, context),
        optional: member.questionToken !== undefined,
        readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
        type: lowerType(member.type, context),
      };
    }
    if (ts.isMethodSignature(member)) {
      return {
        name: propertyName(member.name, context),
        optional: member.questionToken !== undefined,
        readonly: true,
        type: { kind: 'function', ...lowerFunctionSignature(member, context) },
      };
    }
    unsupported(member, `unsupported type member ${ts.SyntaxKind[member.kind]}`);
  });
}

function lowerTypeParameters(
  nodes: readonly ts.TypeParameterDeclaration[] | undefined,
  context: LoweringContext,
): IrTypeParameter[] {
  return (
    nodes?.map((node) => ({
      ...(node.constraint ? { constraint: lowerType(node.constraint, context) } : {}),
      ...(node.default ? { default: lowerType(node.default, context) } : {}),
      name: node.name.text,
    })) ?? []
  );
}

function lowerVariables(node: ts.VariableDeclarationList, context: LoweringContext): IrVariable[] {
  const mutable = !(node.flags & ts.NodeFlags.Const);
  return node.declarations.map((declaration) => lowerVariable(declaration, mutable, context));
}

function lowerVariable(node: ts.VariableDeclaration, mutable: boolean, context: LoweringContext): IrVariable {
  if (!ts.isIdentifier(node.name)) unsupported(node.name, 'destructured variables are not represented yet');
  return {
    ...(node.initializer ? { initializer: lowerExpression(node.initializer, context) } : {}),
    mutable,
    name: node.name.text,
    ...(node.type
      ? { type: lowerType(node.type, context) }
      : node.initializer
        ? { type: inferInitializerType(node.initializer, context) }
        : {}),
  };
}

function lowerVariableStatement(node: ts.VariableStatement, context: LoweringContext): IrVariableDeclaration[] {
  return lowerVariables(node.declarationList, context).map((variable, index) => ({
    ...variable,
    exported: isExported(node),
    kind: 'variable',
    origin: origin(node.declarationList.declarations[index]!, context),
  }));
}

function inferInitializerType(node: ts.Expression, context: LoweringContext): IrType {
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: 'primitive', name: 'boolean' };
  }
  if (ts.isNumericLiteral(node)) return { kind: 'primitive', name: 'number' };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { kind: 'primitive', name: 'string' };
  if (ts.isArrayLiteralExpression(node)) {
    const elementTypes = node.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : [inferInitializerType(element, context)],
    );
    return {
      element: elementTypes.length === 0 ? { kind: 'unknown', source: 'any' } : commonType(elementTypes),
      kind: 'array',
      readonly: false,
    };
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return { kind: 'function', ...lowerFunctionSignature(node, context) };
  }
  return { kind: 'unknown', source: 'any' };
}

function commonType(types: IrType[]): IrType {
  const serialized = new Map(types.map((type) => [JSON.stringify(type), type]));
  return serialized.size === 1 ? serialized.values().next().value! : { kind: 'union', types: [...serialized.values()] };
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isThisParameter(node: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(node.name) && node.name.text === 'this';
}

function moduleNameFromSource(file: string): string {
  const name = path.basename(file).replace(/\.tsx?$/u, '');
  return name === 'index' ? 'Index' : `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

function origin(node: ts.Node, context: LoweringContext): SourceOrigin {
  const start = node.getStart(context.sourceFile);
  const position = context.sourceFile.getLineAndCharacterOfPosition(start);
  return {
    column: position.character + 1,
    fingerprint: fingerprintTypeScriptNode(node, context.sourceFile),
    line: position.line + 1,
    packageName: context.options.packageName,
    source: relativeSource(context.sourceFile.fileName, context.options.upstreamDirectory),
  };
}

function propertyName(node: ts.PropertyName, _context: LoweringContext): string {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  unsupported(node, 'computed property names require expression-level representation');
}

function relativeSource(file: string, upstreamDirectory: string): string {
  const relative = path.relative(path.resolve(upstreamDirectory), path.resolve(file));
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Source is outside upstream checkout: ${file}`);
  }
  return relative.split(path.sep).join('/');
}

function requiredDeclarationName(
  node: ts.ClassDeclaration | ts.FunctionDeclaration,
  _context: LoweringContext,
): string {
  if (!node.name)
    unsupported(node, `anonymous default ${ts.isClassDeclaration(node) ? 'class' : 'function'} is unsupported`);
  return node.name.text;
}

function unsupported(node: ts.Node, message: string): never {
  const failure = Object.assign(new Error(message), {
    kind: 'unsupported-syntax' as const,
    node,
  });
  failure.name = 'UnsupportedSyntaxError';
  throw failure;
}

function isUnsupportedSyntaxFailure(value: unknown): value is UnsupportedSyntaxFailure {
  return value instanceof Error && 'kind' in value && value.kind === 'unsupported-syntax' && 'node' in value;
}

function visibility(node: ts.Node): 'private' | 'protected' | 'public' {
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return 'private';
  if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return 'protected';
  return 'public';
}
