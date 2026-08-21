import path from 'node:path';

import ts from 'typescript';

import { normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import { fingerprintTypeScriptNode } from '../../compiler-provenance/src/index.js';
import type {
  CompilerDiagnostic,
  CompilerSourceOrigin,
  IrAssignmentOperator,
  IrAssignmentOperatorSemantics,
  IrBindingPattern,
  IrBindingPatternElement,
  IrBindingIdentity,
  IrBindingKind,
  IrBindingScope,
  IrBinaryOperator,
  IrBinaryOperatorSemantics,
  IrClassDeclaration,
  IrClassField,
  IrClassMethod,
  IrCallSemantics,
  IrDeclaration,
  IrEnumDeclaration,
  IrExpression,
  IrExport,
  IrFunctionDeclaration,
  IrFunctionSignature,
  IrFunctionTypeParameter,
  IrImport,
  IrImportBinding,
  IrIdentifierReference,
  IrInterfaceDeclaration,
  IrIndexedReceiver,
  IrObjectMember,
  IrObjectTypeProperty,
  IrOperatorOperandDomains,
  IrOperatorValueDomain,
  IrParameter,
  IrPostfixUnaryOperator,
  IrPrefixUnaryOperator,
  IrStatement,
  IrTupleTypeElement,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeBindingIdentity,
  IrTypeNameReference,
  IrTypeParameter,
  IrTypeReference,
  IrUnaryOperatorSemantics,
  IrTypedArrayReceiver,
  IrValueNameReference,
  IrVariable,
  IrVariableDeclaration,
  TypeScriptLoweringResult,
  LowerTypeScriptSourceOptions,
} from '../../compiler-types/src/index.js';

interface LoweringContext {
  bindings: Map<ts.Symbol, IrBindingIdentity>;
  checker: ts.TypeChecker;
  diagnostics: CompilerDiagnostic[];
  options: Readonly<LowerTypeScriptSourceOptions>;
  sourceFile: ts.SourceFile;
  typeBindings: Map<ts.Symbol, IrTypeBindingIdentity>;
}

interface TypeScriptAnalysis {
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
}

interface UnsupportedSyntaxFailure extends Error {
  kind: 'unsupported-syntax';
  node: ts.Node;
}

type TypeScriptBinaryOperator = Exclude<ts.BinaryOperator, ts.AssignmentOperator>;

export function lowerTypeScriptSource(
  sourceFile: ts.SourceFile,
  options: Readonly<LowerTypeScriptSourceOptions>,
): TypeScriptLoweringResult {
  const analysis = createTypeScriptAnalysis(sourceFile);
  const context: LoweringContext = {
    bindings: new Map(),
    checker: analysis.checker,
    diagnostics: [],
    options,
    sourceFile: analysis.sourceFile,
    typeBindings: new Map(),
  };
  const declarations: IrDeclaration[] = [];
  const exports: IrExport[] = [];
  const pendingOverloads = new Map<string, IrFunctionSignature[]>();

  for (const statement of context.sourceFile.statements) {
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
          exports.push({
            binding: lowerBindingIdentity(statement.name!, context),
            exported: 'default',
            kind: 'local',
            typeOnly: false,
          });
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
            binding: lowerBindingIdentity(statement.name!, context),
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
        context.sourceFile,
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
      imports: lowerImports(context.sourceFile, context),
      name: moduleNameFromSource(context.sourceFile.fileName),
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
    packageName: context.options.packageName,
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
  requiredDeclarationName(node, context);
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
      const type = member.type ? lowerType(member.type, context) : inferInitializerType(member.initializer!, context);
      fields.push({
        ...(member.initializer ? { initializer: lowerExpression(member.initializer, context, type) } : {}),
        name: propertyName(member.name, context),
        optional: member.questionToken !== undefined,
        readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
        static: hasModifier(member, ts.SyntaxKind.StaticKeyword),
        type,
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
    binding: lowerBindingIdentity(node.name!, context),
    ...(constructor
      ? {
          classConstructor: {
            body: constructor.body ? lowerStatementList(constructor.body.statements, context) : [],
            parameters: constructor.parameters.map((parameter) => lowerParameter(parameter, context)),
          },
        }
      : {}),
    exported: isExported(node),
    ...(extendsClause?.types[0] ? { extends: lowerExpressionWithTypeArguments(extendsClause.types[0], context) } : {}),
    fields,
    implements: implementsClause?.types.map((type) => lowerExpressionWithTypeArguments(type, context)) ?? [],
    kind: 'class',
    methods,
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
    binding: lowerBindingIdentity(node.name, context),
    exported: isExported(node),
    kind: 'enum',
    members,
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
    const importedNode = element.propertyName ?? element.name;
    if (!ts.isIdentifier(importedNode)) unsupported(importedNode, 'local export names must be identifiers');
    const imported = importedNode.text;
    const exported = element.name.text;
    const bindingTypeOnly = typeOnly || element.isTypeOnly;
    if (specifier) return { exported, imported, kind: 'reexport', specifier, typeOnly: bindingTypeOnly };
    const binding = lowerExportBindingIdentity(element, importedNode, context);
    return binding.space === 'type'
      ? { binding, exported, kind: 'local', typeOnly: true }
      : { binding, exported, kind: 'local', typeOnly: bindingTypeOnly };
  });
}

function lowerExpression(
  node: ts.Expression,
  context: LoweringContext,
  contextualType?: Readonly<IrType>,
): IrExpression {
  if (ts.isParenthesizedExpression(node)) return lowerExpression(node.expression, context, contextualType);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
    const type = lowerType(node.type, context);
    return { expression: lowerExpression(node.expression, context, type), kind: 'cast', type };
  }
  if (ts.isNonNullExpression(node)) return lowerExpression(node.expression, context, contextualType);
  if (ts.isIdentifier(node)) return { kind: 'identifier', reference: lowerIdentifierReference(node, context) };
  if (node.kind === ts.SyntaxKind.ThisKeyword) return { kind: 'identifier', reference: { kind: 'this' } };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'literal', value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: 'literal', value: null };
  if (ts.isNumericLiteral(node)) return { kind: 'literal', value: Number(node.text.replaceAll('_', '')) };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { kind: 'literal', value: node.text };
  if (ts.isArrayLiteralExpression(node)) {
    if (contextualType?.kind === 'tuple') return lowerTupleExpression(node, contextualType, context);
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
      semantics: lowerElementAccessSemantics(node.expression, context),
    };
  }
  if (ts.isCallExpression(node)) {
    return {
      arguments: node.arguments.map((argument) => lowerExpression(argument, context)),
      callee: lowerExpression(node.expression, context),
      kind: 'call',
      optional: node.questionDotToken !== undefined,
      semantics: lowerCallSemantics(node, context),
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
    if (isAssignmentOperator(node.operatorToken.kind)) {
      return {
        kind: 'assignment',
        left: lowerExpression(node.left, context),
        operator: lowerAssignmentOperator(node.operatorToken.kind),
        right: lowerExpression(node.right, context),
        semantics: lowerAssignmentOperatorSemantics(node, context),
      };
    }
    return {
      kind: 'binary',
      left: lowerExpression(node.left, context),
      operator: lowerBinaryOperator(node.operatorToken.kind),
      right: lowerExpression(node.right, context),
      semantics: lowerBinaryOperatorSemantics(node, context),
    };
  }
  if (ts.isPrefixUnaryExpression(node)) {
    return {
      kind: 'unary',
      operand: lowerExpression(node.operand, context),
      operator: lowerPrefixUnaryOperator(node.operator),
      postfix: false,
      semantics: lowerUnaryOperatorSemantics(node, node.operand, context),
    };
  }
  if (ts.isPostfixUnaryExpression(node)) {
    return {
      kind: 'unary',
      operand: lowerExpression(node.operand, context),
      operator: lowerPostfixUnaryOperator(node.operator),
      postfix: true,
      semantics: lowerUnaryOperatorSemantics(node, node.operand, context),
    };
  }
  if (ts.isTypeOfExpression(node) || ts.isVoidExpression(node) || ts.isDeleteExpression(node)) {
    const operator = ts.isTypeOfExpression(node) ? 'typeof' : ts.isVoidExpression(node) ? 'void' : 'delete';
    return {
      kind: 'unary',
      operand: lowerExpression(node.expression, context),
      operator,
      postfix: false,
      semantics: lowerUnaryOperatorSemantics(node, node.expression, context),
    };
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
      ...(node.name ? { binding: lowerBindingIdentity(node.name, context) } : {}),
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

function lowerTupleExpression(
  node: ts.ArrayLiteralExpression,
  type: Readonly<Extract<IrType, { kind: 'tuple' }>>,
  context: LoweringContext,
): IrExpression {
  const restIndex = type.elements.findIndex((element) => element.rest);
  if (restIndex >= 0) {
    return unsupported(node, `contextual tuple expression rest at index ${String(restIndex)} is not represented yet`);
  }
  if (node.elements.length > type.elements.length) {
    return unsupported(node, 'contextual tuple expression has more values than its fixed tuple type');
  }
  return {
    elements: type.elements.map((element, index) => {
      const value = node.elements[index];
      if (!value || ts.isOmittedExpression(value)) {
        if (!element.optional) {
          return unsupported(node, `contextual tuple expression requires a value at index ${String(index)}`);
        }
        return { optional: true };
      }
      if (ts.isSpreadElement(value)) {
        return unsupported(value, 'contextual tuple expression spread is not represented yet');
      }
      const expression = lowerExpression(value, context, element.type);
      return element.optional ? { expression, optional: true } : { expression, optional: false };
    }),
    kind: 'tuple',
  };
}

function lowerExpressionWithTypeArguments(
  node: ts.ExpressionWithTypeArguments,
  context: LoweringContext,
): IrTypeReference {
  return {
    kind: 'named',
    reference: lowerExpressionTypeNameReference(node.expression, context),
    typeArguments: node.typeArguments?.map((type) => lowerType(type, context)) ?? [],
  };
}

function lowerElementAccessSemantics(
  receiver: ts.Expression,
  context: LoweringContext,
): { receivers: [IrIndexedReceiver, ...IrIndexedReceiver[]] } {
  return { receivers: getTypeScriptExpressionIndexedReceiverSet(receiver, context) };
}

function getTypeScriptExpressionIndexedReceiverSet(
  receiver: ts.Expression,
  context: LoweringContext,
): [IrIndexedReceiver, ...IrIndexedReceiver[]] {
  const checked = lowerTypeScriptIndexedReceivers(context.checker.getTypeAtLocation(receiver), context.checker);
  const declared = getTypeScriptExpressionIndexedReceivers(receiver, context);
  const values = declared && checked.every((value) => value === 'object' || value === 'unknown') ? declared : checked;
  return values.length > 0 ? [values[0]!, ...values.slice(1)] : ['unknown'];
}

function getTypeScriptExpressionIndexedReceivers(
  expression: ts.Expression,
  context: LoweringContext,
): IrIndexedReceiver[] | undefined {
  if (ts.isArrayLiteralExpression(expression)) return ['array'];
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isTemplateExpression(expression)
  ) {
    return ['string'];
  }
  if (ts.isObjectLiteralExpression(expression)) return ['object'];
  if (ts.isNewExpression(expression)) {
    const name = ts.isIdentifier(expression.expression) ? expression.expression.text : undefined;
    const receiver = name ? typeScriptIndexedReceiverNames[name] : undefined;
    return receiver ? [receiver] : undefined;
  }
  const symbol = context.checker.getSymbolAtLocation(expression);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  const type =
    declaration &&
    (ts.isParameter(declaration) ||
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertySignature(declaration))
      ? declaration.type
      : undefined;
  return type ? getTypeScriptTypeNodeIndexedReceivers(type, context, new Set()) : undefined;
}

function getTypeScriptTypeNodeIndexedReceivers(
  node: ts.TypeNode,
  context: LoweringContext,
  seen: Set<ts.Symbol>,
): IrIndexedReceiver[] | undefined {
  if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) {
    return getTypeScriptTypeNodeIndexedReceivers(node.type, context, seen);
  }
  if (ts.isUnionTypeNode(node)) {
    const receivers = node.types.flatMap(
      (type): IrIndexedReceiver[] => getTypeScriptTypeNodeIndexedReceivers(type, context, seen) ?? ['unknown'],
    );
    return [...new Set(receivers)].sort();
  }
  if (ts.isArrayTypeNode(node)) return ['array'];
  if (ts.isTupleTypeNode(node)) return ['tuple'];
  if (node.kind === ts.SyntaxKind.StringKeyword) return ['string'];
  if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.UnknownKeyword) return ['unknown'];
  if (ts.isTypeLiteralNode(node)) return ['object'];
  if (ts.isTypeReferenceNode(node)) {
    const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text;
    const receiver = typeScriptIndexedReceiverNames[name];
    if (receiver) return [receiver];
    const unresolved = context.checker.getSymbolAtLocation(node.typeName);
    const symbol =
      unresolved?.flags && unresolved.flags & ts.SymbolFlags.Alias
        ? context.checker.getAliasedSymbol(unresolved)
        : unresolved;
    if (!symbol || seen.has(symbol)) return undefined;
    const declaration = symbol.declarations?.find(ts.isTypeAliasDeclaration);
    if (!declaration) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(symbol);
    return getTypeScriptTypeNodeIndexedReceivers(declaration.type, context, nextSeen);
  }
  return undefined;
}

