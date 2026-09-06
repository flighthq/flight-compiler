import path from 'node:path';

import ts from 'typescript';

import {
  getCompilerAmbientSurfaceFileName,
  createCompilerAmbientSurfaceSource,
} from '../../compiler-ambient/src/index.js';
import { normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import {
  createIrAwaitSemantics,
  createIrCatchSemantics,
  createIrStatementValueCallSemantics,
} from '../../compiler-completion/src/index.js';
import { fingerprintTypeScriptNode } from '../../compiler-provenance/src/index.js';
import {
  createIrObjectCopySemantics,
  createIrTypeParameterSubstitutionPlan,
  resolveIrTypeStructuralSubstitution,
} from '../../compiler-structural/src/index.js';
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
  IrNullishComparisonEvidence,
  IrClassDeclaration,
  IrClassField,
  IrClassMethod,
  IrCallSemantics,
  IrControlFlowLabelIdentity,
  IrDeclaration,
  IrEnumDeclaration,
  IrExpression,
  IrExport,
  IrFunctionDeclaration,
  IrFunctionSignature,
  IrFunctionTypeParameter,
  IrForInKeyPlan,
  IrImport,
  IrImportBinding,
  IrIdentifierReference,
  IrInterfaceDeclaration,
  IrIndexedReceiver,
  IrInvocationSemantics,
  IrObjectMember,
  IrObjectBindingPatternProperty,
  IrObjectTypeProperty,
  IrOperatorOperandDomains,
  IrOperatorValueDomain,
  IrParameter,
  IrResolvedMemberReceiver,
  IrParameterProvidedArgumentInvocationSemantics,
  IrPostfixUnaryOperator,
  IrPrefixUnaryOperator,
  IrPropertyKeyCoercion,
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
  TypeScriptInvocationSignatureResolution,
  LowerTypeScriptSourceOptions,
} from '../../compiler-types/src/index.js';
import { getIrTypeIndexedElementEvidence, getIrTypeMemberEvidence } from './compilerIrTypeMemberEvidence.js';
import { getIrBinaryOperatorResultDomain, getIrTypeOperatorValueDomain } from './compilerOperatorDomainEvidence.js';
import { getTypeScriptForInKeyEvidence } from './compilerTypeScriptForInKeyEvidence.js';
import { getTypeScriptInvocationSignatureResolution } from './compilerTypeScriptInvocationSemantics.js';
import {
  createTypeScriptSyntacticAliasSubstitutions,
  createTypeScriptSyntacticDeclarationSubstitutions,
  getTypeScriptSyntacticExpressionTypeEvidence,
  getTypeScriptSyntacticTypeSubstitution,
} from './compilerTypeScriptSyntacticTypeEvidence.js';

interface LoweringContext {
  bindingTypes: Map<ts.Symbol, IrType>;
  bindings: Map<ts.Symbol, IrBindingIdentity>;
  checker: ts.TypeChecker;
  diagnostics: CompilerDiagnostic[];
  options: Readonly<LowerTypeScriptSourceOptions>;
  returnTargetTypes: IrType[];
  returnTypes: IrType[];
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
    bindingTypes: new Map(),
    bindings: new Map(),
    checker: analysis.checker,
    diagnostics: [],
    options,
    returnTargetTypes: [],
    returnTypes: [],
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
  const constructorImplementations = constructors.filter((constructor) => constructor.body !== undefined);
  if (constructors.length > 1 && constructorImplementations.length !== 1) {
    unsupported(node, `class ${requiredDeclarationName(node, context)} has constructor overloads`);
  }
  const constructor = constructorImplementations[0] ?? constructors[0];
  const constructorOverloads = constructors.filter((candidate) => candidate !== constructor);
  const fields: IrClassField[] = [];
  const methods: IrClassMethod[] = [];
  const methodGroups = new Map<string, ts.MethodDeclaration[]>();
  for (const method of node.members.filter(ts.isMethodDeclaration)) {
    if (ts.isPrivateIdentifier(method.name)) {
      unsupported(method.name, 'ECMAScript private methods require branded member identity');
    }
    const name = propertyName(method.name, context);
    const key = `${hasModifier(method, ts.SyntaxKind.StaticKeyword) ? 'static' : 'instance'}:${name}`;
    const group = methodGroups.get(key) ?? [];
    group.push(method);
    methodGroups.set(key, group);
  }
  for (const group of methodGroups.values()) {
    const implementations = group.filter((method) => method.body !== undefined);
    // An abstract method has no implementation by definition, so an overload group of exactly one
    // abstract declaration is complete rather than missing one.
    if (implementations.length === 0 && group.length === 1 && hasModifier(group[0]!, ts.SyntaxKind.AbstractKeyword)) {
      continue;
    }
    if (implementations.length !== 1) {
      unsupported(group[0]!, `class method ${propertyName(group[0]!.name, context)} requires one implementation`);
    }
  }
  const fieldSlots = new Set<string>();
  for (const member of node.members) {
    if (ts.isConstructorDeclaration(member)) continue;
    if (ts.isPropertyDeclaration(member)) {
      if (ts.isPrivateIdentifier(member.name)) {
        unsupported(member.name, 'ECMAScript private fields require branded member identity');
      }
      if (hasModifier(member, ts.SyntaxKind.DeclareKeyword) || hasModifier(member, ts.SyntaxKind.AbstractKeyword)) {
        unsupported(member, 'declare and abstract class fields require type-only layout representation');
      }
      if (!member.type && !member.initializer) unsupported(member, 'class fields require a type or initializer');
      const type = member.type ? lowerType(member.type, context) : inferInitializerType(member.initializer!, context);
      const name = propertyName(member.name, context);
      const key = `${hasModifier(member, ts.SyntaxKind.StaticKeyword) ? 'static' : 'instance'}:${name}`;
      if (fieldSlots.has(key) || methodGroups.has(key)) {
        unsupported(member, `class runtime member ${name} has conflicting field and method storage`);
      }
      fieldSlots.add(key);
      fields.push({
        ...(member.initializer ? { initializer: lowerExpression(member.initializer, context, type) } : {}),
        name,
        optional: member.questionToken !== undefined,
        readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
        static: hasModifier(member, ts.SyntaxKind.StaticKeyword),
        type,
        visibility: visibility(member),
      });
      continue;
    }
    if (ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
      if (!member.body && !hasModifier(member, ts.SyntaxKind.AbstractKeyword)) continue;
      const accessor = ts.isGetAccessor(member)
        ? ({ accessor: 'get' } as const)
        : ts.isSetAccessor(member)
          ? ({ accessor: 'set' } as const)
          : {};
      const signature = lowerFunctionSignature(member, context);
      const parameterEntries = lowerParameterBindingEntries(member.parameters, signature.parameters, context);
      const name = propertyName(member.name, context);
      const key = `${hasModifier(member, ts.SyntaxKind.StaticKeyword) ? 'static' : 'instance'}:${name}`;
      const overloads = (methodGroups.get(key) ?? [])
        .filter((candidate) => candidate !== member)
        .map((candidate) => lowerFunctionSignature(candidate, context));
      methods.push({
        ...signature,
        ...accessor,
        async: hasModifier(member, ts.SyntaxKind.AsyncKeyword),
        ...(member.body ? {} : { abstract: true }),
        body: member.body
          ? [
              ...parameterEntries,
              ...lowerStatementListWithTypeScriptReturnType(
                member.body.statements,
                getTypeScriptFunctionReturnValueType(member, signature.returns, context),
                signature.returns,
                context,
              ),
            ]
          : [],
        name,
        overloads,
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
  const constructorParameters = constructor?.parameters.map((parameter) => lowerParameter(parameter, context)) ?? [];
  constructor?.parameters.forEach((parameter, parameterIndex) => {
    if (!isTypeScriptParameterProperty(parameter)) return;
    if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) {
      unsupported(parameter, 'constructor parameter properties require a named non-rest parameter');
    }
    const key = `instance:${parameter.name.text}`;
    if (fieldSlots.has(key) || methodGroups.has(key)) {
      unsupported(parameter, `class runtime member ${parameter.name.text} has conflicting parameter-property storage`);
    }
    fieldSlots.add(key);
    fields.push({
      name: parameter.name.text,
      optional: parameter.questionToken !== undefined,
      parameterProperty: { parameterIndex },
      readonly: hasModifier(parameter, ts.SyntaxKind.ReadonlyKeyword),
      static: false,
      type: constructorParameters[parameterIndex]!.type,
      visibility: visibility(parameter),
    });
  });
  return {
    abstract: hasModifier(node, ts.SyntaxKind.AbstractKeyword),
    binding: lowerBindingIdentity(node.name!, context),
    ...(constructor
      ? {
          classConstructor: {
            body: [
              ...lowerParameterBindingEntries(constructor.parameters, constructorParameters, context),
              ...(constructor.body ? lowerStatementList(constructor.body.statements, context) : []),
            ],
            overloads: constructorOverloads.map((overload) => ({
              parameters: overload.parameters.map((parameter) => lowerParameter(parameter, context)),
            })),
            parameters: constructorParameters,
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
  contextualTargetType?: Readonly<IrType>,
): IrExpression {
  if (ts.isParenthesizedExpression(node))
    return lowerExpression(node.expression, context, contextualType, contextualTargetType);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
    const type = lowerType(node.type, context);
    return { expression: lowerExpression(node.expression, context, type), kind: 'cast', type };
  }
  if (ts.isNonNullExpression(node))
    return lowerExpression(node.expression, context, contextualType, contextualTargetType);
  if (ts.isIdentifier(node)) {
    const reference = lowerIdentifierReference(node, context);
    if (
      reference.kind === 'ambient' &&
      reference.name === 'undefined' &&
      contextualType &&
      hasIrTypeContextualUndefinedOption(contextualType)
    ) {
      return { kind: 'undefinedValue', type: contextualType };
    }
    return {
      kind: 'identifier',
      ...getTypeScriptReferencePresence(node, reference, context),
      ...getTypeScriptReferenceNarrowedMember(node, reference, context),
      reference,
    };
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword) return { kind: 'identifier', reference: { kind: 'this' } };
  if (node.kind === ts.SyntaxKind.SuperKeyword) return { kind: 'identifier', reference: { kind: 'super' } };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'literal', value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: 'literal', value: null };
  if (ts.isNumericLiteral(node)) return { kind: 'literal', value: Number(node.text.replaceAll('_', '')) };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { kind: 'literal', value: node.text };
  if (ts.isArrayLiteralExpression(node)) {
    const targetShape = getIrTypeConstructionTargetShape(contextualTargetType ?? contextualType, context);
    if (contextualType?.kind === 'tuple') {
      return lowerTupleExpression(
        node,
        contextualType,
        targetShape?.kind === 'tuple' ? targetShape : contextualType,
        context,
      );
    }
    return {
      elements: node.elements.map((element) =>
        ts.isOmittedExpression(element)
          ? undefined
          : lowerExpression(
              element,
              context,
              contextualType?.kind === 'array' ? contextualType.element : undefined,
              targetShape?.kind === 'array' ? targetShape.element : undefined,
            ),
      ),
      kind: 'array',
    };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const inferredType = inferInitializerType(node, context);
    const memberContext = contextualType?.kind === 'object' ? contextualType : inferredType;
    const memberTarget = getIrTypeConstructionTargetShape(contextualTargetType ?? contextualType, context);
    const members = node.properties.map((member) =>
      lowerObjectMember(member, context, memberContext, memberTarget ?? memberContext),
    );
    // An unknown contextual type is not evidence about what is being built, so it does not outrank
    // the shape the literal itself states. The position a literal is passed to often knows nothing —
    // an ambient signature's own type parameter means nothing here — and treating that as a target
    // leaves the construction with no shape at all.
    const contextualEvidence =
      [contextualTargetType, contextualType].find(
        (candidate) => candidate !== undefined && candidate.kind !== 'unknown',
      ) ??
      // The position may still know what is being built even where no written type says so: a
      // parameter declared in the ambient surface is written in the surface's own type parameters,
      // and only the checker's instantiation of them names the module's type.
      (() => {
        const contextual = context.checker.getContextualType(node);
        return contextual ? getTypeScriptCheckerTypeEvidence(contextual, context, 0) : undefined;
      })();
    const common = {
      kind: 'object',
      members,
      type: contextualEvidence ?? inferredType,
    } as const;
    if (members.some((member) => member.kind === 'spread')) {
      return { ...common, copySemantics: createIrObjectCopySemantics() };
    }
    return {
      ...common,
    };
  }
  if (ts.isPropertyAccessExpression(node)) {
    const optional = node.questionDotToken !== undefined;
    const receiver = getTypeScriptExpressionBindingTypeEvidence(node.expression, context);
    const resolved = getIrResolvedMemberReceiver(receiver);
    const member = resolved ? { member: { name: node.name.text, receiver: resolved } } : {};
    const absent = isTypeScriptOptionalMemberAccess(node, context) ? ({ absent: 'optionalMember' } as const) : {};
    return {
      kind: 'property',
      ...absent,
      ...member,
      name: node.name.text,
      object: lowerExpression(node.expression, context),
      optional,
      ...(optional ? { optionalChain: createTypeScriptOptionalChainSemantics(node.expression, node, context) } : {}),
    };
  }
  if (ts.isElementAccessExpression(node)) {
    if (!node.argumentExpression) unsupported(node, 'element access requires an index');
    const optional = node.questionDotToken !== undefined;
    return {
      index: lowerExpression(node.argumentExpression, context),
      kind: 'element',
      object: lowerExpression(node.expression, context),
      optional,
      semantics: {
        ...lowerElementAccessSemantics(node.expression, node.argumentExpression, context),
        ...(optional ? { optionalChain: createTypeScriptOptionalChainSemantics(node.expression, node, context) } : {}),
      },
    };
  }
  if (ts.isCallExpression(node)) {
    const optional = node.questionDotToken !== undefined;
    const signature = getTypeScriptInvocationSignatureResolution(node, context.checker);
    const expression = {
      arguments: lowerTypeScriptInvocationArguments(node, signature, context),
      callee: lowerExpression(node.expression, context),
      kind: 'call' as const,
      optional,
      semantics: {
        ...lowerCallSemantics(node, signature, context),
        ...(optional ? { optionalChain: createTypeScriptOptionalChainSemantics(node.expression, node, context) } : {}),
      },
      typeArguments: node.typeArguments?.map((type) => lowerType(type, context)) ?? [],
    };
    return addTypeScriptExtraArgumentErasureSemantics(node, expression, context);
  }
  if (ts.isNewExpression(node)) {
    const signature = getTypeScriptInvocationSignatureResolution(node, context.checker);
    return {
      arguments: lowerTypeScriptInvocationArguments(node, signature, context),
      callee: lowerExpression(node.expression, context),
      kind: 'new',
      semantics: lowerInvocationSemantics(node, signature, context),
      typeArguments: node.typeArguments?.map((type) => lowerType(type, context)) ?? [],
    };
  }
  if (ts.isBinaryExpression(node)) {
    if (isAssignmentOperator(node.operatorToken.kind)) {
      if (
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isArrayLiteralExpression(node.left) || ts.isObjectLiteralExpression(node.left))
      ) {
        return lowerTypeScriptDestructuringAssignmentExpression(node, context);
      }
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
      whenFalse: lowerExpression(node.whenFalse, context, contextualType, contextualTargetType),
      whenTrue: lowerExpression(node.whenTrue, context, contextualType, contextualTargetType),
    };
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const signature = lowerFunctionSignature(node, context);
    const returnType = getTypeScriptFunctionReturnValueType(node, signature.returns, context);
    const parameterEntries = lowerParameterBindingEntries(node.parameters, signature.parameters, context);
    return {
      async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
      ...(ts.isBlock(node.body)
        ? {
            body: [
              ...parameterEntries,
              ...lowerStatementListWithTypeScriptReturnType(
                node.body.statements,
                returnType,
                signature.returns,
                context,
              ),
            ],
          }
        : parameterEntries.length === 0
          ? { body: [], expression: lowerExpression(node.body, context, returnType, signature.returns) }
          : {
              body: [
                ...parameterEntries,
                {
                  expression: lowerExpression(node.body, context, returnType, signature.returns),
                  kind: 'return',
                },
              ],
            }),
      kind: 'function',
      ...(node.name ? { binding: lowerBindingIdentity(node.name, context) } : {}),
      thisMode: ts.isArrowFunction(node) ? 'lexical' : 'dynamic',
      ...signature,
    };
  }
  if (ts.isAwaitExpression(node)) {
    return {
      expression: lowerExpression(node.expression, context),
      kind: 'await',
      semantics: createIrAwaitSemantics(),
    };
  }
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

function lowerTypeScriptInvocationArguments(
  node: ts.CallExpression | ts.NewExpression,
  signature: Readonly<TypeScriptInvocationSignatureResolution> | undefined,
  context: LoweringContext,
): IrExpression[] {
  const parameters = signature?.resolved.parameters.filter(ts.isParameter) ?? [];
  return (node.arguments ?? []).map((argument, index) => {
    if (ts.isSpreadElement(argument)) return lowerExpression(argument, context);
    const parameter = parameters[index];
    if (!parameter) return lowerExpression(argument, context);
    const type = lowerFunctionTypeParameter(parameter, context).type;
    const contextualType =
      parameter.questionToken || parameter.initializer ? addIrTypeBindingPatternUndefined(type) : type;
    return lowerExpression(argument, context, contextualType);
  });
}

function addTypeScriptExtraArgumentErasureSemantics(
  node: ts.CallExpression,
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: LoweringContext,
): Extract<IrExpression, { kind: 'call' }> {
  const signature = expression.semantics.signature;
  if (
    !signature ||
    signature.providedArgumentCount === 'dynamic' ||
    signature.restParameter !== undefined ||
    expression.arguments.length <= signature.parameterCount
  ) {
    return expression;
  }
  if (
    expression.optional ||
    expression.callee.kind !== 'identifier' ||
    expression.callee.reference.kind === 'super' ||
    expression.callee.reference.kind === 'this'
  ) {
    return expression;
  }
  const defaulted = new Set(expression.semantics.defaultParameters?.defaulted ?? []);
  if (
    expression.arguments
      .slice(0, signature.parameterCount)
      .some((argument, index) => argument.kind === 'undefinedValue' && defaulted.has(index))
  ) {
    return expression;
  }
  return {
    ...expression,
    semantics: {
      ...expression.semantics,
      extraArguments: {
        argumentBindings: expression.arguments.map((_, index) =>
          createTypeScriptCallArgumentBinding(node, index, context),
        ),
        resultType: lowerTypeScriptExpressionTypeEvidence(node, context) ?? { kind: 'unknown', source: 'unknown' },
      },
    },
  };
}

function createTypeScriptCallArgumentBinding(
  node: ts.CallExpression,
  index: number,
  context: LoweringContext,
): IrBindingIdentity {
  const sourceOrigin = origin(node.arguments[index] ?? node, context);
  return {
    ...sourceOrigin,
    id: `binding:${JSON.stringify([
      sourceOrigin.packageName,
      sourceOrigin.source,
      'call-argument',
      node.getStart(context.sourceFile),
      index,
    ])}`,
    kind: 'variable',
    name: `callArgument${String(index)}`,
    scope: 'block',
    space: 'value',
  };
}

function hasIrTypeContextualUndefinedOption(type: Readonly<IrType>): boolean {
  if (type.kind !== 'union' || !type.types.some((member) => member.kind === 'undefined')) return false;
  return type.types.some((member) => member.kind !== 'null' && member.kind !== 'undefined');
}

function createTypeScriptOptionalChainSemantics(
  receiver: ts.Expression,
  value: ts.Expression,
  context: LoweringContext,
) {
  const receiverType = getTypeScriptOptionalChainTypeEvidence(receiver, context);
  return {
    receiverEvaluation: 'once',
    receiverNullish: getTypeScriptOptionalChainReceiverNullish(receiver, context),
    receiverType,
    result: 'undefined',
    shortCircuit: 'nullish',
    valueType: getTypeScriptOptionalChainValueTypeEvidence(value, receiverType, context),
  } as const;
}

function getTypeScriptOptionalChainReceiverNullish(
  expression: ts.Expression,
  context: LoweringContext,
): 'excluded' | 'possible' {
  const type = context.checker.getTypeAtLocation(expression);
  const members = type.isUnion() ? type.types : [type];
  return members.some(
    (member) =>
      (member.flags &
        (ts.TypeFlags.Any |
          ts.TypeFlags.Null |
          ts.TypeFlags.TypeParameter |
          ts.TypeFlags.Undefined |
          ts.TypeFlags.Unknown)) !==
      0,
  )
    ? 'possible'
    : 'excluded';
}

function getTypeScriptOptionalChainTypeEvidence(expression: ts.Expression, context: LoweringContext): IrType {
  const binding = getTypeScriptExpressionBindingTypeEvidence(expression, context);
  if (binding) return binding;
  const evidence = getTypeScriptSyntacticExpressionTypeEvidence(expression, context.checker);
  return evidence ? lowerType(evidence, context) : { kind: 'unknown', source: 'unknown' };
}

function getTypeScriptOptionalChainValueTypeEvidence(
  expression: ts.Expression,
  receiverType: Readonly<IrType>,
  context: LoweringContext,
): IrType {
  const evidence = getTypeScriptSyntacticExpressionTypeEvidence(expression, context.checker);
  if (evidence) return lowerType(evidence, context);
  if (!ts.isElementAccessExpression(expression)) return { kind: 'unknown', source: 'unknown' };
  const concrete =
    receiverType.kind === 'union'
      ? receiverType.types.filter((type) => type.kind !== 'null' && type.kind !== 'undefined')
      : [receiverType];
  if (concrete.length !== 1) return { kind: 'unknown', source: 'unknown' };
  const indexed = concrete[0]!;
  if (indexed.kind === 'array') return indexed.element;
  if (indexed.kind === 'tuple' && expression.argumentExpression && ts.isNumericLiteral(expression.argumentExpression)) {
    return (
      indexed.elements[Number(expression.argumentExpression.text)]?.type ?? {
        kind: 'undefined',
      }
    );
  }
  return { kind: 'unknown', source: 'unknown' };
}

function lowerTupleExpression(
  node: ts.ArrayLiteralExpression,
  type: Readonly<Extract<IrType, { kind: 'tuple' }>>,
  targetType: Readonly<Extract<IrType, { kind: 'tuple' }>>,
  context: LoweringContext,
): IrExpression {
  const restIndex = type.elements.findIndex((element) => element.rest);
  if (restIndex >= 0) {
    return unsupported(node, `contextual tuple expression rest at index ${String(restIndex)} is not represented yet`);
  }
  if (!node.elements.some(ts.isSpreadElement)) {
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
        const expression = lowerExpression(value, context, element.type, targetType.elements[index]?.type);
        return element.optional ? { expression, optional: true } : { expression, optional: false };
      }),
      kind: 'tuple',
    };
  }
  const segments: Array<Extract<IrExpression, { kind: 'tupleSpread' }>['segments'][number]> = [];
  let targetIndex = 0;
  for (const value of node.elements) {
    if (ts.isSpreadElement(value)) {
      const spreadType = lowerTypeScriptExpressionTypeEvidence(value.expression, context);
      if (spreadType?.kind !== 'tuple' || spreadType.elements.some((element) => element.rest)) {
        return unsupported(value, 'contextual tuple expression spread requires a statically known fixed tuple');
      }
      if (targetIndex + spreadType.elements.length > type.elements.length) {
        return unsupported(value, 'contextual tuple expression spread exceeds its fixed tuple type');
      }
      spreadType.elements.forEach((element, index) => {
        const target = type.elements[targetIndex + index]!;
        if (element.optional && !target.optional) {
          unsupported(
            value,
            `optional tuple spread value cannot initialize required index ${String(targetIndex + index)}`,
          );
        }
      });
      segments.push({
        expression: lowerExpression(value.expression, context, spreadType),
        kind: 'spread',
        type: spreadType,
      });
      targetIndex += spreadType.elements.length;
      continue;
    }
    const target = type.elements[targetIndex];
    if (!target) return unsupported(value, 'contextual tuple expression has more values than its fixed tuple type');
    if (ts.isOmittedExpression(value)) {
      if (!target.optional) {
        return unsupported(value, `contextual tuple expression requires a value at index ${String(targetIndex)}`);
      }
      segments.push({ element: { optional: true }, kind: 'element' });
    } else {
      const expression = lowerExpression(value, context, target.type, targetType.elements[targetIndex]?.type);
      segments.push({
        element: target.optional ? { expression, optional: true } : { expression, optional: false },
        kind: 'element',
      });
    }
    targetIndex += 1;
  }
  for (; targetIndex < type.elements.length; targetIndex += 1) {
    const target = type.elements[targetIndex]!;
    if (!target.optional) {
      return unsupported(node, `contextual tuple expression requires a value at index ${String(targetIndex)}`);
    }
    segments.push({ element: { optional: true }, kind: 'element' });
  }
  return { kind: 'tupleSpread', segments, type };
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
  key: ts.Expression,
  context: LoweringContext,
): { key: IrPropertyKeyCoercion; receivers: [IrIndexedReceiver, ...IrIndexedReceiver[]] } {
  return {
    key: getTypeScriptPropertyKeyCoercion(key, context),
    receivers: getTypeScriptExpressionIndexedReceiverSet(receiver, context),
  };
}

function getTypeScriptPropertyKeyCoercion(expression: ts.Expression, context: LoweringContext): IrPropertyKeyCoercion {
  const flags = context.checker.getTypeAtLocation(expression).flags;
  if ((flags & ts.TypeFlags.StringLike) !== 0) return 'string';
  if ((flags & ts.TypeFlags.NumberLike) !== 0) return 'number';
  if ((flags & ts.TypeFlags.ESSymbolLike) !== 0) return 'symbol';
  return 'toPropertyKey';
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

function lowerCallSemantics(
  node: ts.CallExpression,
  signature: Readonly<TypeScriptInvocationSignatureResolution> | undefined,
  context: LoweringContext,
): IrCallSemantics {
  const semantics: IrCallSemantics = {
    ...lowerInvocationSemantics(node, signature, context),
  };
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
  if (!receiver) return semantics;
  const receivers = getTypeScriptExpressionIndexedReceiverSet(receiver, context);
  if (!receivers.every(isIrTypedArrayReceiver)) return semantics;
  return {
    ...semantics,
    typedArraySet: { receivers: receivers as [IrTypedArrayReceiver, ...IrTypedArrayReceiver[]] },
  };
}

function lowerInvocationSemantics(
  node: ts.CallExpression | ts.NewExpression,
  signature: Readonly<TypeScriptInvocationSignatureResolution> | undefined,
  context: LoweringContext,
): IrInvocationSemantics {
  return {
    ...getTypeScriptDefaultParameterInvocationSemantics(node, signature, context),
    ...getTypeScriptInvocationSignatureSemantics(node, signature),
    ...getTypeScriptOptionalParameterInvocationSemantics(node, signature, context),
    ...getTypeScriptOverloadImplementationInvocationSemantics(signature),
  };
}

function getTypeScriptOptionalParameterInvocationSemantics(
  node: ts.CallExpression | ts.NewExpression,
  signature: Readonly<TypeScriptInvocationSignatureResolution> | undefined,
  context: LoweringContext,
): Pick<IrInvocationSemantics, 'optionalParameters'> {
  const parameters = signature?.implementation.parameters.filter(ts.isParameter) ?? [];
  const optional = parameters.flatMap((parameter, index) =>
    parameter.questionToken && !parameter.initializer ? [index] : [],
  );
  if (optional.length === 0) return {};
  const arguments_ = node.arguments ?? [];
  const dynamic = arguments_.some(ts.isSpreadElement);
  const provided = dynamic
    ? []
    : optional.flatMap((position) => {
        const argument = arguments_[position];
        const parameter = parameters[position];
        return argument && parameter
          ? [getTypeScriptParameterProvidedArgumentInvocationSemantics(argument, parameter, position, context)]
          : [];
      });
  return {
    optionalParameters: {
      omitted: dynamic ? [] : optional.filter((index) => index >= arguments_.length),
      optional,
      parameterCount: parameters.length,
      provided,
      providedArgumentCount: dynamic ? 'dynamic' : arguments_.length,
    },
  };
}

function getTypeScriptDefaultParameterInvocationSemantics(
  node: ts.CallExpression | ts.NewExpression,
  signature: Readonly<TypeScriptInvocationSignatureResolution> | undefined,
  context: LoweringContext,
): Pick<IrInvocationSemantics, 'defaultParameters'> {
  const parameters = signature?.implementation.parameters.filter(ts.isParameter) ?? [];
  const defaulted = parameters.flatMap((parameter, index) => (parameter.initializer ? [index] : []));
  if (defaulted.length === 0) return {};
  const arguments_ = node.arguments ?? [];
  const dynamic = arguments_.some(ts.isSpreadElement);
  return {
    defaultParameters: {
      defaulted,
      omitted: dynamic ? [] : defaulted.filter((index) => index >= arguments_.length),
      parameterCount: parameters.length,
      provided: dynamic
        ? []
        : defaulted.flatMap((position) => {
            const argument = arguments_[position];
            const parameter = parameters[position];
            return argument && parameter
              ? [getTypeScriptParameterProvidedArgumentInvocationSemantics(argument, parameter, position, context)]
              : [];
          }),
      providedArgumentCount: dynamic ? 'dynamic' : arguments_.length,
    },
  };
}

function getTypeScriptParameterProvidedArgumentInvocationSemantics(
  argument: ts.Expression,
  parameter: ts.ParameterDeclaration,
  position: number,
  context: LoweringContext,
): IrParameterProvidedArgumentInvocationSemantics {
  return {
    argumentType: lowerTypeScriptExpressionTypeEvidence(argument, context) ?? inferInitializerType(argument, context),
    parameterType: lowerFunctionTypeParameter(parameter, context).type,
    position,
    value: getTypeScriptInvocationArgumentValue(argument, context),
  };
}

function getTypeScriptInvocationArgumentValue(
  argument: ts.Expression,
  context: LoweringContext,
): 'null' | 'undefined' | 'value' {
  let value = argument;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isNonNullExpression(value)
  ) {
    value = value.expression;
  }
  if (value.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (!ts.isIdentifier(value) || value.text !== 'undefined') return 'value';
  const reference = lowerIdentifierReference(value, context);
  return reference.kind === 'ambient' && reference.name === 'undefined' ? 'undefined' : 'value';
}

function getTypeScriptOverloadImplementationInvocationSemantics(
  signature: Readonly<TypeScriptInvocationSignatureResolution> | undefined,
): Pick<IrInvocationSemantics, 'overloadImplementation'> {
  if (!signature || signature.overloadIndex === undefined) return {};
  return {
    overloadImplementation: {
      implementationParameterCount: signature.implementation.parameters.filter(ts.isParameter).length,
      overloadIndex: signature.overloadIndex,
      resolvedParameterCount: signature.resolved.parameters.filter(ts.isParameter).length,
    },
  };
}

function getTypeScriptInvocationSignatureSemantics(
  node: ts.CallExpression | ts.NewExpression,
  signature: Readonly<TypeScriptInvocationSignatureResolution> | undefined,
): Pick<IrInvocationSemantics, 'signature'> {
  if (!signature) return {};
  const parameters = signature.implementation.parameters.filter(ts.isParameter);
  const arguments_ = node.arguments ?? [];
  const restParameter = parameters.findIndex((parameter) => parameter.dotDotDotToken !== undefined);
  return {
    signature: {
      parameterCount: parameters.length,
      providedArgumentCount: arguments_.some(ts.isSpreadElement) ? 'dynamic' : arguments_.length,
      ...(restParameter < 0 ? {} : { restParameter }),
    },
  };
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
  const signature = lowerFunctionSignature(node, context);
  const parameterEntries = lowerParameterBindingEntries(node.parameters, signature.parameters, context);
  return {
    async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
    binding: lowerBindingIdentity(node.name!, context),
    body: [
      ...parameterEntries,
      ...lowerStatementListWithTypeScriptReturnType(
        node.body.statements,
        getTypeScriptFunctionReturnValueType(node, signature.returns, context),
        signature.returns,
        context,
      ),
    ],
    exported: isExported(node),
    kind: 'function',
    origin: origin(node, context),
    overloads: [...overloads],
    ...signature,
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

function getTypeScriptFunctionReturnValueType(
  node: ts.SignatureDeclaration,
  fallback: Readonly<IrType>,
  context: LoweringContext,
): IrType {
  let type = node.type;
  if (type && hasModifier(node, ts.SyntaxKind.AsyncKeyword) && ts.isTypeReferenceNode(type)) {
    const parts = getTypeNameNodeParts(type.typeName);
    if (parts?.root.text === 'Promise' && parts.path.length === 0 && type.typeArguments?.length === 1) {
      type = type.typeArguments[0];
    }
  }
  return type ? lowerTypeScriptTypeNodeEvidence(type, context) : fallback;
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
    return [{ bindings, specifier: statement.moduleSpecifier.text, typeOnly: clause?.isTypeOnly ?? false }];
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

function getIrTypeConstructionTargetShape(
  type: Readonly<IrType> | undefined,
  context: LoweringContext,
  seen: ReadonlySet<string> = new Set(),
): IrType | undefined {
  if (
    !type ||
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.path.length > 0 ||
    seen.has(type.reference.binding.id)
  ) {
    return type;
  }
  const bindingId = type.reference.binding.id;
  const symbol = [...context.typeBindings].find(([, binding]) => binding.id === bindingId)?.[0];
  const declaration = symbol?.declarations?.find(
    (candidate): candidate is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      ts.isInterfaceDeclaration(candidate) || ts.isTypeAliasDeclaration(candidate),
  );
  if (!declaration) return type;
  const unresolved = ts.isInterfaceDeclaration(declaration)
    ? ({ kind: 'object', properties: lowerTypeProperties(declaration.members, context) } as const)
    : lowerType(declaration.type, context);
  const resolved = resolveIrTypeStructuralSubstitution(
    unresolved,
    createIrTypeParameterSubstitutionPlan(lowerTypeParameters(declaration.typeParameters, context), type.typeArguments),
  );
  const nextSeen = new Set(seen);
  nextSeen.add(bindingId);
  return getIrTypeConstructionTargetShape(resolved, context, nextSeen);
}

function lowerObjectMember(
  node: ts.ObjectLiteralElementLike,
  context: LoweringContext,
  contextualType: Readonly<IrType>,
  contextualTargetType: Readonly<IrType>,
): IrObjectMember {
  const memberType =
    contextualType.kind === 'object' && !ts.isSpreadAssignment(node) && !ts.isComputedPropertyName(node.name)
      ? contextualType.properties.find((property) => property.name === propertyName(node.name, context))?.type
      : undefined;
  const memberTargetType =
    contextualTargetType.kind === 'object' && !ts.isSpreadAssignment(node) && !ts.isComputedPropertyName(node.name)
      ? contextualTargetType.properties.find((property) => property.name === propertyName(node.name, context))?.type
      : undefined;
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
      value: lowerExpression(node.initializer, context, memberType, memberTargetType),
    };
  }
  if (ts.isMethodDeclaration(node)) {
    if (!node.body) unsupported(node, 'object methods require a body');
    const signature = lowerFunctionSignature(node, context);
    const parameterEntries = lowerParameterBindingEntries(node.parameters, signature.parameters, context);
    return {
      kind: 'property',
      name: propertyName(node.name, context),
      value: {
        async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
        body: [
          ...parameterEntries,
          ...lowerStatementListWithTypeScriptReturnType(
            node.body.statements,
            getTypeScriptFunctionReturnValueType(node, signature.returns, context),
            signature.returns,
            context,
          ),
        ],
        kind: 'function',
        thisMode: 'dynamic',
        ...signature,
      },
    };
  }
  unsupported(node, `unsupported object member ${ts.SyntaxKind[node.kind]}`);
}

function createTypeScriptParameterPatternBinding(
  node: ts.ParameterDeclaration,
  context: LoweringContext,
): IrBindingIdentity {
  const source = relativeSource(context.sourceFile.fileName, context.options.upstreamDirectory);
  return {
    ...origin(node.name, context),
    id: `binding:${JSON.stringify([context.options.packageName, source, `parameter-pattern:${String(node.name.getStart(context.sourceFile))}`])}`,
    kind: 'parameter',
    name: 'parameterPatternValue',
    scope: 'function',
    space: 'value',
  };
}

function lowerParameterBindingEntries(
  nodes: readonly ts.ParameterDeclaration[],
  parameters: readonly IrParameter[],
  context: LoweringContext,
): IrStatement[] {
  const sourceNodes = nodes.filter((parameter) => !isThisParameter(parameter));
  return sourceNodes.flatMap((node, index): IrStatement[] => {
    if (ts.isIdentifier(node.name)) return [];
    const parameter = parameters[index]!;
    const bindingType = node.type ? lowerTypeScriptTypeNodeEvidence(node.type, context) : parameter.type;
    return [
      {
        declarations: [
          {
            initializer: {
              kind: 'identifier',
              reference: { binding: parameter.binding, kind: 'binding' },
            },
            mutable: true,
            pattern: lowerBindingPattern(node.name, context, bindingType),
            type: parameter.type,
          },
        ],
        kind: 'variable',
      },
    ];
  });
}

function lowerParameter(node: ts.ParameterDeclaration, context: LoweringContext): IrParameter {
  const typeParameter = lowerFunctionTypeParameter(node, context);
  if (ts.isIdentifier(node.name)) {
    addTypeScriptBindingTypeEvidence(
      node.name,
      typeParameter.optional && !node.initializer
        ? addIrTypeBindingPatternUndefined(typeParameter.type)
        : typeParameter.type,
      context,
    );
  }
  const parameter = {
    binding: ts.isIdentifier(node.name)
      ? lowerBindingIdentity(node.name, context)
      : createTypeScriptParameterPatternBinding(node, context),
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
  const type: IrType = node.type
    ? lowerType(node.type, context)
    : node.initializer
      ? inferInitializerType(node.initializer, context)
      : (getTypeScriptContextualParameterType(node, context) ?? { kind: 'unknown', source: 'any' });
  const value = { name: ts.isIdentifier(node.name) ? node.name.text : 'parameterPatternValue', type };
  if (node.dotDotDotToken) {
    if (node.questionToken || node.initializer) unsupported(node, 'rest parameters cannot be optional or defaulted');
    return { ...value, optional: false, rest: true };
  }
  return node.questionToken || node.initializer
    ? { ...value, optional: true, rest: false }
    : { ...value, optional: false, rest: false };
}

function lowerStatement(node: ts.Statement, context: LoweringContext): IrStatement {
  if (ts.isLabeledStatement(node)) {
    const label = createTypeScriptControlFlowLabelIdentity(node.label, context);
    const statement = lowerStatement(node.statement, context);
    if (
      statement.kind === 'block' ||
      statement.kind === 'do' ||
      statement.kind === 'for' ||
      statement.kind === 'forIn' ||
      statement.kind === 'forOf' ||
      statement.kind === 'switch' ||
      statement.kind === 'while'
    ) {
      return { ...statement, label };
    }
    return { kind: 'block', label, statements: [statement] };
  }
  if (ts.isBlock(node)) return { kind: 'block', statements: lowerStatementList(node.statements, context) };
  if (ts.isExpressionStatement(node)) {
    const destructuring = lowerTypeScriptDestructuringAssignmentStatement(node.expression, context);
    if (destructuring) return destructuring;
    return { expression: lowerExpression(node.expression, context), kind: 'expression' };
  }
  if (ts.isReturnStatement(node)) {
    return {
      ...(node.expression
        ? {
            expression: lowerExpression(
              node.expression,
              context,
              context.returnTypes.at(-1),
              context.returnTargetTypes.at(-1),
            ),
          }
        : {}),
      kind: 'return',
    };
  }
  if (ts.isVariableStatement(node))
    return { declarations: lowerVariables(node.declarationList, context), kind: 'variable' };
  if (ts.isIfStatement(node)) {
    return {
      condition: lowerExpression(node.expression, context),
      consequent: lowerStatement(node.thenStatement, context),
      kind: 'if',
      origin: origin(node, context),
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
          ...getTypeScriptForInKeyPlan(node.expression, context),
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
      origin: origin(node, context),
      subjectDomain: lowerOperatorOperandDomains(node.expression, context).flow,
    };
  }
  if (ts.isBreakStatement(node)) {
    return {
      kind: 'break',
      ...(node.label ? { target: resolveTypeScriptControlFlowLabelIdentity(node.label, context) } : {}),
    };
  }
  if (ts.isContinueStatement(node)) {
    return {
      kind: 'continue',
      ...(node.label ? { target: resolveTypeScriptControlFlowLabelIdentity(node.label, context) } : {}),
    };
  }
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
              semantics: createIrCatchSemantics(catchName ? 'present' : 'absent'),
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

function resolveTypeScriptControlFlowLabelIdentity(
  reference: ts.Identifier,
  context: LoweringContext,
): IrControlFlowLabelIdentity {
  for (let current: ts.Node | undefined = reference.parent; current; current = current.parent) {
    if (ts.isLabeledStatement(current) && current.label.text === reference.text) {
      return createTypeScriptControlFlowLabelIdentity(current.label, context);
    }
  }
  return unsupported(reference, `control-flow label ${reference.text} cannot be resolved`);
}

function createTypeScriptControlFlowLabelIdentity(
  declaration: ts.Identifier,
  context: LoweringContext,
): IrControlFlowLabelIdentity {
  const source = relativeSource(context.sourceFile.fileName, context.options.upstreamDirectory);
  return {
    ...origin(declaration, context),
    id: `control-flow-label:${JSON.stringify([context.options.packageName, source, declaration.getStart(context.sourceFile)])}`,
    name: declaration.text,
  };
}

function lowerTypeScriptDestructuringAssignmentStatement(
  expression: ts.Expression,
  context: LoweringContext,
): IrStatement | undefined {
  const unwrapped = unwrapTypeScriptParenthesizedExpression(expression);
  if (
    !ts.isBinaryExpression(unwrapped) ||
    unwrapped.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    (!ts.isArrayLiteralExpression(unwrapped.left) && !ts.isObjectLiteralExpression(unwrapped.left))
  ) {
    return undefined;
  }
  const sourceType = lowerTypeScriptExpressionTypeEvidence(unwrapped.right, context);
  const sourceTypeNode = getTypeScriptSyntacticExpressionTypeEvidence(unwrapped.right, context.checker);
  const storageType = sourceTypeNode ? lowerType(sourceTypeNode, context) : sourceType;
  return {
    kind: 'block',
    statements: lowerTypeScriptDestructuringAssignmentTarget(
      unwrapped.left,
      lowerExpression(unwrapped.right, context, sourceType),
      sourceType,
      'root',
      context,
      storageType,
    ),
  };
}

function lowerTypeScriptDestructuringAssignmentExpression(
  expression: ts.BinaryExpression,
  context: LoweringContext,
): IrExpression {
  const sourceType = lowerTypeScriptExpressionTypeEvidence(expression.right, context);
  const sourceTypeNode = getTypeScriptSyntacticExpressionTypeEvidence(expression.right, context.checker);
  const storageType = sourceTypeNode ? lowerType(sourceTypeNode, context) : sourceType;
  const statements = lowerTypeScriptDestructuringAssignmentTarget(
    expression.left,
    lowerExpression(expression.right, context, sourceType),
    sourceType,
    'root',
    context,
    storageType,
  );
  const first = statements[0];
  const variable = first?.kind === 'variable' ? first.declarations[0] : undefined;
  if (!variable || 'pattern' in variable) {
    return unsupported(expression, 'destructuring assignment completion requires one aggregate value carrier');
  }
  const returns = storageType ?? sourceType ?? { kind: 'unknown', source: 'unknown' };
  return {
    arguments: [],
    callee: {
      async: false,
      body: [
        ...statements,
        {
          expression: { kind: 'identifier', reference: { binding: variable.binding, kind: 'binding' } },
          kind: 'return',
        },
      ],
      kind: 'function',
      parameters: [],
      returns,
      thisMode: 'lexical',
      typeParameters: [],
    },
    kind: 'call',
    optional: false,
    semantics: {
      statementValue: createIrStatementValueCallSemantics(),
    },
    typeArguments: [],
  };
}

function lowerTypeScriptDestructuringAssignmentTarget(
  target: ts.Expression,
  source: IrExpression,
  sourceType: Readonly<IrType> | undefined,
  path: string,
  context: LoweringContext,
  storageType?: Readonly<IrType>,
): IrStatement[] {
  const unwrapped = unwrapTypeScriptParenthesizedExpression(target);
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return lowerTypeScriptDestructuringAssignmentTarget(
      unwrapped.left,
      {
        fallback: lowerExpression(unwrapped.right, context, removeIrTypeBindingPatternUndefined(sourceType)),
        kind: 'undefinedDefault',
        value: source,
      },
      removeIrTypeBindingPatternUndefined(sourceType),
      `${path}.default`,
      context,
    );
  }
  if (ts.isArrayLiteralExpression(unwrapped) || ts.isObjectLiteralExpression(unwrapped)) {
    const binding = createTypeScriptDestructuringAssignmentBinding(unwrapped, path, context);
    const temporaryType = storageType ?? sourceType;
    const statements: IrStatement[] = [
      {
        declarations: [
          { binding, initializer: source, mutable: false, ...(temporaryType ? { type: temporaryType } : {}) },
        ],
        kind: 'variable',
      },
    ];
    const object: IrExpression = { kind: 'identifier', reference: { binding, kind: 'binding' } };
    if (ts.isArrayLiteralExpression(unwrapped)) {
      unwrapped.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) return;
        const elementType = sourceType?.kind === 'tuple' ? sourceType.elements[index]?.type : undefined;
        if (ts.isSpreadElement(element)) {
          if (index !== unwrapped.elements.length - 1) {
            unsupported(element, 'destructuring assignment array rest must be final');
          }
          if (sourceType?.kind !== 'tuple') {
            unsupported(element, 'destructuring assignment array rest requires a statically known tuple');
          }
          statements.push(
            ...lowerTypeScriptDestructuringAssignmentTarget(
              element.expression,
              { kind: 'tupleRest', object, start: index },
              getIrTupleTypeBindingPatternRest(sourceType, index),
              `${path}.rest`,
              context,
            ),
          );
          return;
        }
        statements.push(
          ...lowerTypeScriptDestructuringAssignmentTarget(
            element,
            {
              index: { kind: 'literal', value: index },
              kind: 'element',
              object,
              optional: false,
              semantics: {
                key: 'number',
                receivers: [sourceType?.kind === 'tuple' ? 'tuple' : 'unknown'],
              },
            },
            elementType,
            `${path}.elements[${String(index)}]`,
            context,
          ),
        );
      });
      return statements;
    }
    unwrapped.properties.forEach((property, index) => {
      if (ts.isSpreadAssignment(property)) {
        unsupported(property, 'object rest destructuring assignment requires object-rest lowering');
      }
      if (
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)
      ) {
        unsupported(property, 'destructuring assignment cannot contain methods or accessors');
      }
      const name = property.name;
      const keyName = ts.isComputedPropertyName(name) ? undefined : propertyName(name, context);
      const propertyType = keyName ? getIrObjectTypeBindingPatternProperty(sourceType, keyName) : undefined;
      const propertySource: IrExpression = ts.isComputedPropertyName(name)
        ? {
            index: lowerExpression(name.expression, context),
            kind: 'element',
            object,
            optional: false,
            semantics: {
              key: getTypeScriptPropertyKeyCoercion(name.expression, context),
              receivers: ['object'],
            },
          }
        : { kind: 'property', name: keyName!, object, optional: false };
      if (ts.isShorthandPropertyAssignment(property)) {
        const value = property.objectAssignmentInitializer
          ? {
              fallback: lowerExpression(
                property.objectAssignmentInitializer,
                context,
                removeIrTypeBindingPatternUndefined(propertyType),
              ),
              kind: 'undefinedDefault' as const,
              value: propertySource,
            }
          : propertySource;
        statements.push(
          ...lowerTypeScriptDestructuringAssignmentTarget(
            property.name,
            value,
            property.objectAssignmentInitializer ? removeIrTypeBindingPatternUndefined(propertyType) : propertyType,
            `${path}.properties[${String(index)}]`,
            context,
          ),
        );
        return;
      }
      statements.push(
        ...lowerTypeScriptDestructuringAssignmentTarget(
          property.initializer,
          propertySource,
          propertyType,
          `${path}.properties[${String(index)}]`,
          context,
        ),
      );
    });
    return statements;
  }
  return [
    {
      expression: {
        kind: 'assignment',
        left: lowerExpression(unwrapped, context),
        operator: '=',
        right: source,
        semantics: {
          left: lowerOperatorOperandDomains(unwrapped, context),
          result: getIrTypeOperatorValueDomain(sourceType ?? { kind: 'unknown', source: 'unknown' }),
          right: {
            declared: getIrTypeOperatorValueDomain(sourceType ?? { kind: 'unknown', source: 'unknown' }),
            flow: getIrTypeOperatorValueDomain(sourceType ?? { kind: 'unknown', source: 'unknown' }),
          },
        },
      },
      kind: 'expression',
    },
  ];
}

function createTypeScriptDestructuringAssignmentBinding(
  node: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression,
  path: string,
  context: LoweringContext,
): IrBindingIdentity {
  const source = relativeSource(context.sourceFile.fileName, context.options.upstreamDirectory);
  return {
    ...origin(node, context),
    id: `binding:${JSON.stringify([context.options.packageName, source, `destructuring-assignment:${String(node.getStart(context.sourceFile))}:${path}`])}`,
    kind: 'variable',
    name: 'destructuringAssignmentValue',
    scope: 'block',
    space: 'value',
  };
}

function unwrapTypeScriptParenthesizedExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function lowerStatementList(nodes: readonly ts.Statement[], context: LoweringContext): IrStatement[] {
  return nodes.map((node) => lowerStatement(node, context));
}

function lowerStatementListWithTypeScriptReturnType(
  nodes: readonly ts.Statement[],
  returnType: Readonly<IrType>,
  returnTargetType: Readonly<IrType>,
  context: LoweringContext,
): IrStatement[] {
  context.returnTargetTypes.push(returnTargetType);
  context.returnTypes.push(returnType);
  try {
    return lowerStatementList(nodes, context);
  } finally {
    context.returnTargetTypes.pop();
    context.returnTypes.pop();
  }
}

function lowerType(node: ts.TypeNode, context: LoweringContext): IrType {
  // A type node the ambient surface owns is written in the surface's own type parameters, which name
  // nothing in the module being lowered. Reading one back as module syntax produces an ambient type
  // called `T` that no target can bind, so the boundary is enforced where every path converges
  // rather than at each caller.
  if (node.getSourceFile().fileName === getCompilerAmbientSurfaceFileName()) return { kind: 'unknown', source: 'any' };
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
    const name = getTypeScriptNodeText(node.typeName, context);
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
  if (!parts) return { kind: 'ambient', name: getTypeScriptNodeText(node, context) };
  const symbol = context.checker.getSymbolAtLocation(parts.root);
  if (isTypeScriptAmbientSurfaceSymbol(symbol)) {
    return { kind: 'ambient', name: getTypeScriptNodeText(node, context) };
  }
  if (symbol?.declarations?.some(isValueBindingDeclaration)) {
    return { binding: lowerBindingSymbol(symbol, parts.root, context), kind: 'binding', path: parts.path };
  }
  if (symbol?.declarations?.some(isTypeBindingDeclaration)) {
    return { binding: lowerTypeBindingSymbol(symbol, parts.root, context), kind: 'binding', path: parts.path };
  }
  return { kind: 'ambient', name: getTypeScriptNodeText(node, context) };
}

function lowerValueNameReference(node: ts.EntityName, context: LoweringContext): IrValueNameReference {
  const parts = getTypeNameNodeParts(node);
  if (!parts) return { kind: 'ambient', name: getTypeScriptNodeText(node, context) };
  const symbol = context.checker.getSymbolAtLocation(parts.root);
  return symbol?.declarations?.some(isValueBindingDeclaration) && !isTypeScriptAmbientSurfaceSymbol(symbol)
    ? { binding: lowerBindingSymbol(symbol, parts.root, context), kind: 'binding', path: parts.path }
    : { kind: 'ambient', name: getTypeScriptNodeText(node, context) };
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
  return lowerTypeScriptTypeProperties(
    members,
    context,
    (node) => lowerType(node, context),
    (node) => lowerFunctionType(node, context),
  );
}

function lowerTypeScriptTypeProperties(
  members: readonly ts.TypeElement[],
  context: LoweringContext,
  lowerPropertyType: (node: ts.TypeNode) => IrType,
  lowerMethodType: (node: ts.MethodSignature) => Extract<IrType, { kind: 'function' }>,
): IrObjectTypeProperty[] {
  const properties: IrObjectTypeProperty[] = [];
  const loweredMethods = new Set<ts.MethodSignature>();
  for (const member of members) {
    if (ts.isPropertySignature(member)) {
      if (!member.type) unsupported(member, 'property signature requires a type');
      const name = propertyName(member.name, context);
      if (properties.some((property) => property.name === name)) {
        unsupported(member, `object type property ${name} is declared more than once`);
      }
      properties.push({
        name: propertyName(member.name, context),
        optional: member.questionToken !== undefined,
        readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
        type: lowerPropertyType(member.type),
      });
      continue;
    }
    if (ts.isMethodSignature(member)) {
      if (loweredMethods.has(member)) continue;
      const name = propertyName(member.name, context);
      if (properties.some((property) => property.name === name)) {
        unsupported(member, `object type member ${name} mixes property and method declarations`);
      }
      const overloads = members.filter(
        (candidate): candidate is ts.MethodSignature =>
          ts.isMethodSignature(candidate) && propertyName(candidate.name, context) === name,
      );
      const optional = member.questionToken !== undefined;
      if (overloads.some((overload) => (overload.questionToken !== undefined) !== optional)) {
        unsupported(member, `overloaded object method ${name} must use one optionality`);
      }
      overloads.forEach((overload) => loweredMethods.add(overload));
      const types = overloads.map(lowerMethodType);
      const [first, second, ...rest] = types;
      properties.push({
        name,
        optional,
        readonly: true,
        type: first && second ? { kind: 'intersection', types: [first, second, ...rest] } : first!,
      });
      continue;
    }
    unsupported(member, `unsupported type member ${ts.SyntaxKind[member.kind]}`);
  }
  return properties;
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
  const valueType = node.type ? lowerTypeScriptTypeNodeEvidence(node.type, context) : type;
  const target = ts.isIdentifier(node.name)
    ? { binding: lowerBindingIdentity(node.name, context) }
    : { pattern: lowerBindingPattern(node.name, context, valueType) };
  if (ts.isIdentifier(node.name) && valueType) addTypeScriptBindingTypeEvidence(node.name, valueType, context);
  return {
    ...target,
    ...(node.initializer ? { initializer: lowerExpression(node.initializer, context, valueType, type) } : {}),
    mutable,
    ...(type ? { type } : {}),
  };
}

function getTypeScriptForInKeyPlan(
  expression: ts.Expression,
  context: LoweringContext,
): Readonly<{ keyPlan: IrForInKeyPlan }> | undefined {
  const keyPlan = getTypeScriptForInKeyEvidence(expression, context.checker, context.sourceFile, (name) =>
    propertyName(name, context),
  );
  return keyPlan ? { keyPlan } : undefined;
}

function lowerTypeScriptForOfElementType(expression: ts.Expression, context: LoweringContext): IrType | undefined {
  const iterableType = getTypeScriptSyntacticExpressionTypeEvidence(expression, context.checker);
  if (!iterableType) return undefined;
  const element = getTypeScriptTypeNodeIterableElementEvidence(iterableType, context, new Set());
  return element ? lowerTypeScriptTypeNodeEvidence(element.type, context, new Set(), element.substitutions) : undefined;
}

function lowerTypeScriptExpressionTypeEvidence(
  expression: ts.Expression,
  context: LoweringContext,
): IrType | undefined {
  // An indexed read has no declaration to read a written type off, so its evidence is the collection
  // it reads from. Without this the element is unknown, and every operator over it refuses.
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    const index = ts.isNumericLiteral(expression.argumentExpression)
      ? Number(expression.argumentExpression.text)
      : undefined;
    const element = getIrTypeIndexedElementEvidence(
      lowerTypeScriptExpressionTypeEvidence(expression.expression, context),
      index,
    );
    if (element) return element;
  }
  // A coalesce yields the left operand with its absent members removed, or the right one. Where both
  // are the same written type that is the answer; where they differ there is no single written type
  // to name, and the caller keeps its unknown rather than picking one.
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    const left = lowerTypeScriptExpressionTypeEvidence(expression.left, context);
    const right = inferInitializerType(expression.right, context);
    const present = left ? removeIrTypeAbsentMembersSemantic(left) : undefined;
    if (present && right && JSON.stringify(present) === JSON.stringify(right)) return present;
  }
  const type = getTypeScriptSyntacticExpressionTypeEvidence(expression, context.checker);
  // A type node the ambient surface owns is written in the surface's own type parameters, which mean
  // nothing in the module being lowered. Whatever path reached it, it stops here.
  if (!type || type.getSourceFile().fileName === getCompilerAmbientSurfaceFileName()) return undefined;
  return lowerTypeScriptTypeNodeEvidence(type, context);
}