function lowerCallSemantics(node: ts.CallExpression, context: LoweringContext): IrCallSemantics {
  const access = node.expression;
  const receiver = ts.isPropertyAccessExpression(access)
    ? access.name.text === 'set'
      ? access.expression
      : undefined
    : ts.isElementAccessExpression(access) &&
        access.argumentExpression &&
        (ts.isStringLiteral(access.argumentExpression) ||
          ts.isNoSubstitutionTemplateLiteral(access.argumentExpression)) &&
        access.argumentExpression.text === 'set'
      ? access.expression
      : undefined;
  if (!receiver) return {};
  const receivers = getTypeScriptExpressionIndexedReceiverSet(receiver, context);
  if (!receivers.every(isIrTypedArrayReceiver)) return {};
  return { typedArraySet: { receivers: receivers as [IrTypedArrayReceiver, ...IrTypedArrayReceiver[]] } };
}

function isIrTypedArrayReceiver(value: IrIndexedReceiver): value is IrTypedArrayReceiver {
  return value !== 'array' && value !== 'object' && value !== 'string' && value !== 'tuple' && value !== 'unknown';
}

function lowerExpressionTypeNameReference(expression: ts.Expression, context: LoweringContext): IrTypeNameReference {
  return lowerTypeNameNodeReference(expression, context);
}

function lowerFunction(
  node: ts.FunctionDeclaration,
  overloads: readonly IrFunctionSignature[],
  context: LoweringContext,
): IrFunctionDeclaration {
  if (!node.body) unsupported(node, 'function declaration requires a body');
  return {
    async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
    binding: lowerBindingIdentity(node.name!, context),
    body: lowerStatementList(node.body.statements, context),
    exported: isExported(node),
    kind: 'function',
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

function lowerFunctionType(
  node: ts.SignatureDeclaration,
  context: LoweringContext,
): Extract<IrType, { kind: 'function' }> {
  return {
    kind: 'function',
    parameters: node.parameters
      .filter((parameter) => !isThisParameter(parameter))
      .map((parameter) => lowerFunctionTypeParameter(parameter, context)),
    returns: node.type ? lowerType(node.type, context) : { kind: 'unknown', source: 'any' },
    typeParameters: lowerTypeParameters(node.typeParameters, context),
  };
}

function lowerImports(sourceFile: ts.SourceFile, context: LoweringContext): IrImport[] {
  return sourceFile.statements.flatMap((statement): IrImport[] => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const bindings: IrImportBinding[] = [];
    const clause = statement.importClause;
    if (clause?.name) {
      bindings.push(lowerImportBindingIdentity(clause.name, 'default', clause.isTypeOnly, context));
    }
    const namedBindings = clause?.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      bindings.push(lowerImportBindingIdentity(namedBindings.name, '*', clause.isTypeOnly, context));
    } else if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const binding of namedBindings.elements) {
        const typeOnly = clause.isTypeOnly || binding.isTypeOnly;
        bindings.push(
          lowerImportBindingIdentity(binding.name, binding.propertyName?.text ?? binding.name.text, typeOnly, context),
        );
      }
    }
    return [{ bindings, specifier: statement.moduleSpecifier.text }];
  });
}

function lowerImportBindingIdentity(
  name: ts.Identifier,
  imported: string,
  typeOnly: boolean,
  context: LoweringContext,
): IrImportBinding {
  return typeOnly
    ? { binding: lowerTypeBindingIdentity(name, context), imported, typeOnly: true }
    : { binding: lowerBindingIdentity(name, context), imported, typeOnly: false };
}

function lowerInterface(node: ts.InterfaceDeclaration, context: LoweringContext): IrInterfaceDeclaration {
  return {
    binding: lowerTypeBindingIdentity(node.name, context),
    exported: isExported(node),
    extends:
      node.heritageClauses?.flatMap((clause) =>
        clause.types.map((type) => lowerExpressionWithTypeArguments(type, context)),
      ) ?? [],
    kind: 'interface',
    origin: origin(node, context),
    properties: lowerTypeProperties(node.members, context),
    typeParameters: lowerTypeParameters(node.typeParameters, context),
  };
}

function lowerObjectMember(node: ts.ObjectLiteralElementLike, context: LoweringContext): IrObjectMember {
  if (ts.isSpreadAssignment(node)) return { expression: lowerExpression(node.expression, context), kind: 'spread' };
  if (ts.isShorthandPropertyAssignment(node)) {
    return {
      kind: 'property',
      name: node.name.text,
      value: { kind: 'identifier', reference: lowerIdentifierReference(node.name, context) },
    };
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
  const typeParameter = lowerFunctionTypeParameter(node, context);
  const parameter = {
    binding: lowerBindingIdentity(node.name, context),
    type: typeParameter.type,
  };
  if (typeParameter.rest) return { ...parameter, optional: false, rest: true };
  if (!typeParameter.optional) return { ...parameter, optional: false, rest: false };
  return node.initializer
    ? {
        ...parameter,
        initializer: lowerExpression(node.initializer, context, typeParameter.type),
        optional: true,
        rest: false,
      }
    : { ...parameter, optional: true, rest: false };
}

function lowerFunctionTypeParameter(node: ts.ParameterDeclaration, context: LoweringContext): IrFunctionTypeParameter {
  if (!ts.isIdentifier(node.name)) unsupported(node.name, 'destructured parameters are not represented yet');
  const type: IrType = node.type
    ? lowerType(node.type, context)
    : node.initializer
      ? inferInitializerType(node.initializer, context)
      : { kind: 'unknown', source: 'any' };
  const value = { name: node.name.text, type };
  if (node.dotDotDotToken) {
    if (node.questionToken || node.initializer) unsupported(node, 'rest parameters cannot be optional or defaulted');
    return { ...value, optional: false, rest: true };
  }
  return node.questionToken || node.initializer
    ? { ...value, optional: true, rest: false }
    : { ...value, optional: false, rest: false };
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
    const variable = lowerVariables(
      node.initializer,
      context,
      ts.isForOfStatement(node) ? lowerTypeScriptForOfElementType(node.expression, context) : undefined,
    )[0]!;
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
            catchClause: {
              body: lowerStatement(node.catchClause.block, context),
              ...(catchName ? { binding: lowerBindingIdentity(catchName, context) } : {}),
            },
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
    const reference = lowerTypeNameReference(node.typeName, context);
    if (reference.kind === 'ambient' && (name === 'Array' || name === 'ReadonlyArray') && arguments_.length === 1) {
      return { element: arguments_[0]!, kind: 'array', readonly: name === 'ReadonlyArray' };
    }
    return { kind: 'named', reference, typeArguments: arguments_ };
  }
  if (ts.isArrayTypeNode(node))
    return { element: lowerType(node.elementType, context), kind: 'array', readonly: false };
  if (ts.isTupleTypeNode(node)) {
    return {
      elements: node.elements.map((element): IrTupleTypeElement => {
        if (ts.isOptionalTypeNode(element))
          return { optional: true, rest: false, type: lowerType(element.type, context) };
        if (ts.isRestTypeNode(element)) return { optional: false, rest: true, type: lowerType(element.type, context) };
        if (ts.isNamedTupleMember(element)) {
          const type = lowerType(element.type, context);
          if (element.dotDotDotToken) {
            if (element.questionToken) unsupported(element, 'rest tuple elements cannot be optional');
            return { optional: false, rest: true, type };
          }
          return element.questionToken ? { optional: true, rest: false, type } : { optional: false, rest: false, type };
        }
        return { optional: false, rest: false, type: lowerType(element, context) };
      }),
      kind: 'tuple',
      readonly: false,
    };
  }
  if (ts.isUnionTypeNode(node)) return { kind: 'union', types: lowerCompoundTypes(node.types, node, context) };
  if (ts.isIntersectionTypeNode(node)) {
    return { kind: 'intersection', types: lowerCompoundTypes(node.types, node, context) };
  }
  if (ts.isFunctionTypeNode(node)) return lowerFunctionType(node, context);
  if (ts.isTypeLiteralNode(node)) return { kind: 'object', properties: lowerTypeProperties(node.members, context) };
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
  if (ts.isTypeQueryNode(node)) return { kind: 'typeOf', reference: lowerValueNameReference(node.exprName, context) };
  unsupported(node, `unsupported type ${ts.SyntaxKind[node.kind]}`);
}