function removeIrTypeAbsentMembersSemantic(type: Readonly<IrType>): Readonly<IrType> | undefined {
  if (type.kind === 'null' || type.kind === 'undefined') return undefined;
  if (type.kind !== 'union') return type;
  const present = type.types.filter((member) => !hasIrTypeAbsentMemberSemantic(member));
  return present.length === 1
    ? present[0]
    : present.length > 1
      ? { kind: 'union', types: [present[0]!, present[1]!, ...present.slice(2)] }
      : undefined;
}

interface TypeScriptTypeNodeEvidence {
  readonly substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>;
  readonly type: ts.TypeNode;
}

function getTypeScriptTypeNodeIterableElementEvidence(
  type: ts.TypeNode,
  context: LoweringContext,
  seen: ReadonlySet<ts.Symbol>,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode> = new Map(),
): TypeScriptTypeNodeEvidence | undefined {
  const substituted = getTypeScriptSyntacticTypeSubstitution(type, context.checker, substitutions);
  if (substituted !== type) {
    return getTypeScriptTypeNodeIterableElementEvidence(substituted, context, seen, substitutions);
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return getTypeScriptTypeNodeIterableElementEvidence(type.type, context, seen, substitutions);
  }
  if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return getTypeScriptTypeNodeIterableElementEvidence(type.type, context, seen, substitutions);
  }
  if (ts.isArrayTypeNode(type)) return { substitutions, type: type.elementType };
  if (ts.isTypeReferenceNode(type)) {
    const parts = getTypeNameNodeParts(type.typeName);
    const name = parts ? [parts.root.text, ...parts.path].join('.') : undefined;
    const element = type.typeArguments?.[0];
    if ((name === 'Array' || name === 'ReadonlyArray') && type.typeArguments?.length === 1 && element) {
      return { substitutions, type: element };
    }
    const symbol = context.checker.getSymbolAtLocation(type.typeName);
    if (!symbol || seen.has(symbol)) return undefined;
    const declaration = symbol.declarations?.find(ts.isTypeAliasDeclaration);
    if (!declaration) return undefined;
    const nextSubstitutions = createTypeScriptSyntacticAliasSubstitutions(
      type,
      declaration,
      context.checker,
      substitutions,
    );
    if (!nextSubstitutions) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(symbol);
    return getTypeScriptTypeNodeIterableElementEvidence(declaration.type, context, nextSeen, nextSubstitutions);
  }
  return undefined;
}