function lowerTypeAlias(node: ts.TypeAliasDeclaration, context: LoweringContext): IrTypeAliasDeclaration {
  return {
    binding: lowerTypeBindingIdentity(node.name, context),
    exported: isExported(node),
    kind: 'typeAlias',
    origin: origin(node, context),
    type: lowerType(node.type, context),
    typeParameters: lowerTypeParameters(node.typeParameters, context),
  };
}

function lowerTypeNameReference(node: ts.EntityName, context: LoweringContext): IrTypeNameReference {
  return lowerTypeNameNodeReference(node, context);
}

function lowerTypeNameNodeReference(
  node: ts.EntityName | ts.Expression,
  context: LoweringContext,
): IrTypeNameReference {
  const parts = getTypeNameNodeParts(node);
  if (!parts) return { kind: 'ambient', name: node.getText(context.sourceFile) };
  const symbol = context.checker.getSymbolAtLocation(parts.root);
  if (symbol?.declarations?.some(isValueBindingDeclaration)) {
    return { binding: lowerBindingSymbol(symbol, parts.root, context), kind: 'binding', path: parts.path };
  }
  if (symbol?.declarations?.some(isTypeBindingDeclaration)) {
    return { binding: lowerTypeBindingSymbol(symbol, parts.root, context), kind: 'binding', path: parts.path };
  }
  return { kind: 'ambient', name: node.getText(context.sourceFile) };
}

function lowerValueNameReference(node: ts.EntityName, context: LoweringContext): IrValueNameReference {
  const parts = getTypeNameNodeParts(node);
  if (!parts) return { kind: 'ambient', name: node.getText(context.sourceFile) };
  const symbol = context.checker.getSymbolAtLocation(parts.root);
  return symbol?.declarations?.some(isValueBindingDeclaration)
    ? { binding: lowerBindingSymbol(symbol, parts.root, context), kind: 'binding', path: parts.path }
    : { kind: 'ambient', name: node.getText(context.sourceFile) };
}

function getTypeNameNodeParts(
  node: ts.EntityName | ts.Expression,
): Readonly<{ path: readonly string[]; root: ts.Identifier }> | undefined {
  if (ts.isIdentifier(node)) return { path: [], root: node };
  if (ts.isQualifiedName(node)) {
    const left = getTypeNameNodeParts(node.left);
    return left ? { path: [...left.path, node.right.text], root: left.root } : undefined;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const left = getTypeNameNodeParts(node.expression);
    return left ? { path: [...left.path, node.name.text], root: left.root } : undefined;
  }
  return undefined;
}

function lowerTypeProperties(members: readonly ts.TypeElement[], context: LoweringContext): IrObjectTypeProperty[] {
  return members.map((member): IrObjectTypeProperty => {
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
        type: lowerFunctionType(member, context),
      };
    }
    unsupported(member, `unsupported type member ${ts.SyntaxKind[member.kind]}`);
  });
}

function lowerCompoundTypes(
  nodes: readonly ts.TypeNode[],
  owner: ts.Node,
  context: LoweringContext,
): readonly [IrType, IrType, ...IrType[]] {
  const [first, second, ...rest] = nodes.map((type) => lowerType(type, context));
  if (!first || !second) unsupported(owner, 'compound types require at least two constituent types');
  return [first, second, ...rest];
}

function lowerTypeParameters(
  nodes: readonly ts.TypeParameterDeclaration[] | undefined,
  context: LoweringContext,
): IrTypeParameter[] {
  return (
    nodes?.map((node) => ({
      binding: lowerTypeBindingIdentity(node.name, context),
      ...(node.constraint ? { constraint: lowerType(node.constraint, context) } : {}),
      ...(node.default ? { default: lowerType(node.default, context) } : {}),
    })) ?? []
  );
}

function lowerVariables(
  node: ts.VariableDeclarationList,
  context: LoweringContext,
  contextualType?: Readonly<IrType>,
): IrVariable[] {
  const mutable = !(node.flags & ts.NodeFlags.Const);
  return node.declarations.map((declaration) => lowerVariable(declaration, mutable, context, contextualType));
}

function lowerVariable(
  node: ts.VariableDeclaration,
  mutable: boolean,
  context: LoweringContext,
  contextualType?: Readonly<IrType>,
): IrVariable {
  const type = node.type
    ? lowerType(node.type, context)
    : contextualType
      ? contextualType
      : node.initializer
        ? inferInitializerType(node.initializer, context)
        : undefined;
  return {
    ...(ts.isIdentifier(node.name)
      ? { binding: lowerBindingIdentity(node.name, context) }
      : { pattern: lowerBindingPattern(node.name, context, type) }),
    ...(node.initializer ? { initializer: lowerExpression(node.initializer, context, type) } : {}),
    mutable,
    ...(type ? { type } : {}),
  };
}

function lowerTypeScriptForOfElementType(expression: ts.Expression, context: LoweringContext): IrType | undefined {
  const iterableType = getTypeScriptExpressionTypeNodeIterable(expression, context);
  if (!iterableType) return undefined;
  const elementType = getTypeScriptTypeNodeIterableElement(iterableType, context, new Set());
  return elementType ? lowerType(resolveTypeScriptTypeNodeAlias(elementType, context, new Set()), context) : undefined;
}

function getTypeScriptExpressionTypeNodeIterable(
  expression: ts.Expression,
  context: LoweringContext,
): ts.TypeNode | undefined {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return getTypeScriptExpressionTypeNodeIterable(expression.expression, context);
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return expression.type;
  if (ts.isCallExpression(expression)) {
    const type = context.checker.getResolvedSignature(expression)?.declaration?.type;
    return type && ts.isTypeNode(type) ? type : undefined;
  }
  const symbol = context.checker.getSymbolAtLocation(expression);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) return undefined;
  if (
    ts.isParameter(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertySignature(declaration) ||
    ts.isVariableDeclaration(declaration)
  ) {
    return declaration.type;
  }
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isMethodSignature(declaration)
  ) {
    return declaration.type;
  }
  return undefined;
}

function getTypeScriptTypeNodeIterableElement(
  type: ts.TypeNode,
  context: LoweringContext,
  seen: ReadonlySet<ts.Symbol>,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode> = new Map(),
): ts.TypeNode | undefined {
  const substituted = getTypeScriptTypeNodeSubstitution(type, context, substitutions);
  if (substituted !== type) {
    return getTypeScriptTypeNodeIterableElement(substituted, context, seen, substitutions);
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return getTypeScriptTypeNodeIterableElement(type.type, context, seen, substitutions);
  }
  if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return getTypeScriptTypeNodeIterableElement(type.type, context, seen, substitutions);
  }
  if (ts.isArrayTypeNode(type)) return getTypeScriptTypeNodeSubstitution(type.elementType, context, substitutions);
  if (ts.isTypeReferenceNode(type)) {
    const parts = getTypeNameNodeParts(type.typeName);
    const name = parts ? [parts.root.text, ...parts.path].join('.') : undefined;
    const element = type.typeArguments?.[0];
    if ((name === 'Array' || name === 'ReadonlyArray') && type.typeArguments?.length === 1 && element) {
      return getTypeScriptTypeNodeSubstitution(element, context, substitutions);
    }
    const symbol = context.checker.getSymbolAtLocation(type.typeName);
    if (!symbol || seen.has(symbol)) return undefined;
    const declaration = symbol.declarations?.find(ts.isTypeAliasDeclaration);
    if (!declaration) return undefined;
    const nextSubstitutions = createTypeScriptTypeNodeAliasSubstitutions(type, declaration, context, substitutions);
    if (!nextSubstitutions) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(symbol);
    return getTypeScriptTypeNodeIterableElement(declaration.type, context, nextSeen, nextSubstitutions);
  }
  return undefined;
}

function createTypeScriptTypeNodeAliasSubstitutions(
  reference: ts.TypeReferenceNode,
  declaration: ts.TypeAliasDeclaration,
  context: LoweringContext,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>,
): ReadonlyMap<ts.Symbol, ts.TypeNode> | undefined {
  const parameters = declaration.typeParameters ?? [];
  const arguments_ = reference.typeArguments ?? [];
  if (arguments_.length > parameters.length) return undefined;
  const next = new Map(substitutions);
  for (const [index, parameter] of parameters.entries()) {
    const argument = arguments_[index] ?? parameter.default;
    const symbol = context.checker.getSymbolAtLocation(parameter.name);
    if (!argument || !symbol) return undefined;
    next.set(symbol, getTypeScriptTypeNodeSubstitution(argument, context, next));
  }
  return next;
}

function getTypeScriptTypeNodeSubstitution(
  type: ts.TypeNode,
  context: LoweringContext,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>,
): ts.TypeNode {
  if (!ts.isTypeReferenceNode(type) || type.typeArguments?.length) return type;
  const symbol = context.checker.getSymbolAtLocation(type.typeName);
  return (symbol && substitutions.get(symbol)) ?? type;
}

function resolveTypeScriptTypeNodeAlias(
  type: ts.TypeNode,
  context: LoweringContext,
  seen: ReadonlySet<ts.Symbol>,
): ts.TypeNode {
  if (!ts.isTypeReferenceNode(type)) return type;
  const symbol = context.checker.getSymbolAtLocation(type.typeName);
  if (!symbol || seen.has(symbol)) return type;
  const declaration = symbol.declarations?.find(ts.isTypeAliasDeclaration);
  if (!declaration || declaration.typeParameters?.length) return type;
  const nextSeen = new Set(seen);
  nextSeen.add(symbol);
  return resolveTypeScriptTypeNodeAlias(declaration.type, context, nextSeen);
}

function lowerBindingPattern(
  node: ts.BindingName,
  context: LoweringContext,
  sourceType?: Readonly<IrType>,
): IrBindingPattern {
  if (ts.isIdentifier(node)) {
    return {
      binding: lowerBindingIdentity(node, context),
      kind: 'binding',
      ...(sourceType ? { type: sourceType } : {}),
    };
  }
  if (ts.isObjectBindingPattern(node)) {
    return unsupported(node, 'object binding patterns are not represented in the neutral IR yet');
  }
  const elements: Array<IrBindingPatternElement | undefined> = [];
  let rest: IrBindingPattern | undefined;
  node.elements.forEach((element, index) => {
    if (ts.isOmittedExpression(element)) {
      elements.push(undefined);
      return;
    }
    if (element.dotDotDotToken) {
      if (index !== node.elements.length - 1) unsupported(element, 'array binding rest must be the final element');
      if (element.initializer) unsupported(element, 'array binding rest cannot have a default initializer');
      const restType = sourceType?.kind === 'tuple' ? sourceType.elements[index]?.type : undefined;
      rest = lowerBindingPattern(element.name, context, restType);
      return;
    }
    const elementType = sourceType?.kind === 'tuple' ? sourceType.elements[index]?.type : undefined;
    const initializerType = element.initializer ? removeIrTypeBindingPatternUndefined(elementType) : elementType;
    elements.push({
      ...(element.initializer ? { initializer: lowerExpression(element.initializer, context, initializerType) } : {}),
      pattern: lowerBindingPattern(element.name, context, elementType),
    });
  });
  return {
    ...origin(node, context),
    elements,
    kind: 'array',
    ...(rest ? { rest } : {}),
    scope: bindingPatternScope(node),
  };
}

function removeIrTypeBindingPatternUndefined(type: Readonly<IrType> | undefined): IrType | undefined {
  if (type?.kind !== 'union') return type;
  const retained = type.types.filter((member) => member.kind !== 'undefined');
  if (retained.length === 1) return retained[0];
  return retained.length >= 2
    ? { kind: 'union', types: [retained[0]!, retained[1]!, ...retained.slice(2)] }
    : undefined;
}