function lowerTypeScriptTypeNodeEvidence(
  type: ts.TypeNode,
  context: LoweringContext,
  seen: ReadonlySet<ts.Symbol> = new Set(),
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode> = new Map(),
): IrType {
  const substituted = getTypeScriptSyntacticTypeSubstitution(type, context.checker, substitutions);
  if (substituted !== type) return lowerTypeScriptTypeNodeEvidence(substituted, context, seen, substitutions);
  // A type node the ambient surface owns is written in the surface's own type parameters. Lowering
  // one would introduce a type named `T` that belongs to no module and that no target can bind, so
  // every path into this function stops at the boundary rather than each caller remembering to.
  if (type.getSourceFile().fileName === getCompilerAmbientSurfaceFileName()) return { kind: 'unknown', source: 'any' };
  if (ts.isParenthesizedTypeNode(type)) {
    return lowerTypeScriptTypeNodeEvidence(type.type, context, seen, substitutions);
  }
  if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) {
    const inner = lowerTypeScriptTypeNodeEvidence(type.type, context, seen, substitutions);
    return inner.kind === 'array' || inner.kind === 'tuple' ? { ...inner, readonly: true } : inner;
  }
  if (ts.isTypeReferenceNode(type)) {
    const parts = getTypeNameNodeParts(type.typeName);
    const name = parts ? [parts.root.text, ...parts.path].join('.') : undefined;
    const element = type.typeArguments?.[0];
    if ((name === 'Array' || name === 'ReadonlyArray') && type.typeArguments?.length === 1 && element) {
      return {
        element: lowerTypeScriptTypeNodeEvidence(element, context, seen, substitutions),
        kind: 'array',
        readonly: name === 'ReadonlyArray',
      };
    }
    const symbol = context.checker.getSymbolAtLocation(type.typeName);
    const declaration = symbol?.declarations?.find(
      (candidate): candidate is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
        ts.isInterfaceDeclaration(candidate) || ts.isTypeAliasDeclaration(candidate),
    );
    if (symbol && declaration && !seen.has(symbol)) {
      const nextSubstitutions = createTypeScriptSyntacticDeclarationSubstitutions(
        type,
        declaration,
        context.checker,
        substitutions,
      );
      const nextSeen = new Set(seen);
      nextSeen.add(symbol);
      if (nextSubstitutions) {
        if (ts.isTypeAliasDeclaration(declaration)) {
          return lowerTypeScriptTypeNodeEvidence(declaration.type, context, nextSeen, nextSubstitutions);
        }
      }
      if (ts.isInterfaceDeclaration(declaration) && nextSubstitutions) {
        return {
          kind: 'object',
          properties: lowerTypeScriptInterfacePropertiesEvidence(declaration, context, nextSeen, nextSubstitutions),
        };
      }
    }
    return lowerType(type, context);
  }
  if (ts.isArrayTypeNode(type)) {
    return {
      element: lowerTypeScriptTypeNodeEvidence(type.elementType, context, seen, substitutions),
      kind: 'array',
      readonly: false,
    };
  }
  if (ts.isTupleTypeNode(type)) {
    return {
      elements: type.elements.map((element): IrTupleTypeElement => {
        if (ts.isOptionalTypeNode(element)) {
          return {
            optional: true,
            rest: false,
            type: lowerTypeScriptTypeNodeEvidence(element.type, context, seen, substitutions),
          };
        }
        if (ts.isRestTypeNode(element)) {
          return {
            optional: false,
            rest: true,
            type: lowerTypeScriptTypeNodeEvidence(element.type, context, seen, substitutions),
          };
        }
        if (ts.isNamedTupleMember(element)) {
          const value = lowerTypeScriptTypeNodeEvidence(element.type, context, seen, substitutions);
          if (element.dotDotDotToken) return { optional: false, rest: true, type: value };
          return element.questionToken
            ? { optional: true, rest: false, type: value }
            : { optional: false, rest: false, type: value };
        }
        return {
          optional: false,
          rest: false,
          type: lowerTypeScriptTypeNodeEvidence(element, context, seen, substitutions),
        };
      }),
      kind: 'tuple',
      readonly: false,
    };
  }
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    const types = type.types.map((member) => lowerTypeScriptTypeNodeEvidence(member, context, seen, substitutions));
    if (types.length < 2) return lowerType(type, context);
    return type.kind === ts.SyntaxKind.UnionType
      ? { kind: 'union', types: [types[0]!, types[1]!, ...types.slice(2)] }
      : { kind: 'intersection', types: [types[0]!, types[1]!, ...types.slice(2)] };
  }
  if (ts.isTypeLiteralNode(type)) {
    return {
      kind: 'object',
      properties: lowerTypeScriptTypePropertiesEvidence(type.members, context, seen, substitutions),
    };
  }
  return lowerType(type, context);
}