function bindingPatternScope(node: ts.ArrayBindingPattern): IrBindingScope {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent)) return bindingDeclarationScope(parent);
  }
  return unsupported(node, 'array binding pattern has no variable declaration owner');
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
      element:
        elementTypes.length === 0
          ? { kind: 'unknown', source: 'any' }
          : commonType([elementTypes[0]!, ...elementTypes.slice(1)]),
      kind: 'array',
      readonly: false,
    };
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return lowerFunctionType(node, context);
  }
  return { kind: 'unknown', source: 'any' };
}

function commonType(types: readonly [IrType, ...IrType[]]): IrType {
  const serialized = new Map(types.map((type) => [JSON.stringify(type), type]));
  const values = [...serialized.values()];
  return values.length === 1 ? values[0]! : { kind: 'union', types: [values[0]!, values[1]!, ...values.slice(2)] };
}

function isAssignmentOperator(kind: ts.BinaryOperator): kind is ts.AssignmentOperator {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function lowerAssignmentOperator(kind: ts.AssignmentOperator): IrAssignmentOperator {
  return typeScriptAssignmentOperators[kind];
}

function lowerAssignmentOperatorSemantics(
  node: ts.BinaryExpression,
  context: LoweringContext,
): IrAssignmentOperatorSemantics {
  return {
    left: lowerOperatorOperandDomains(node.left, context),
    result: lowerOperatorValueDomain(node, context),
    right: lowerOperatorOperandDomains(node.right, context),
  };
}

function lowerBinaryOperator(kind: TypeScriptBinaryOperator): IrBinaryOperator {
  return typeScriptBinaryOperators[kind];
}

function lowerBinaryOperatorSemantics(node: ts.BinaryExpression, context: LoweringContext): IrBinaryOperatorSemantics {
  return {
    left: lowerOperatorOperandDomains(node.left, context),
    result: lowerOperatorValueDomain(node, context),
    right: lowerOperatorOperandDomains(node.right, context),
  };
}

function lowerOperatorOperandDomains(node: ts.Expression, context: LoweringContext): IrOperatorOperandDomains {
  const flowType = context.checker.getTypeAtLocation(node);
  const declaredType = getTypeScriptExpressionDeclaredType(node, context) ?? flowType;
  return {
    declared: lowerTypeScriptTypeOperatorValueDomain(declaredType, context.checker),
    flow: lowerTypeScriptTypeOperatorValueDomain(flowType, context.checker),
  };
}

function lowerOperatorValueDomain(node: ts.Node, context: LoweringContext): IrOperatorValueDomain {
  return lowerTypeScriptTypeOperatorValueDomain(context.checker.getTypeAtLocation(node), context.checker);
}

function lowerPostfixUnaryOperator(kind: ts.PostfixUnaryOperator): IrPostfixUnaryOperator {
  return typeScriptPostfixUnaryOperators[kind];
}

function lowerPrefixUnaryOperator(kind: ts.PrefixUnaryOperator): IrPrefixUnaryOperator {
  return typeScriptPrefixUnaryOperators[kind];
}

function lowerTypeScriptTypeOperatorValueDomain(type: ts.Type, checker: ts.TypeChecker): IrOperatorValueDomain {
  if (type.isUnion()) {
    const domains = new Set(type.types.map((member) => lowerTypeScriptTypeOperatorValueDomain(member, checker)));
    return domains.size === 1 ? domains.values().next().value! : 'unknown';
  }
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint ? lowerTypeScriptTypeOperatorValueDomain(constraint, checker) : 'unknown';
  }
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return 'unknown';
  if (type.flags & ts.TypeFlags.BigIntLike) return 'bigint';
  if (type.flags & ts.TypeFlags.BooleanLike) return 'boolean';
  if (type.flags & ts.TypeFlags.Null) return 'null';
  if (type.flags & ts.TypeFlags.NumberLike) return 'number';
  if (type.flags & ts.TypeFlags.StringLike) return 'string';
  if (type.flags & ts.TypeFlags.ESSymbolLike) return 'symbol';
  if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return 'undefined';
  if (type.flags & (ts.TypeFlags.NonPrimitive | ts.TypeFlags.Object)) return 'object';
  return 'unknown';
}

function getTypeScriptExpressionDeclaredType(expression: ts.Expression, context: LoweringContext): ts.Type | undefined {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return getTypeScriptExpressionDeclaredType(expression.expression, context);
  }
  const unresolved = context.checker.getSymbolAtLocation(expression);
  const symbol =
    unresolved?.flags && unresolved.flags & ts.SymbolFlags.Alias
      ? context.checker.getAliasedSymbol(unresolved)
      : unresolved;
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return symbol && declaration ? context.checker.getTypeOfSymbolAtLocation(symbol, declaration) : undefined;
}

function lowerTypeScriptIndexedReceivers(type: ts.Type, checker: ts.TypeChecker): IrIndexedReceiver[] {
  if (type.isUnion()) {
    return [...new Set(type.types.flatMap((member) => lowerTypeScriptIndexedReceivers(member, checker)))].sort();
  }
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint ? lowerTypeScriptIndexedReceivers(constraint, checker) : ['unknown'];
  }
  if (checker.isTupleType(type)) return ['tuple'];
  const display = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  const named = typeScriptIndexedReceiverNames[display] ?? getTypeScriptArrayReceiver(display);
  if (named) return [named];
  const symbolName = (type.aliasSymbol ?? type.getSymbol())?.getName();
  if (symbolName) {
    const symbolReceiver = typeScriptIndexedReceiverNames[symbolName];
    if (symbolReceiver) return [symbolReceiver];
  }
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return ['unknown'];
  if (type.flags & ts.TypeFlags.StringLike) return ['string'];
  if (checker.isArrayType(type)) return ['array'];
  if (type.flags & (ts.TypeFlags.NonPrimitive | ts.TypeFlags.Object)) return ['object'];
  return ['unknown'];
}

function getTypeScriptArrayReceiver(display: string): IrIndexedReceiver | undefined {
  return display.endsWith('[]') ||
    display.startsWith('Array<') ||
    display.startsWith('ReadonlyArray<') ||
    /^readonly \[|^\[/u.test(display)
    ? 'array'
    : undefined;
}

function lowerUnaryOperatorSemantics(
  node: ts.Node,
  operand: ts.Expression,
  context: LoweringContext,
): IrUnaryOperatorSemantics {
  return {
    operand: lowerOperatorOperandDomains(operand, context),
    result: lowerOperatorValueDomain(node, context),
  };
}

function isThisParameter(node: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(node.name) && node.name.text === 'this';
}

function createTypeScriptAnalysis(sourceFile: ts.SourceFile): TypeScriptAnalysis {
  const analysisSourceFile = ts.createSourceFile(
    sourceFile.fileName,
    sourceFile.text,
    sourceFile.languageVersion,
    true,
  );
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    strictNullChecks: true,
    target: analysisSourceFile.languageVersion,
  };
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (file) => file === analysisSourceFile.fileName;
  host.getSourceFile = (file) => (file === analysisSourceFile.fileName ? analysisSourceFile : undefined);
  host.readFile = (file) => (file === analysisSourceFile.fileName ? analysisSourceFile.text : undefined);
  host.writeFile = () => undefined;
  const program = ts.createProgram({ host, options, rootNames: [analysisSourceFile.fileName] });
  return { checker: program.getTypeChecker(), sourceFile: analysisSourceFile };
}

function lowerIdentifierReference(node: ts.Identifier, context: LoweringContext): IrIdentifierReference {
  const symbol =
    ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? context.checker.getShorthandAssignmentValueSymbol(node.parent)
      : context.checker.getSymbolAtLocation(node);
  return symbol?.declarations?.some(isValueBindingDeclaration)
    ? { binding: lowerBindingSymbol(symbol, node, context), kind: 'binding' }
    : { kind: 'ambient', name: node.text };
}

function lowerExportBindingIdentity(
  node: ts.ExportSpecifier,
  name: ts.Identifier,
  context: LoweringContext,
): IrBindingIdentity | IrTypeBindingIdentity {
  const symbol = context.checker.getExportSpecifierLocalTargetSymbol(node);
  if (!symbol) unsupported(name, `export binding ${name.text} cannot be resolved`);
  if (symbol.declarations?.some(isValueBindingDeclaration)) return lowerBindingSymbol(symbol, name, context);
  if (symbol.declarations?.some(isTypeBindingDeclaration)) return lowerTypeBindingSymbol(symbol, name, context);
  return unsupported(name, `export binding ${name.text} has no supported declaration`);
}

function lowerBindingIdentity(node: ts.Identifier, context: LoweringContext): IrBindingIdentity {
  const symbol = context.checker.getSymbolAtLocation(node);
  if (!symbol) unsupported(node, `binding ${node.text} cannot be resolved`);
  return lowerBindingSymbol(symbol, node, context);
}

function lowerBindingSymbol(symbol: ts.Symbol, node: ts.Identifier, context: LoweringContext): IrBindingIdentity {
  const cached = context.bindings.get(symbol);
  if (cached) return cached;
  const declaration = symbol.declarations?.find(isValueBindingDeclaration);
  if (!declaration) return unsupported(node, `binding ${node.text} has no supported declaration`);
  const name = bindingDeclarationName(declaration);
  const source = relativeSource(context.sourceFile.fileName, context.options.upstreamDirectory);
  const binding: IrBindingIdentity = {
    ...origin(name, context),
    id: `binding:${JSON.stringify([context.options.packageName, source, name.getStart(context.sourceFile)])}`,
    kind: bindingDeclarationKind(declaration),
    name: name.text,
    scope: bindingDeclarationScope(declaration),
    space: 'value',
  };
  context.bindings.set(symbol, binding);
  return binding;
}

type TypeScriptBindingDeclaration =
  | ts.BindingElement
  | ts.ClassDeclaration
  | ts.EnumDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ImportClause
  | ts.ImportSpecifier
  | ts.NamespaceImport
  | ts.ParameterDeclaration
  | ts.VariableDeclaration;

function isValueBindingDeclaration(node: ts.Declaration): node is TypeScriptBindingDeclaration {
  return (
    ts.isClassDeclaration(node) ||
    ts.isBindingElement(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    (ts.isImportClause(node) && !isTypeOnlyImportBindingDeclaration(node)) ||
    (ts.isImportSpecifier(node) && !isTypeOnlyImportBindingDeclaration(node)) ||
    (ts.isNamespaceImport(node) && !isTypeOnlyImportBindingDeclaration(node)) ||
    ts.isParameter(node) ||
    ts.isVariableDeclaration(node)
  );
}

function bindingDeclarationName(node: TypeScriptBindingDeclaration): ts.Identifier {
  const name = node.name;
  if (!name || !ts.isIdentifier(name)) unsupported(node, 'binding declarations require identifier names');
  return name;
}

function bindingDeclarationKind(node: TypeScriptBindingDeclaration): IrBindingKind {
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return 'function';
  if (ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) return 'import';
  if (ts.isParameter(node)) return 'parameter';
  return ts.isCatchClause(node.parent) ? 'catch' : 'variable';
}

type TypeScriptTypeBindingDeclaration =
  | ts.ImportClause
  | ts.ImportSpecifier
  | ts.InterfaceDeclaration
  | ts.NamespaceImport
  | ts.TypeAliasDeclaration
  | ts.TypeParameterDeclaration;

function isTypeBindingDeclaration(node: ts.Declaration): node is TypeScriptTypeBindingDeclaration {
  return (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isTypeParameterDeclaration(node) ||
    ((ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) &&
      isTypeOnlyImportBindingDeclaration(node))
  );
}

function isTypeOnlyImportBindingDeclaration(node: ts.ImportClause | ts.ImportSpecifier | ts.NamespaceImport): boolean {
  if (ts.isImportSpecifier(node) && node.isTypeOnly) return true;
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isImportClause(current)) return current.isTypeOnly;
    if (ts.isImportDeclaration(current)) return false;
  }
  return false;
}

function lowerTypeBindingIdentity(node: ts.Identifier, context: LoweringContext): IrTypeBindingIdentity {
  const symbol = context.checker.getSymbolAtLocation(node);
  if (!symbol) unsupported(node, `type binding ${node.text} cannot be resolved`);
  return lowerTypeBindingSymbol(symbol, node, context);
}

function lowerTypeBindingSymbol(
  symbol: ts.Symbol,
  node: ts.Identifier,
  context: LoweringContext,
): IrTypeBindingIdentity {
  const cached = context.typeBindings.get(symbol);
  if (cached) return cached;
  const declaration = symbol.declarations?.find(isTypeBindingDeclaration);
  if (!declaration) return unsupported(node, `type binding ${node.text} has no supported declaration`);
  const name = typeBindingDeclarationName(declaration);
  const source = relativeSource(context.sourceFile.fileName, context.options.upstreamDirectory);
  const binding: IrTypeBindingIdentity = {
    ...origin(name, context),
    id: `type-binding:${JSON.stringify([context.options.packageName, source, name.getStart(context.sourceFile)])}`,
    kind: typeBindingDeclarationKind(declaration),
    name: name.text,
    scope: typeBindingDeclarationScope(declaration),
    space: 'type',
  };
  context.typeBindings.set(symbol, binding);
  return binding;
}

function typeBindingDeclarationKind(declaration: TypeScriptTypeBindingDeclaration): IrTypeBindingIdentity['kind'] {
  if (ts.isInterfaceDeclaration(declaration)) return 'interface';
  if (ts.isTypeAliasDeclaration(declaration)) return 'typeAlias';
  if (ts.isTypeParameterDeclaration(declaration)) return 'typeParameter';
  return 'import';
}