function lowerTypeScriptFunctionTypeEvidence(
  node: ts.SignatureDeclaration,
  context: LoweringContext,
  seen: ReadonlySet<ts.Symbol>,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>,
): Extract<IrType, { kind: 'function' }> {
  return {
    kind: 'function',
    parameters: node.parameters
      .filter((parameter) => !isThisParameter(parameter))
      .map((parameter): IrFunctionTypeParameter => {
        const type: IrType = parameter.type
          ? lowerTypeScriptTypeNodeEvidence(parameter.type, context, seen, substitutions)
          : parameter.initializer
            ? inferInitializerType(parameter.initializer, context)
            : { kind: 'unknown', source: 'any' };
        const value = { name: ts.isIdentifier(parameter.name) ? parameter.name.text : 'parameterPatternValue', type };
        if (parameter.dotDotDotToken) return { ...value, optional: false, rest: true };
        return parameter.questionToken || parameter.initializer
          ? { ...value, optional: true, rest: false }
          : { ...value, optional: false, rest: false };
      }),
    returns: node.type
      ? lowerTypeScriptTypeNodeEvidence(node.type, context, seen, substitutions)
      : { kind: 'unknown', source: 'any' },
    typeParameters: lowerTypeParameters(node.typeParameters, context),
  };
}