function typeBindingDeclarationName(declaration: TypeScriptTypeBindingDeclaration): ts.Identifier {
  const name = declaration.name;
  if (!name || !ts.isIdentifier(name)) unsupported(declaration, 'type binding declarations require identifier names');
  return name;
}

function bindingDeclarationScope(node: TypeScriptBindingDeclaration): IrBindingScope {
  if (ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) return 'module';
  if (ts.isFunctionExpression(node) || ts.isParameter(node)) return 'function';
  if (ts.isCatchClause(node.parent)) return 'block';
  const variableDeclaration = ts.isBindingElement(node)
    ? findVariableDeclarationOwner(node)
    : ts.isVariableDeclaration(node)
      ? node
      : undefined;
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) {
      return variableDeclaration && !(variableDeclaration.parent.flags & ts.NodeFlags.BlockScoped)
        ? 'function'
        : 'block';
    }
    if (ts.isSourceFile(parent)) return 'module';
  }
  return 'block';
}

function findVariableDeclarationOwner(node: ts.BindingElement): ts.VariableDeclaration | undefined {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent)) return parent;
  }
  return undefined;
}

function typeBindingDeclarationScope(node: TypeScriptTypeBindingDeclaration): IrBindingScope {
  if (!ts.isTypeParameterDeclaration(node)) return 'module';
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return 'function';
    if (ts.isClassLike(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)) {
      return 'declaration';
    }
  }
  return 'declaration';
}

function moduleNameFromSource(file: string): string {
  const name = path.basename(file).replace(/\.tsx?$/u, '');
  return name === 'index' ? 'Index' : `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

function origin(node: ts.Node, context: LoweringContext): CompilerSourceOrigin {
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
  return normalizePathPortable(relative);
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

const typeScriptAssignmentOperators = {
  [ts.SyntaxKind.AmpersandAmpersandEqualsToken]: '&&=',
  [ts.SyntaxKind.AmpersandEqualsToken]: '&=',
  [ts.SyntaxKind.AsteriskAsteriskEqualsToken]: '**=',
  [ts.SyntaxKind.AsteriskEqualsToken]: '*=',
  [ts.SyntaxKind.BarBarEqualsToken]: '||=',
  [ts.SyntaxKind.BarEqualsToken]: '|=',
  [ts.SyntaxKind.CaretEqualsToken]: '^=',
  [ts.SyntaxKind.EqualsToken]: '=',
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: '>>=',
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: '>>>=',
  [ts.SyntaxKind.LessThanLessThanEqualsToken]: '<<=',
  [ts.SyntaxKind.MinusEqualsToken]: '-=',
  [ts.SyntaxKind.PercentEqualsToken]: '%=',
  [ts.SyntaxKind.PlusEqualsToken]: '+=',
  [ts.SyntaxKind.QuestionQuestionEqualsToken]: '??=',
  [ts.SyntaxKind.SlashEqualsToken]: '/=',
} as const satisfies Readonly<Record<ts.AssignmentOperator, IrAssignmentOperator>>;

const typeScriptBinaryOperators = {
  [ts.SyntaxKind.AmpersandAmpersandToken]: '&&',
  [ts.SyntaxKind.AmpersandToken]: '&',
  [ts.SyntaxKind.AsteriskAsteriskToken]: '**',
  [ts.SyntaxKind.AsteriskToken]: '*',
  [ts.SyntaxKind.BarBarToken]: '||',
  [ts.SyntaxKind.BarToken]: '|',
  [ts.SyntaxKind.CaretToken]: '^',
  [ts.SyntaxKind.CommaToken]: ',',
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: '===',
  [ts.SyntaxKind.EqualsEqualsToken]: '==',
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: '!==',
  [ts.SyntaxKind.ExclamationEqualsToken]: '!=',
  [ts.SyntaxKind.GreaterThanEqualsToken]: '>=',
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken]: '>>>',
  [ts.SyntaxKind.GreaterThanGreaterThanToken]: '>>',
  [ts.SyntaxKind.GreaterThanToken]: '>',
  [ts.SyntaxKind.InKeyword]: 'in',
  [ts.SyntaxKind.InstanceOfKeyword]: 'instanceof',
  [ts.SyntaxKind.LessThanEqualsToken]: '<=',
  [ts.SyntaxKind.LessThanLessThanToken]: '<<',
  [ts.SyntaxKind.LessThanToken]: '<',
  [ts.SyntaxKind.MinusToken]: '-',
  [ts.SyntaxKind.PercentToken]: '%',
  [ts.SyntaxKind.PlusToken]: '+',
  [ts.SyntaxKind.QuestionQuestionToken]: '??',
  [ts.SyntaxKind.SlashToken]: '/',
} as const satisfies Readonly<Record<TypeScriptBinaryOperator, IrBinaryOperator>>;

const typeScriptIndexedReceiverNames: Readonly<Partial<Record<string, IrIndexedReceiver>>> = {
  Array: 'array',
  BigInt64Array: 'bigInt64Array',
  BigUint64Array: 'bigUint64Array',
  Float32Array: 'float32Array',
  Float64Array: 'float64Array',
  Int16Array: 'int16Array',
  Int32Array: 'int32Array',
  Int8Array: 'int8Array',
  ReadonlyArray: 'array',
  Uint16Array: 'uint16Array',
  Uint32Array: 'uint32Array',
  Uint8Array: 'uint8Array',
  Uint8ClampedArray: 'uint8ClampedArray',
};

const typeScriptPostfixUnaryOperators = {
  [ts.SyntaxKind.MinusMinusToken]: '--',
  [ts.SyntaxKind.PlusPlusToken]: '++',
} as const satisfies Readonly<Record<ts.PostfixUnaryOperator, IrPostfixUnaryOperator>>;

const typeScriptPrefixUnaryOperators = {
  [ts.SyntaxKind.ExclamationToken]: '!',
  [ts.SyntaxKind.MinusMinusToken]: '--',
  [ts.SyntaxKind.MinusToken]: '-',
  [ts.SyntaxKind.PlusPlusToken]: '++',
  [ts.SyntaxKind.PlusToken]: '+',
  [ts.SyntaxKind.TildeToken]: '~',
} as const satisfies Readonly<Record<ts.PrefixUnaryOperator, IrPrefixUnaryOperator>>;

function isUnsupportedSyntaxFailure(value: unknown): value is UnsupportedSyntaxFailure {
  return value instanceof Error && 'kind' in value && value.kind === 'unsupported-syntax' && 'node' in value;
}

function visibility(node: ts.Node): 'private' | 'protected' | 'public' {
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return 'private';
  if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return 'protected';
  return 'public';
}