function lowerTypeScriptTypePropertiesEvidence(
  members: readonly ts.TypeElement[],
  context: LoweringContext,
  seen: ReadonlySet<ts.Symbol>,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>,
): readonly IrObjectTypeProperty[] {
  return lowerTypeScriptTypeProperties(
    members,
    context,
    (node) => lowerTypeScriptTypeNodeEvidence(node, context, seen, substitutions),
    (node) => lowerTypeScriptFunctionTypeEvidence(node, context, seen, substitutions),
  );
}

function lowerTypeScriptInterfacePropertiesEvidence(
  declaration: ts.InterfaceDeclaration,
  context: LoweringContext,
  seen: ReadonlySet<ts.Symbol>,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>,
): readonly IrObjectTypeProperty[] {
  const properties: IrObjectTypeProperty[] = [];
  const mergeProperty = (property: IrObjectTypeProperty, node: ts.Node): void => {
    const index = properties.findIndex((candidate) => candidate.name === property.name);
    if (index < 0) {
      properties.push(property);
      return;
    }
    if (JSON.stringify(properties[index]) !== JSON.stringify(property)) {
      unsupported(node, `interface ${declaration.name.text} inherits incompatible property ${property.name}`);
    }
    properties[index] = property;
  };
  for (const clause of declaration.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const heritage of clause.types) {
      const unresolved = context.checker.getSymbolAtLocation(heritage.expression);
      const symbol =
        unresolved?.flags && unresolved.flags & ts.SymbolFlags.Alias
          ? context.checker.getAliasedSymbol(unresolved)
          : unresolved;
      const base = symbol?.declarations?.find(ts.isInterfaceDeclaration);
      if (!symbol || !base) unsupported(heritage, 'syntactic interface heritage requires an interface reference');
      if (seen.has(symbol)) unsupported(heritage, `interface ${declaration.name.text} has cyclic heritage`);
      const nextSubstitutions = createTypeScriptSyntacticDeclarationSubstitutions(
        heritage,
        base,
        context.checker,
        substitutions,
      );
      if (!nextSubstitutions) {
        unsupported(heritage, `interface ${base.name.text} heritage type arguments cannot be substituted`);
      }
      const nextSeen = new Set(seen);
      nextSeen.add(symbol);
      lowerTypeScriptInterfacePropertiesEvidence(base, context, nextSeen, nextSubstitutions).forEach((property) =>
        mergeProperty(property, heritage),
      );
    }
  }
  lowerTypeScriptTypePropertiesEvidence(declaration.members, context, seen, substitutions).forEach((property) =>
    mergeProperty(property, declaration),
  );
  return properties;
}

function lowerBindingPattern(
  node: ts.BindingName,
  context: LoweringContext,
  sourceType?: Readonly<IrType>,
): IrBindingPattern {
  if (ts.isIdentifier(node)) {
    if (sourceType) addTypeScriptBindingTypeEvidence(node, sourceType, context);
    return {
      binding: lowerBindingIdentity(node, context),
      kind: 'binding',
      ...(sourceType ? { type: sourceType } : {}),
    };
  }
  if (ts.isObjectBindingPattern(node)) {
    const properties: IrObjectBindingPatternProperty[] = [];
    const excludedNames: string[] = [];
    let hasComputedKey = false;
    let rest: IrBindingPattern | undefined;
    node.elements.forEach((element, index) => {
      if (element.dotDotDotToken) {
        if (index !== node.elements.length - 1) unsupported(element, 'object binding rest must be the final element');
        if (element.propertyName) unsupported(element, 'object binding rest cannot have a property name');
        if (element.initializer) unsupported(element, 'object binding rest cannot have a default initializer');
        rest = lowerBindingPattern(
          element.name,
          context,
          getIrObjectTypeBindingPatternRest(sourceType, excludedNames, hasComputedKey),
        );
        return;
      }
      const propertyNode =
        element.propertyName ??
        (ts.isIdentifier(element.name)
          ? element.name
          : unsupported(element.name, 'nested object binding requires an explicit property name'));
      const key = ts.isComputedPropertyName(propertyNode)
        ? {
            coercion: getTypeScriptPropertyKeyCoercion(propertyNode.expression, context),
            expression: lowerExpression(propertyNode.expression, context),
            kind: 'computed' as const,
          }
        : { kind: 'named' as const, name: propertyName(propertyNode, context) };
      const propertyType =
        key.kind === 'named' ? getIrObjectTypeBindingPatternProperty(sourceType, key.name) : undefined;
      if (key.kind === 'named') excludedNames.push(key.name);
      else hasComputedKey = true;
      const initializerType = element.initializer ? removeIrTypeBindingPatternUndefined(propertyType) : propertyType;
      properties.push({
        ...(element.initializer ? { initializer: lowerExpression(element.initializer, context, initializerType) } : {}),
        key,
        pattern: lowerBindingPattern(element.name, context, initializerType),
      });
    });
    return {
      ...origin(node, context),
      kind: 'object',
      properties,
      ...(rest ? { rest } : {}),
      scope: bindingPatternScope(node),
      ...(sourceType ? { type: sourceType } : {}),
    };
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
      const restType = getIrTupleTypeBindingPatternRest(sourceType, index);
      rest = lowerBindingPattern(element.name, context, restType);
      return;
    }
    const elementType = sourceType?.kind === 'tuple' ? sourceType.elements[index]?.type : undefined;
    const initializerType = element.initializer ? removeIrTypeBindingPatternUndefined(elementType) : elementType;
    elements.push({
      ...(element.initializer ? { initializer: lowerExpression(element.initializer, context, initializerType) } : {}),
      pattern: lowerBindingPattern(element.name, context, initializerType),
    });
  });
  return {
    ...origin(node, context),
    elements,
    kind: 'array',
    ...(rest ? { rest } : {}),
    scope: bindingPatternScope(node),
    ...(sourceType ? { type: sourceType } : {}),
  };
}

function getIrTupleTypeBindingPatternRest(sourceType: Readonly<IrType> | undefined, index: number): IrType | undefined {
  if (sourceType?.kind !== 'tuple') return undefined;
  const element = sourceType.elements[index];
  if (element?.rest) return element.type;
  return {
    elements: sourceType.elements.slice(index),
    kind: 'tuple',
    readonly: false,
  };
}

function getIrObjectTypeBindingPatternProperty(
  sourceType: Readonly<IrType> | undefined,
  name: string,
): IrType | undefined {
  if (sourceType?.kind !== 'object') return undefined;
  const property = sourceType.properties.find((candidate) => candidate.name === name);
  if (!property) return undefined;
  return property.optional ? addIrTypeBindingPatternUndefined(property.type) : property.type;
}

function getIrObjectTypeBindingPatternRest(
  sourceType: Readonly<IrType> | undefined,
  excludedNames: readonly string[],
  hasComputedKey: boolean,
): IrType | undefined {
  if (sourceType?.kind !== 'object') return undefined;
  if (hasComputedKey) return { kind: 'unknown', source: 'object' };
  const excluded = new Set(excludedNames);
  return { kind: 'object', properties: sourceType.properties.filter((property) => !excluded.has(property.name)) };
}

function addIrTypeBindingPatternUndefined(type: Readonly<IrType>): IrType {
  if (
    type.kind === 'undefined' ||
    (type.kind === 'union' && type.types.some((member) => member.kind === 'undefined'))
  ) {
    return type;
  }
  return type.kind === 'union'
    ? { kind: 'union', types: [type.types[0], type.types[1], ...type.types.slice(2), { kind: 'undefined' }] }
    : { kind: 'union', types: [type, { kind: 'undefined' }] };
}

function removeIrTypeBindingPatternUndefined(type: Readonly<IrType> | undefined): IrType | undefined {
  if (type?.kind !== 'union') return type;
  const retained = type.types.filter((member) => member.kind !== 'undefined');
  if (retained.length === 1) return retained[0];
  return retained.length >= 2
    ? { kind: 'union', types: [retained[0]!, retained[1]!, ...retained.slice(2)] }
    : undefined;
}

function bindingPatternScope(node: ts.BindingPattern): IrBindingScope {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent)) return bindingDeclarationScope(parent);
    if (ts.isParameter(parent)) return 'function';
  }
  return unsupported(node, 'binding pattern has no variable declaration owner');
}

function lowerVariableStatement(node: ts.VariableStatement, context: LoweringContext): IrVariableDeclaration[] {
  return lowerVariables(node.declarationList, context).map((variable, index) => ({
    ...variable,
    declarationKind: getTypeScriptVariableDeclarationKind(node.declarationList),
    exported: isExported(node),
    kind: 'variable',
    origin: origin(node.declarationList.declarations[index]!, context),
  }));
}

function getTypeScriptVariableDeclarationKind(
  node: ts.VariableDeclarationList,
): IrVariableDeclaration['declarationKind'] {
  if (node.flags & ts.NodeFlags.Const) return 'const';
  if (node.flags & ts.NodeFlags.Let) return 'let';
  return 'var';
}

function inferInitializerType(node: ts.Expression, context: LoweringContext): IrType {
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: 'primitive', name: 'boolean' };
  }
  if (ts.isNumericLiteral(node)) return { kind: 'primitive', name: 'number' };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: 'null' };
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
  if (ts.isObjectLiteralExpression(node)) {
    const properties = new Map<string, IrObjectTypeProperty>();
    for (const member of node.properties) {
      if (ts.isSpreadAssignment(member) || ts.isComputedPropertyName(member.name)) {
        return { kind: 'unknown', source: 'object' };
      }
      const name = propertyName(member.name, context);
      const type = ts.isShorthandPropertyAssignment(member)
        ? (lowerTypeScriptExpressionTypeEvidence(member.name, context) ?? inferInitializerType(member.name, context))
        : ts.isPropertyAssignment(member)
          ? (lowerTypeScriptExpressionTypeEvidence(member.initializer, context) ??
            inferInitializerType(member.initializer, context))
          : ts.isMethodDeclaration(member)
            ? lowerFunctionType(member, context)
            : undefined;
      if (!type) return { kind: 'unknown', source: 'object' };
      properties.set(name, { name, optional: false, readonly: false, type });
    }
    return { kind: 'object', properties: [...properties.values()] };
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return lowerFunctionType(node, context);
  }
  // Where no written type reaches the value — a call into the ambient surface returns the surface's
  // own type parameter, which names nothing here — the checker's instantiation of it does.
  return (
    lowerTypeScriptExpressionTypeEvidence(node, context) ??
    getTypeScriptCheckerTypeEvidence(context.checker.getTypeAtLocation(node), context, 0) ?? {
      kind: 'unknown',
      source: 'any',
    }
  );
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
  const left = lowerOperatorOperandDomains(node.left, context);
  const right = lowerOperatorOperandDomains(node.right, context);
  const result = lowerOperatorValueDomain(node, context);
  return {
    left,
    result:
      result === 'unknown' ? (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? right.flow : left.flow) : result,
    right,
  };
}

function lowerBinaryOperator(kind: TypeScriptBinaryOperator): IrBinaryOperator {
  return typeScriptBinaryOperators[kind];
}

function lowerBinaryOperatorSemantics(node: ts.BinaryExpression, context: LoweringContext): IrBinaryOperatorSemantics {
  const left = lowerOperatorOperandDomains(node.left, context);
  const right = lowerOperatorOperandDomains(node.right, context);
  const result = lowerOperatorValueDomain(node, context);
  const nullishComparison = getTypeScriptNullishComparisonEvidence(node, context);
  return {
    left,
    ...(nullishComparison ? { nullishComparison } : {}),
    // A checker with no library types often cannot type the whole expression even when it typed both
    // operands, so the operator's own rule stands in rather than reporting an unknown result and
    // refusing an operation whose domains are decided.
    result:
      result === 'unknown'
        ? getIrBinaryOperatorResultDomain(
            lowerBinaryOperator(node.operatorToken.kind as TypeScriptBinaryOperator),
            node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
              ? (getTypeScriptPresentValueDomain(node.left, context) ?? left.flow)
              : left.flow,
            right.flow,
          )
        : result,
    right,
  };
}

// One side of an equality being `null` or `undefined` makes the other side's absent-value membership
// the only thing a single-absent-value target needs to decide the comparison. The membership comes
// from the written type, because the checker without a library cannot narrow the union either.
// The domain of an operand once its absent values are removed, which is what `??` actually yields on
// the left-hand route. A written array element type answers the indexed case, where the checker
// reports `T | undefined` under checked indexed access but the element type is the one that survives.
function getTypeScriptPresentValueDomain(
  expression: ts.Expression,
  context: LoweringContext,
): IrOperatorValueDomain | undefined {
  if (ts.isElementAccessExpression(expression)) {
    const object = getTypeScriptExpressionBindingTypeEvidence(expression.expression, context);
    if (object?.kind === 'array') return getIrTypeOperatorValueDomain(object.element);
    return undefined;
  }
  const type = getTypeScriptExpressionBindingTypeEvidence(expression, context);
  if (type?.kind !== 'union') return undefined;
  const present = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
  const domains = new Set(present.map((member) => getIrTypeOperatorValueDomain(member)));
  return domains.size === 1 ? [...domains][0] : undefined;
}

function getTypeScriptNullishComparisonEvidence(
  node: ts.BinaryExpression,
  context: LoweringContext,
): IrNullishComparisonEvidence | undefined {
  const equality =
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!equality) return undefined;
  const literalOf = (expression: ts.Expression): 'null' | 'undefined' | undefined => {
    if (expression.kind === ts.SyntaxKind.NullKeyword) return 'null';
    return ts.isIdentifier(expression) && expression.text === 'undefined' ? 'undefined' : undefined;
  };
  const leftLiteral = literalOf(node.left);
  const rightLiteral = literalOf(node.right);
  const literal = leftLiteral ?? rightLiteral;
  if (!literal || (leftLiteral && rightLiteral)) return undefined;
  const operand = leftLiteral ? node.right : node.left;
  const type = getTypeScriptExpressionBindingTypeEvidence(operand, context);
  if (!type) return undefined;
  const members = type.kind === 'union' ? type.types : [type];
  return {
    admitsNull: members.some((member) => member.kind === 'null'),
    admitsUndefined: members.some((member) => member.kind === 'undefined'),
    literal,
  };
}

function lowerOperatorOperandDomains(node: ts.Expression, context: LoweringContext): IrOperatorOperandDomains {
  const flowType = context.checker.getTypeAtLocation(node);
  const declaredType = getTypeScriptExpressionDeclaredType(node, context) ?? flowType;
  const evidence = getTypeScriptExpressionBindingTypeEvidence(node, context);
  const evidenceDomain = getIrTypeOperatorValueDomain(evidence);
  const declared = lowerTypeScriptTypeOperatorValueDomain(declaredType, context.checker);
  const flow = lowerTypeScriptTypeOperatorValueDomain(flowType, context.checker);
  // An operand that is itself an operator expression has a domain the operator's own rule decides,
  // and the checker cannot see it for the same reason it could not see the inner one: no library.
  const operator =
    evidenceDomain === 'unknown' && ts.isBinaryExpression(node) && (declared === 'unknown' || flow === 'unknown')
      ? getTypeScriptBinaryExpressionResultDomain(node, context)
      : 'unknown';
  const fallback = evidenceDomain === 'unknown' ? operator : evidenceDomain;
  return {
    declared: declared === 'unknown' ? fallback : declared,
    flow: flow === 'unknown' ? fallback : flow,
  };
}

function getTypeScriptBinaryExpressionResultDomain(
  node: ts.BinaryExpression,
  context: LoweringContext,
): IrOperatorValueDomain {
  const operator = typeScriptBinaryOperators[node.operatorToken.kind as TypeScriptBinaryOperator];
  if (!operator) return 'unknown';
  const left = lowerOperatorOperandDomains(node.left, context);
  const right = lowerOperatorOperandDomains(node.right, context);
  return getIrBinaryOperatorResultDomain(
    operator,
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ? (getTypeScriptPresentValueDomain(node.left, context) ?? left.flow)
      : left.flow,
    right.flow,
  );
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

// TypeScript already narrows: at a reference after `if (value === undefined) return;` the flow type
// no longer includes `undefined`, while the declaration's type still does. That difference is the
// proof a target needs to use the value, and it is read here rather than re-derived, because the
// checker's flow analysis is the source language's own answer.
function getTypeScriptReferencePresence(
  node: ts.Identifier,
  reference: Readonly<IrIdentifierReference>,
  context: LoweringContext,
): { presence?: 'narrowedPresent' } {
  if (reference.kind !== 'binding') return {};
  const symbol = context.checker.getSymbolAtLocation(node);
  const declared = symbol ? context.bindingTypes.get(symbol) : undefined;
  if (!declared || !hasIrTypeAbsentMemberSemantic(declared)) return {};
  const flow = context.checker.getTypeAtLocation(node);
  const members = flow.isUnion() ? flow.types : [flow];
  const absent = members.some(
    (member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) !== 0,
  );
  return absent ? {} : { presence: 'narrowedPresent' };
}

// Which alternative of a union-typed binding this reference was proved to hold. The proof is the
// checker's, not this compiler's: the declared type is a union of named alternatives and the flow
// type at this reference is exactly one of them. A union of literals or of anonymous shapes has no
// member name to carry, so it is left unnarrowed rather than described by a name a target cannot
// resolve.
function getTypeScriptReferenceNarrowedMember(
  node: ts.Identifier,
  reference: Readonly<IrIdentifierReference>,
  context: LoweringContext,
): { narrowedMember?: string } {
  if (reference.kind !== 'binding') return {};
  const symbol = context.checker.getSymbolAtLocation(node);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!symbol || !declaration) return {};
  const declared = context.checker.getTypeOfSymbolAtLocation(symbol, declaration);
  if (!declared.isUnion()) return {};
  const flow = context.checker.getTypeAtLocation(node);
  if (flow.isUnion()) return {};
  const narrowed = getTypeScriptNamedTypeMemberName(flow);
  if (!narrowed) return {};
  const members = declared.types.map((member) => getTypeScriptNamedTypeMemberName(member));
  return members.filter((member) => member === narrowed).length === 1 ? { narrowedMember: narrowed } : {};
}

// Whether the written type declares this member optional. The declaration is the authority rather
// than the checker's type, because a checker with no library types reports too little and because
// what a target needs to know is what the source wrote.
// Which kind of ambient value this member was read from. Only the written type answers: a checker
// with the ambient surface loaded would also answer for a value the source never described, and a
// backend cannot bind a member whose receiver it cannot name.
function getIrResolvedMemberReceiver(type: Readonly<IrType> | undefined): IrResolvedMemberReceiver | undefined {
  if (!type) return undefined;
  if (type.kind === 'array') return 'array';
  if (type.kind === 'tuple') return 'tuple';
  if (type.kind === 'named' && type.reference.kind === 'ambient') {
    const ambientReceivers: Record<string, IrResolvedMemberReceiver> = {
      Date: 'date',
      Error: 'error',
      Map: 'map',
      Promise: 'task',
      Set: 'set',
    };
    return ambientReceivers[type.reference.name];
  }
  if (type.kind !== 'primitive') return undefined;
  return type.name === 'string' ? 'string' : type.name === 'number' ? 'number' : undefined;
}

function isTypeScriptOptionalMemberAccess(node: ts.PropertyAccessExpression, context: LoweringContext): boolean {
  const declaration = context.checker.getSymbolAtLocation(node.name)?.declarations?.[0];
  return (
    declaration !== undefined &&
    (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)) &&
    declaration.questionToken !== undefined
  );
}

function getTypeScriptNamedTypeMemberName(type: ts.Type): string | undefined {
  const name = type.aliasSymbol?.name ?? type.getSymbol()?.name;
  return name && name !== '__type' && name !== '__object' ? name : undefined;
}

// What a callback's parameter holds, when the source did not annotate it and the position it was
// passed to decides. `values.map((value) => value * 2)` writes no type for `value`; the ambient
// surface says `map` takes `(value: T, index: number) => U` and the checker instantiates `T`. That
// instantiation is the checker's work, not syntax, so this is the one place a checker type is read
// back into the neutral model — and only for the shapes a target can name without guessing.
function getTypeScriptContextualParameterType(
  node: ts.ParameterDeclaration,
  context: LoweringContext,
): Readonly<IrType> | undefined {
  if (!ts.isIdentifier(node.name)) return undefined;
  return getTypeScriptCheckerTypeEvidence(context.checker.getTypeAtLocation(node), context, 0);
}

// A type the checker resolved to something this module declares. The declaration's own name is what
// the neutral model carries, so the reference is rebuilt from it rather than from the checker's
// spelling — a type named in a callback parameter is the same type the module already introduced.
function getTypeScriptDeclaredTypeEvidence(type: ts.Type, context: LoweringContext): Readonly<IrType> | undefined {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const declaration = symbol?.declarations?.[0];
  if (!symbol || !declaration || declaration.getSourceFile() !== context.sourceFile) return undefined;
  const name = ts.getNameOfDeclaration(declaration);
  if (!name || !ts.isIdentifier(name)) return undefined;
  // Which space the name lives in decides which identity it has, exactly as it does when the source
  // writes the name out. A class is a value that also names a type; an interface is only a type.
  const declarations = symbol.declarations ?? [];
  const binding = declarations.some(isValueBindingDeclaration)
    ? lowerBindingSymbol(symbol, name, context)
    : declarations.some(isTypeBindingDeclaration)
      ? lowerTypeBindingSymbol(symbol, name, context)
      : undefined;
  if (!binding) return undefined;
  return { kind: 'named', reference: { binding, kind: 'binding', path: [] }, typeArguments: [] };
}

function getTypeScriptCheckerTypeEvidence(
  type: ts.Type,
  context: LoweringContext,
  depth: number,
): Readonly<IrType> | undefined {
  const checker = context.checker;
  if (depth > 4) return undefined;
  if (type.flags & ts.TypeFlags.BooleanLike) return { kind: 'primitive', name: 'boolean' };
  if (type.flags & ts.TypeFlags.NumberLike) return { kind: 'primitive', name: 'number' };
  if (type.flags & ts.TypeFlags.StringLike) return { kind: 'primitive', name: 'string' };
  if (type.flags & ts.TypeFlags.Void) return { kind: 'primitive', name: 'void' };
  if (type.flags & ts.TypeFlags.Undefined) return { kind: 'undefined' };
  if (type.flags & ts.TypeFlags.Null) return { kind: 'null' };
  if (checker.isArrayType(type)) {
    const element = checker.getTypeArguments(type as ts.TypeReference)[0];
    const lowered = element ? getTypeScriptCheckerTypeEvidence(element, context, depth + 1) : undefined;
    return lowered ? { element: lowered, kind: 'array', readonly: false } : undefined;
  }
  return getTypeScriptDeclaredTypeEvidence(type, context);
}

function hasIrTypeAbsentMemberSemantic(type: Readonly<IrType>): boolean {
  if (type.kind === 'null' || type.kind === 'undefined') return true;
  return type.kind === 'union' && type.types.some((member) => hasIrTypeAbsentMemberSemantic(member));
}

function getTypeScriptExpressionBindingTypeEvidence(
  expression: ts.Expression,
  context: LoweringContext,
): Readonly<IrType> | undefined {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return getTypeScriptExpressionBindingTypeEvidence(expression.expression, context);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    // The member's own declaration carries the written type, which a receiver named by a reference
    // does not: resolving the reference would mean resolving every alias the source went through.
    const declaration = context.checker.getSymbolAtLocation(expression.name)?.declarations?.[0];
    if (
      declaration &&
      (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)) &&
      declaration.type
    ) {
      const written = lowerTypeScriptTypeNodeEvidence(declaration.type, context);
      return declaration.questionToken ? { kind: 'union', types: [written, { kind: 'undefined' }] } : written;
    }
    return getIrTypeMemberEvidence(
      getTypeScriptExpressionBindingTypeEvidence(expression.expression, context),
      expression.name.text,
    );
  }
  // A call's result has no declaration to read a written type off, and a call into the ambient
  // surface returns the surface's own type parameter. The checker's instantiation is what says an
  // array came back, which is what decides whether the member read next is an array's.
  if (ts.isCallExpression(expression)) {
    return getTypeScriptCheckerTypeEvidence(context.checker.getTypeAtLocation(expression), context, 0);
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = context.checker.getSymbolAtLocation(expression);
  return symbol ? context.bindingTypes.get(symbol) : undefined;
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

function isTypeScriptParameterProperty(node: ts.ParameterDeclaration): boolean {
  return [
    ts.SyntaxKind.OverrideKeyword,
    ts.SyntaxKind.PrivateKeyword,
    ts.SyntaxKind.ProtectedKeyword,
    ts.SyntaxKind.PublicKeyword,
    ts.SyntaxKind.ReadonlyKeyword,
  ].some((kind) => hasModifier(node, kind));
}

function createTypeScriptAnalysis(sourceFile: ts.SourceFile): TypeScriptAnalysis {
  const analysisSourceFile = ts.createSourceFile(
    sourceFile.fileName,
    sourceFile.text,
    sourceFile.languageVersion,
    true,
  );
  // The only library the analysis checker sees is the one this compiler declares. `noLib` stays on
  // so nothing from the machine's installed definitions can leak in and be typed against a member no
  // backend has agreed to lower.
  const surfaceFile = ts.createSourceFile(
    getCompilerAmbientSurfaceFileName(),
    createCompilerAmbientSurfaceSource(),
    analysisSourceFile.languageVersion,
    true,
  );
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    strictNullChecks: true,
    target: analysisSourceFile.languageVersion,
  };
  const files = new Map([
    [analysisSourceFile.fileName, analysisSourceFile],
    [surfaceFile.fileName, surfaceFile],
  ]);
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (file) => files.has(file);
  host.getSourceFile = (file) => files.get(file);
  host.readFile = (file) => files.get(file)?.text;
  host.writeFile = () => undefined;
  const program = ts.createProgram({
    host,
    options,
    rootNames: [surfaceFile.fileName, analysisSourceFile.fileName],
  });
  return { checker: program.getTypeChecker(), sourceFile: analysisSourceFile };
}

function lowerIdentifierReference(node: ts.Identifier, context: LoweringContext): IrIdentifierReference {
  const symbol =
    ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? context.checker.getShorthandAssignmentValueSymbol(node.parent)
      : context.checker.getSymbolAtLocation(node);
  return symbol?.declarations?.some(isValueBindingDeclaration) && !isTypeScriptAmbientSurfaceSymbol(symbol)
    ? { binding: lowerBindingSymbol(symbol, node, context), kind: 'binding' }
    : { kind: 'ambient', name: node.text };
}

// A node's own text, read from the file it belongs to. A node reached through the ambient surface
// does not belong to the module being lowered, and asking it for its text against the wrong file
// yields an empty name — which then travels as an ambient symbol nobody can bind or report.
function getTypeScriptNodeText(node: ts.Node, context: LoweringContext): string {
  const sourceFile = node.getSourceFile();
  return node.getText(sourceFile === context.sourceFile ? context.sourceFile : sourceFile);
}

// A name the ambient surface declares is ambient however well the checker resolves it. The surface
// exists so those names can be typed, not so they become bindings this module introduced — a binding
// whose declaration lives outside the module has nowhere to be introduced.
function isTypeScriptAmbientSurfaceSymbol(symbol: ts.Symbol | undefined): boolean {
  return (
    symbol?.declarations?.some(
      (declaration) => declaration.getSourceFile().fileName === getCompilerAmbientSurfaceFileName(),
    ) === true
  );
}

function addTypeScriptBindingTypeEvidence(node: ts.Identifier, type: Readonly<IrType>, context: LoweringContext): void {
  const symbol = context.checker.getSymbolAtLocation(node);
  if (symbol) context.bindingTypes.set(symbol, type);
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
  if (ts.isBindingElement(node)) {
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (ts.isParameter(parent)) return 'function';
      if (ts.isVariableDeclaration(parent)) break;
    }
  }
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
