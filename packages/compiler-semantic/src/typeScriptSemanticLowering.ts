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
  CompilerDiagnosticSeverity,
  CompilerModuleResolutionPlan,
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
  IrDependentCallableParameterPackEvidence,
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
  IrUnionMemberTestEvidence,
  IrTypedArrayReceiver,
  IrValueNameReference,
  IrVariable,
  IrVariableDeclaration,
  TypeScriptLoweringResult,
  CompilerTypeScriptAnalysisIdentity,
  TypeScriptModuleInput,
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
  analysisModuleOptions: ReadonlyMap<string, Readonly<LowerTypeScriptSourceOptions>>;
  bindingTypes: Map<ts.Symbol, IrType>;
  bindings: Map<ts.Symbol, IrBindingIdentity>;
  checker: ts.TypeChecker;
  diagnostics: CompilerDiagnostic[];
  imports: IrImport[];
  moduleSourceFile: ts.SourceFile;
  options: Readonly<LowerTypeScriptSourceOptions>;
  origins: WeakMap<ts.Node, CompilerSourceOrigin>;
  returnTargetTypes: IrType[];
  returnTypes: IrType[];
  sourceFile: ts.SourceFile;
  symbolReferenceStatements: () => ReadonlyMap<ts.Symbol, ReadonlySet<ts.Statement>>;
  typeBindings: Map<ts.Symbol, IrTypeBindingIdentity>;
}

interface TypeScriptAnalysis {
  checker: ts.TypeChecker;
  sourceFiles: readonly ts.SourceFile[];
  symbolReferenceStatements: () => ReadonlyMap<ts.Symbol, ReadonlySet<ts.Statement>>;
}

interface TypeScriptAnalysisModuleRecord {
  readonly fileName: string;
  readonly packageName: string;
  readonly source: string;
}

interface TypeScriptAnalysisModuleResolutionIndex {
  readonly defaultTargetsBySpecifier: ReadonlyMap<string, readonly TypeScriptAnalysisModuleRecord[]>;
  readonly exactTargetsByRequest: ReadonlyMap<string, readonly TypeScriptAnalysisModuleRecord[]>;
  readonly modulesByFileName: ReadonlyMap<string, TypeScriptAnalysisModuleRecord>;
}

interface UnsupportedSyntaxFailure extends Error {
  kind: 'unsupported-syntax';
  node: ts.Node;
}

type TypeScriptBinaryOperator = Exclude<ts.BinaryOperator, ts.AssignmentOperator>;

export function createCompilerTypeScriptAnalysisIdentity(): CompilerTypeScriptAnalysisIdentity {
  return {
    checkerMode: 'package-graph-program',
    compilerOptions: {
      module: 'ESNext',
      moduleResolution: 'compiler-graph-with-typescript-fallback',
      noImplicitAny: true,
      standardLibrary: 'typescript-bundled',
      strictNullChecks: true,
      target: 'ESNext',
    },
    schema: 'flight-compiler-typescript-analysis/1',
    typescriptVersion: ts.version,
  };
}

export function lowerTypeScriptSource(
  sourceFile: ts.SourceFile,
  options: Readonly<LowerTypeScriptSourceOptions>,
): TypeScriptLoweringResult {
  const analysis = createTypeScriptAnalysis(
    [{ ...options, sourceFile }],
    compilerEmptyModuleResolutionPlan,
    'isolated',
  );
  return lowerTypeScriptSourceWithAnalysis(
    analysis.sourceFiles[0]!,
    options,
    analysis.checker,
    new Map([[sourceFile.fileName, options]]),
    analysis.symbolReferenceStatements,
  );
}

export function lowerTypeScriptSources(
  sources: readonly Readonly<TypeScriptModuleInput>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> = compilerEmptyModuleResolutionPlan,
): readonly TypeScriptLoweringResult[] {
  const analysis = createTypeScriptAnalysis(sources, moduleResolution, 'project');
  const analysisModuleOptions = new Map(
    sources.map(({ packageName, sourceFile, upstreamDirectory }) => [
      sourceFile.fileName,
      { packageName, upstreamDirectory },
    ]),
  );
  return sources.map((source, index) =>
    lowerTypeScriptSourceWithAnalysis(
      analysis.sourceFiles[index]!,
      source,
      analysis.checker,
      analysisModuleOptions,
      analysis.symbolReferenceStatements,
    ),
  );
}

function lowerTypeScriptSourceWithAnalysis(
  sourceFile: ts.SourceFile,
  options: Readonly<LowerTypeScriptSourceOptions>,
  checker: ts.TypeChecker,
  analysisModuleOptions: ReadonlyMap<string, Readonly<LowerTypeScriptSourceOptions>>,
  symbolReferenceStatements: () => ReadonlyMap<ts.Symbol, ReadonlySet<ts.Statement>>,
): TypeScriptLoweringResult {
  const context: LoweringContext = {
    analysisModuleOptions,
    bindingTypes: new Map(),
    bindings: new Map(),
    checker,
    diagnostics: [],
    imports: [],
    moduleSourceFile: sourceFile,
    options,
    origins: new WeakMap(),
    returnTargetTypes: [],
    returnTypes: [],
    sourceFile,
    symbolReferenceStatements,
    typeBindings: new Map(),
  };
  context.imports.push(...lowerImports(context.sourceFile, context));
  seedTypeScriptModuleVariableBindingTypeEvidence(context.sourceFile, context);
  const declarations: IrDeclaration[] = [];
  const exports: IrExport[] = [];
  const pendingOverloads = new Map<string, IrFunctionSignature[]>();

  for (const statement of context.sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      continue;
    }
    const topLevelAwait = getTypeScriptModuleInitializationAwait(statement);
    if (topLevelAwait) {
      context.diagnostics.push(
        diagnostic(topLevelAwait, 'top-level await requires asynchronous module evaluation', context),
      );
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
        const declaration = lowerFunction(statement, pendingOverloads.get(name) ?? [], context);
        declarations.push(declaration);
        exports.push(
          ...createTypeScriptDeclarationExports(declaration, hasModifier(statement, ts.SyntaxKind.DefaultKeyword)),
        );
        pendingOverloads.delete(name);
      } else if (ts.isVariableStatement(statement)) {
        if (
          isErasableTypeScriptUniqueSymbolDeclaration(statement) ||
          hasModifier(statement, ts.SyntaxKind.DeclareKeyword)
        ) {
          continue;
        }
        const lowered = lowerVariableStatement(statement, context);
        declarations.push(...lowered);
        exports.push(...lowered.flatMap((declaration) => createTypeScriptDeclarationExports(declaration, false)));
      } else if (ts.isTypeAliasDeclaration(statement)) {
        if (isErasableTypeScriptConditionalFacetHelper(statement, context)) continue;
        const declaration = lowerTypeAlias(statement, context);
        declarations.push(declaration);
        exports.push(...createTypeScriptDeclarationExports(declaration, false));
      } else if (ts.isInterfaceDeclaration(statement)) {
        const declaration = lowerInterface(statement, context);
        declarations.push(declaration);
        exports.push(...createTypeScriptDeclarationExports(declaration, false));
      } else if (ts.isEnumDeclaration(statement)) {
        const declaration = lowerEnum(statement, context);
        declarations.push(declaration);
        exports.push(...createTypeScriptDeclarationExports(declaration, false));
      } else if (ts.isClassDeclaration(statement)) {
        const declaration = lowerClass(statement, context);
        declarations.push(declaration);
        exports.push(
          ...createTypeScriptDeclarationExports(declaration, hasModifier(statement, ts.SyntaxKind.DefaultKeyword)),
        );
      } else if (isTypeScriptModuleInitializationStatement(statement)) {
        declarations.push(lowerTypeScriptModuleSideEffect(statement, context));
      } else if (ts.isModuleDeclaration(statement)) {
        if (hasValueNamespaceMembers(statement)) {
          declarations.push(...lowerMergedEnumValueNamespace(statement, context));
        }
      } else if (!ts.isEmptyStatement(statement)) {
        unsupported(statement, `unsupported top-level ${ts.SyntaxKind[statement.kind]}`);
      }
    } catch (error) {
      if (!isUnsupportedSyntaxFailure(error)) throw error;
      const severity =
        ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) ? 'warning' : 'error';
      context.diagnostics.push(diagnostic(error.node, error.message, context, severity));
      if (ts.isTypeAliasDeclaration(statement) && isTypeAliasReferencedOutsideDeclaration(statement, context)) {
        const declaration = lowerOpaqueTypeAlias(statement, context);
        declarations.push(declaration);
        exports.push(...createTypeScriptDeclarationExports(declaration, false));
      }
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
      imports: context.imports,
      name: moduleNameFromSource(context.sourceFile.fileName),
      packageName: options.packageName,
      source: relativeSource(sourceFile.fileName, options.upstreamDirectory),
    },
  };
}

// Functions are lowered before module variables which appear below them in source, but TypeScript's
// lexical scope makes those variables visible throughout the module. Seed their authored types before
// walking declarations so flow-narrowed references in lazy getters retain the same declared-vs-flow
// evidence as a local declared above its use. Unsupported variable types remain owned by the ordinary
// declaration lowering path, which will report the source diagnostic at its authored location.
function seedTypeScriptModuleVariableBindingTypeEvidence(sourceFile: ts.SourceFile, context: LoweringContext): void {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.type) continue;
      try {
        addTypeScriptBindingTypeEvidence(
          declaration.name,
          lowerTypeScriptTypeNodeEvidence(declaration.type, context),
          context,
        );
      } catch (error) {
        if (!isUnsupportedSyntaxFailure(error)) throw error;
      }
    }
  }
}

function isTypeScriptModuleInitializationStatement(statement: ts.Statement): boolean {
  return (
    ts.isBlock(statement) ||
    ts.isDoStatement(statement) ||
    ts.isExpressionStatement(statement) ||
    ts.isForInStatement(statement) ||
    ts.isForOfStatement(statement) ||
    ts.isForStatement(statement) ||
    ts.isIfStatement(statement) ||
    ts.isLabeledStatement(statement) ||
    ts.isSwitchStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isTryStatement(statement) ||
    ts.isWhileStatement(statement)
  );
}

// A target module has declarations rather than free-standing statements. Carry a source module's
// ordered executable statement through the same initialization lane as an unexported const, and
// make the initializer produce a value so targets never have to declare storage with a void type.
function lowerTypeScriptModuleSideEffect(statement: ts.Statement, context: LoweringContext): IrVariableDeclaration {
  const topLevelAwait = getTypeScriptModuleInitializationAwait(statement);
  if (topLevelAwait) unsupported(topLevelAwait, 'top-level await requires asynchronous module evaluation');
  const escapingVariable = getTypeScriptModuleInitializationVar(statement);
  if (escapingVariable) {
    unsupported(escapingVariable, 'top-level nested var requires module-scope declaration hoisting');
  }
  const sourceOrigin = origin(statement, context);
  const type = { kind: 'primitive', name: 'boolean' } as const;
  return {
    binding: {
      ...sourceOrigin,
      id: `binding:${JSON.stringify([
        sourceOrigin.packageName,
        sourceOrigin.source,
        'module-side-effect',
        statement.getStart(context.sourceFile),
      ])}`,
      kind: 'variable',
      name: 'moduleSideEffect',
      scope: 'module',
      space: 'value',
    },
    declarationKind: 'const',
    exported: false,
    initializer: {
      arguments: [],
      callee: {
        async: false,
        body: [lowerStatement(statement, context), { expression: { kind: 'literal', value: true }, kind: 'return' }],
        kind: 'function',
        parameters: [],
        returns: type,
        thisMode: 'lexical',
        typeParameters: [],
      },
      kind: 'call',
      optional: false,
      semantics: { resultType: type, statementValue: createIrStatementValueCallSemantics() },
      typeArguments: [],
    },
    kind: 'variable',
    mutable: false,
    origin: sourceOrigin,
    type,
  };
}

function getTypeScriptModuleInitializationAwait(
  statement: ts.Statement,
): ts.AwaitExpression | ts.ForOfStatement | undefined {
  let found: ts.AwaitExpression | ts.ForOfStatement | undefined;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node)) return;
    if (ts.isPropertyDeclaration(node) && !hasModifier(node, ts.SyntaxKind.StaticKeyword)) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name.expression);
      return;
    }
    if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return found;
}

function getTypeScriptModuleInitializationVar(statement: ts.Statement): ts.VariableDeclarationList | undefined {
  let found: ts.VariableDeclarationList | undefined;
  const visit = (node: ts.Node): void => {
    if (found || (node !== statement && ts.isFunctionLike(node))) return;
    if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return found;
}

function isErasableTypeScriptUniqueSymbolDeclaration(node: ts.VariableStatement): boolean {
  return (
    !isExported(node) &&
    hasModifier(node, ts.SyntaxKind.DeclareKeyword) &&
    node.declarationList.declarations.length > 0 &&
    node.declarationList.declarations.every(
      (declaration) =>
        declaration.initializer === undefined &&
        declaration.type !== undefined &&
        ts.isTypeOperatorNode(declaration.type) &&
        declaration.type.operator === ts.SyntaxKind.UniqueKeyword,
    )
  );
}

function diagnostic(
  node: ts.Node,
  message: string,
  context: LoweringContext,
  severity: CompilerDiagnosticSeverity = 'error',
): CompilerDiagnostic {
  const start = node.getStart(context.sourceFile);
  const position = context.sourceFile.getLineAndCharacterOfPosition(start);
  return {
    code: 'unsupported-typescript',
    column: position.character + 1,
    line: position.line + 1,
    message,
    packageName: context.options.packageName,
    severity,
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
    const name = tryPropertyName(method.name);
    if (name === undefined) continue;
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
      const name = tryPropertyName(member.name);
      if (name === undefined) continue;
      const isBranded = ts.isPrivateIdentifier(member.name);
      const isAbstract = hasModifier(member, ts.SyntaxKind.AbstractKeyword);
      const isDeclare = hasModifier(member, ts.SyntaxKind.DeclareKeyword);
      if (!member.type && !member.initializer) unsupported(member, 'class fields require a type or initializer');
      const type = member.type ? lowerType(member.type, context) : inferInitializerType(member.initializer!, context);
      const key = `${hasModifier(member, ts.SyntaxKind.StaticKeyword) ? 'static' : 'instance'}:${name}`;
      if (fieldSlots.has(key) || methodGroups.has(key)) {
        unsupported(member, `class runtime member ${name} has conflicting field and method storage`);
      }
      fieldSlots.add(key);
      fields.push({
        ...(isAbstract ? { abstract: true } : {}),
        ...(isBranded ? { branded: true } : {}),
        ...(isDeclare ? { declare: true } : {}),
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
      const name = tryPropertyName(member.name);
      if (name === undefined) continue;
      if (!member.body && !hasModifier(member, ts.SyntaxKind.AbstractKeyword)) continue;
      const accessor = ts.isGetAccessor(member)
        ? ({ accessor: 'get' } as const)
        : ts.isSetAccessor(member)
          ? ({ accessor: 'set' } as const)
          : {};
      const signature = lowerFunctionSignature(member, context);
      const parameterEntries = lowerParameterBindingEntries(member.parameters, signature.parameters, context);
      const key = `${hasModifier(member, ts.SyntaxKind.StaticKeyword) ? 'static' : 'instance'}:${name}`;
      const overloads = (methodGroups.get(key) ?? [])
        .filter((candidate) => candidate !== member)
        .map((candidate) => lowerFunctionSignature(candidate, context));
      const isBrandedMethod = ts.isMethodDeclaration(member) && ts.isPrivateIdentifier(member.name);
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
        ...(isBrandedMethod ? { branded: true } : {}),
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

function lowerMergedEnumValueNamespace(
  node: ts.ModuleDeclaration,
  context: LoweringContext,
): readonly IrFunctionDeclaration[] {
  if (!ts.isIdentifier(node.name) || !node.body || !ts.isModuleBlock(node.body)) {
    unsupported(node, 'value namespace declarations require a direct identifier namespace body');
  }
  const symbol = context.checker.getSymbolAtLocation(node.name);
  if (!symbol?.declarations?.some(ts.isEnumDeclaration)) {
    unsupported(node, 'value namespace declarations require neutral IR namespace representation');
  }
  const root = lowerBindingSymbol(symbol, node.name, context);
  const declarations: IrFunctionDeclaration[] = [];
  const pendingOverloads = new Map<string, IrFunctionSignature[]>();
  for (const statement of node.body.statements) {
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly)
    ) {
      continue;
    }
    if (!ts.isFunctionDeclaration(statement)) {
      unsupported(statement, `enum value namespace member ${ts.SyntaxKind[statement.kind]} requires neutral lowering`);
    }
    const name = requiredDeclarationName(statement, context);
    if (!statement.body) {
      const overloads = pendingOverloads.get(name) ?? [];
      overloads.push(lowerFunctionSignature(statement, context));
      pendingOverloads.set(name, overloads);
      continue;
    }
    declarations.push({
      ...lowerFunction(statement, pendingOverloads.get(name) ?? [], context),
      exported: false,
      namespaceMember: { binding: root, kind: 'binding', path: [name] },
    });
    pendingOverloads.delete(name);
  }
  for (const [name, overloads] of pendingOverloads) {
    unsupported(
      node,
      `namespace function overload ${name} has no implementation (${String(overloads.length)} signature(s))`,
    );
  }
  return declarations;
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

function createTypeScriptDeclarationExports(
  declaration: Readonly<IrDeclaration>,
  defaultExport: boolean,
): readonly IrExport[] {
  if (!declaration.exported) return [];
  if (defaultExport) {
    if (declaration.kind !== 'class' && declaration.kind !== 'function') return [];
    return [{ binding: declaration.binding, exported: 'default', kind: 'local', typeOnly: false }];
  }
  if (declaration.kind === 'variable') {
    const bindings =
      'binding' in declaration ? [declaration.binding] : collectTypeScriptBindingPatternBindings(declaration.pattern);
    return bindings.map((binding) => ({ binding, exported: binding.name, kind: 'local', typeOnly: false }));
  }
  if (declaration.kind === 'interface' || declaration.kind === 'typeAlias') {
    return [{ binding: declaration.binding, exported: declaration.binding.name, kind: 'local', typeOnly: true }];
  }
  return [{ binding: declaration.binding, exported: declaration.binding.name, kind: 'local', typeOnly: false }];
}

function collectTypeScriptBindingPatternBindings(pattern: Readonly<IrBindingPattern>): readonly IrBindingIdentity[] {
  if (pattern.kind === 'binding') return [pattern.binding];
  const nested =
    pattern.kind === 'array'
      ? pattern.elements.flatMap((element) => (element ? collectTypeScriptBindingPatternBindings(element.pattern) : []))
      : pattern.properties.flatMap((property) => collectTypeScriptBindingPatternBindings(property.pattern));
  return pattern.rest ? [...nested, ...collectTypeScriptBindingPatternBindings(pattern.rest)] : nested;
}

function lowerExpression(
  node: ts.Expression,
  context: LoweringContext,
  contextualType?: Readonly<IrType>,
  contextualTargetType?: Readonly<IrType>,
  constructionAssertion = false,
): IrExpression {
  if (ts.isParenthesizedExpression(node))
    return lowerExpression(node.expression, context, contextualType, contextualTargetType, constructionAssertion);
  if (isTypeScriptConstAssertion(node)) {
    return lowerExpression(node.expression, context, contextualType, contextualTargetType, constructionAssertion);
  }
  if (ts.isSatisfiesExpression(node)) {
    const type = lowerType(node.type, context);
    return lowerExpression(node.expression, context, type, type);
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    const type = lowerType(node.type, context);
    return {
      expression: lowerExpression(node.expression, context, type, contextualTargetType ?? contextualType ?? type, true),
      kind: 'cast',
      type,
    };
  }
  if (ts.isNonNullExpression(node)) {
    return markIrExpressionPresent(
      lowerExpression(node.expression, context, contextualType, contextualTargetType, constructionAssertion),
    );
  }
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
    const writtenContextualShape =
      contextualType?.kind === 'union' ? getIrTypeConstructionTargetShape(contextualType, context) : contextualType;
    const checkedContextualType = context.checker.getContextualType(node);
    const checkedContextualEvidence = checkedContextualType
      ? getTypeScriptCheckerTypeEvidence(checkedContextualType, context, 0, true, node)
      : undefined;
    const contextualShape =
      writtenContextualShape ??
      (checkedContextualEvidence?.kind === 'union'
        ? getIrTypeConstructionTargetShape(checkedContextualEvidence, context)
        : checkedContextualEvidence);
    if (contextualShape?.kind === 'tuple') {
      return lowerTupleExpression(
        node,
        contextualShape,
        targetShape?.kind === 'tuple' ? targetShape : contextualShape,
        context,
      );
    }
    const constructionShape = targetShape?.kind === 'array' ? targetShape : contextualShape;
    const constructionType =
      constructionShape?.kind === 'array' && isIrExpressionValueTypeEvidence(constructionShape)
        ? constructionShape
        : undefined;
    return {
      elements: node.elements.map((element) =>
        ts.isOmittedExpression(element)
          ? undefined
          : lowerExpression(
              element,
              context,
              contextualShape?.kind === 'array' ? contextualShape.element : undefined,
              targetShape?.kind === 'array' ? targetShape.element : undefined,
            ),
      ),
      kind: 'array',
      ...(constructionType ? { type: constructionType } : {}),
    };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const inferredType = inferInitializerType(node, context);
    const memberContext = contextualType?.kind === 'object' ? contextualType : inferredType;
    // An assertion explicitly opts out of structural construction checking. Preserve contextual
    // member typing for callbacks, but do not let the asserted target leak back into a nested object
    // literal and manufacture missing-property errors underneath `as unknown as Target`.
    const memberTarget = constructionAssertion
      ? inferredType
      : getIrTypeConstructionTargetShape(contextualTargetType ?? contextualType, context);
    const members = node.properties.map((member) =>
      lowerObjectMember(member, context, memberContext, memberTarget ?? memberContext),
    );
    // An unknown contextual type is not evidence about what is being built, so it does not outrank
    // the shape the literal itself states. The position a literal is passed to often knows nothing —
    // an ambient signature's own type parameter means nothing here — and treating that as a target
    // leaves the construction with no shape at all.
    const contextualEvidence = constructionAssertion
      ? undefined
      : ([contextualTargetType, contextualType].find(
          (candidate) => candidate !== undefined && candidate.kind !== 'unknown',
        ) ??
        // The position may still know what is being built even where no written type says so: a
        // parameter declared in the ambient surface is written in the surface's own type parameters,
        // and only the checker's instantiation of them names the module's type. A spread operand is
        // only a partial contribution to its outer target, so the outer context must not turn that
        // partial literal into a supposedly complete construction on its own.
        (() => {
          if (isTypeScriptObjectLiteralWithinSpreadOperand(node)) return undefined;
          const contextual = context.checker.getContextualType(node);
          return contextual ? getTypeScriptCheckerTypeEvidence(contextual, context, 0) : undefined;
        })());
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
    const candidateType = getTypeScriptExpressionBindingTypeEvidence(node, context);
    const type = candidateType && isIrExpressionValueTypeEvidence(candidateType) ? candidateType : undefined;
    const resolved =
      getIrResolvedMemberReceiver(receiver) ??
      getIrResolvedMemberReceiver(getIrTypeConstructionTargetShape(receiver, context)) ??
      getIrResolvedMemberReceiverFromNarrowedFlow(node.expression, context) ??
      getIrResolvedMemberReceiver(
        getTypeScriptCheckerTypeEvidence(context.checker.getTypeAtLocation(node.expression), context, 0, false, node),
      );
    const member = resolved ? { member: { name: node.name.text, receiver: resolved } } : {};
    const absent = isTypeScriptOptionalMemberAccess(node, context) ? ({ absent: 'optionalMember' } as const) : {};
    return {
      kind: 'property',
      ...absent,
      ...member,
      ...getTypeScriptAccessPresence(node, context),
      ...getTypeScriptNarrowedStructuralPropertyAccess(node, context),
      ...getTypeScriptValueNamespaceMemberReference(node, context),
      name: node.name.text,
      object: lowerExpression(node.expression, context),
      optional,
      ...(type ? { type } : {}),
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
      ...getTypeScriptAccessPresence(node, context),
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
      semantics: {
        ...lowerInvocationSemantics(node, signature, context),
        ...(signature?.resolved &&
        ts.isConstructSignatureDeclaration(signature.resolved) &&
        signature.resolved.getSourceFile().fileName !== getCompilerAmbientSurfaceFileName()
          ? { construction: 'factory' as const }
          : {}),
      },
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
        right: lowerExpression(
          node.right,
          context,
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ? getTypeScriptExpressionBindingTypeEvidence(node.left, context)
            : undefined,
        ),
        semantics: lowerAssignmentOperatorSemantics(node, context),
      };
    }
    return {
      kind: 'binary',
      left: lowerExpression(node.left, context, undefined, undefined, constructionAssertion),
      operator: lowerBinaryOperator(node.operatorToken.kind),
      right: lowerExpression(node.right, context, undefined, undefined, constructionAssertion),
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
      whenFalse: lowerExpression(node.whenFalse, context, contextualType, contextualTargetType, constructionAssertion),
      whenTrue: lowerExpression(node.whenTrue, context, contextualType, contextualTargetType, constructionAssertion),
    };
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const signature = lowerContextualDependentCallableImplementationPack(
      lowerFunctionSignature(node, context),
      contextualTargetType,
      context,
    );
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

// Expression result evidence is classification metadata, not a second declaration site. Retain the
// closed type forms whose traversal can only reference existing bindings. Function/object shapes can
// introduce generic binders, while arbitrary library ambient names can be checker-local parameters;
// replaying either at every property access would manufacture duplicate declarations or runtime ABI
// requirements. Calls and declared storage continue to carry their full authoritative types.
function isIrExpressionValueTypeEvidence(type: Readonly<IrType>): boolean {
  switch (type.kind) {
    case 'array':
      return isIrExpressionValueTypeEvidence(type.element);
    case 'intersection':
    case 'union':
      return type.types.every(isIrExpressionValueTypeEvidence);
    case 'tuple':
      return type.elements.every((element) => isIrExpressionValueTypeEvidence(element.type));
    case 'named':
      return (
        (type.reference.kind === 'binding' || getIrResolvedMemberReceiver(type) !== undefined) &&
        type.typeArguments.every(isIrExpressionValueTypeEvidence)
      );
    case 'function':
      return (
        type.typeParameters.length === 0 &&
        type.parameters.every((parameter) => isIrExpressionValueTypeEvidence(parameter.type)) &&
        isIrExpressionValueTypeEvidence(type.returns)
      );
    case 'object':
      return type.properties.every(
        (property) =>
          property.computedKey?.kind !== 'ambient' && isIrExpressionValueTypeEvidence(property.type),
      );
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
    case 'undefined':
    case 'unknown':
      return true;
    case 'conditionalFacet':
    case 'indexedAccess':
    case 'keyof':
    case 'typeOf':
      return false;
  }
}

function markIrExpressionPresent(expression: IrExpression): IrExpression {
  return (expression.kind === 'identifier' && expression.reference.kind === 'binding') ||
    expression.kind === 'call' ||
    expression.kind === 'property' ||
    expression.kind === 'element'
    ? { ...expression, presence: 'narrowedPresent' }
    : expression;
}

function isTypeScriptObjectLiteralWithinSpreadOperand(node: ts.ObjectLiteralExpression): boolean {
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    if (ts.isSpreadAssignment(current.parent)) return true;
    if (ts.isObjectLiteralExpression(current.parent) || ts.isStatement(current.parent)) return false;
  }
  return false;
}

function lowerContextualDependentCallableImplementationPack(
  signature: Readonly<IrFunctionSignature>,
  contextualTargetType: Readonly<IrType> | undefined,
  context: LoweringContext,
): IrFunctionSignature {
  if (
    !contextualTargetType ||
    signature.parameters.length !== 1 ||
    !signature.parameters[0]?.rest ||
    signature.parameters[0].type.kind !== 'array' ||
    signature.parameters[0].type.element.kind !== 'unknown' ||
    signature.parameters[0].type.element.source !== 'any'
  ) {
    return signature;
  }
  const evidence = lowerDependentCallableTypeParameterEvidence(contextualTargetType, 'implementation', context);
  if (!evidence) return signature;
  return { ...signature, parameters: [{ ...signature.parameters[0], dependentCallablePack: evidence }] };
}

function lowerTypeScriptInvocationArguments(
  node: ts.CallExpression | ts.NewExpression,
  signature: Readonly<TypeScriptInvocationSignatureResolution> | undefined,
  context: LoweringContext,
): IrExpression[] {
  const parameters = signature?.resolved.parameters.filter(ts.isParameter) ?? [];
  return (node.arguments ?? []).map((argument, index) => {
    if (ts.isSpreadElement(argument)) return lowerExpression(argument, context);
    const trailing = parameters.at(-1);
    const parameter = parameters[index] ?? (trailing?.dotDotDotToken ? trailing : undefined);
    if (!parameter) return lowerExpression(argument, context);
    const declaredType = lowerFunctionTypeParameter(parameter, context).type;
    const type =
      parameter.type && hasExternalTypeScriptTypeParameter(parameter.type, context)
        ? (getTypeScriptInstantiatedInvocationParameterType(node, index, argument, context) ??
          inferInitializerType(argument, context))
        : declaredType;
    const contextualType =
      parameter.questionToken || parameter.initializer ? addIrTypeBindingPatternUndefined(type) : type;
    return lowerExpression(argument, context, contextualType);
  });
}

function getTypeScriptInstantiatedInvocationParameterType(
  node: ts.CallExpression | ts.NewExpression,
  index: number,
  argument: ts.Expression,
  context: LoweringContext,
): IrType | undefined {
  const signature = context.checker.getResolvedSignature(node);
  const signatureParameters = signature?.getParameters() ?? [];
  const declarationParameters = signature?.declaration?.parameters.filter(ts.isParameter) ?? [];
  const restIndex = declarationParameters.findIndex((parameter) => parameter.dotDotDotToken !== undefined);
  const parameterIndex = restIndex >= 0 && index >= restIndex ? restIndex : index;
  const parameter = signatureParameters[parameterIndex];
  if (!parameter) return undefined;
  let type = context.checker.getTypeOfSymbolAtLocation(parameter, argument);
  if (restIndex >= 0 && index >= restIndex) {
    if (context.checker.isTupleType(type)) {
      const tupleElements = context.checker.getTypeArguments(type as ts.TypeReference);
      const element = tupleElements[index - restIndex];
      if (!element) return undefined;
      type = element;
    } else if (context.checker.isArrayType(type)) {
      const element = context.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      if (!element) return undefined;
      type = element;
    }
  }
  // Contextual return inference can leave a resolved signature's parameter as the callee's raw type
  // parameter. That binding is not in scope at the call site; the argument's own initializer evidence
  // is the only local proof available to the caller.
  if (type.flags & ts.TypeFlags.TypeParameter) return undefined;
  const evidence = getTypeScriptCheckerTypeEvidence(type, context, 0, true);
  if (!evidence || evidence.kind === 'unknown') return undefined;
  return refineTypeScriptInvocationParameterEvidence(evidence, inferInitializerType(argument, context));
}

function refineTypeScriptInvocationParameterEvidence(parameter: Readonly<IrType>, argument: Readonly<IrType>): IrType {
  if (parameter.kind === 'union' && argument.kind === 'function') {
    const callableIndices = parameter.types.flatMap((member, index) => (member.kind === 'function' ? [index] : []));
    if (callableIndices.length !== 1) return parameter;
    const index = callableIndices[0]!;
    const types = [...parameter.types];
    types[index] = refineTypeScriptInvocationParameterEvidence(types[index]!, argument);
    return { kind: 'union', types: [types[0]!, types[1]!, ...types.slice(2)] };
  }
  if (
    parameter.kind !== 'function' ||
    argument.kind !== 'function' ||
    parameter.parameters.length !== argument.parameters.length
  ) {
    return parameter;
  }
  return {
    ...parameter,
    parameters: parameter.parameters.map((value, index) => ({
      ...value,
      type:
        value.type.kind === 'unknown' && value.type.source === 'any' ? argument.parameters[index]!.type : value.type,
    })),
    returns:
      parameter.returns.kind === 'unknown' && parameter.returns.source === 'any' ? argument.returns : parameter.returns,
  };
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
    receiverNullish: hasIrTypeAbsentMemberSemantic(receiverType)
      ? 'possible'
      : getTypeScriptOptionalChainReceiverNullish(receiver, context),
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
  if (binding) {
    const resolved = resolveTypeScriptExpressionPropertyTypeEvidence(binding, context);
    const checkerType = context.checker.getTypeAtLocation(expression);
    const absent = checkerType.isUnion()
      ? checkerType.types.filter((member) => member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))
      : [];
    const absentEvidence = absent.flatMap((member): IrType[] => {
      if (member.flags & ts.TypeFlags.Null) return [{ kind: 'null' }];
      if (member.flags & ts.TypeFlags.Undefined) return [{ kind: 'undefined' }];
      return [];
    });
    if (
      absentEvidence.length === 0 &&
      getTypeScriptOptionalChainReceiverNullish(expression, context) === 'possible' &&
      (resolved.kind === 'array' ||
        resolved.kind === 'function' ||
        resolved.kind === 'literal' ||
        resolved.kind === 'never' ||
        resolved.kind === 'object' ||
        resolved.kind === 'primitive' ||
        resolved.kind === 'tuple')
    ) {
      absentEvidence.push({ kind: 'undefined' });
    }
    if (absentEvidence.length === 0) return resolved;
    const present = resolved.kind === 'union' ? resolved.types : [resolved];
    return commonType([present[0]!, ...present.slice(1), ...absentEvidence]);
  }
  const evidence = getTypeScriptSyntacticExpressionTypeEvidence(expression, context.checker);
  return evidence ? lowerType(evidence, context) : { kind: 'unknown', source: 'unknown' };
}

function getTypeScriptOptionalChainValueTypeEvidence(
  expression: ts.Expression,
  receiverType: Readonly<IrType>,
  context: LoweringContext,
): IrType {
  const binding = getTypeScriptExpressionBindingTypeEvidence(expression, context);
  const bindingValue = removeIrTypeBindingPatternUndefined(binding);
  if (bindingValue) return resolveTypeScriptExpressionPropertyTypeEvidence(bindingValue, context);
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
      const bindingType = getTypeScriptExpressionBindingTypeEvidence(value.expression, context);
      const spreadType =
        bindingType?.kind === 'tuple' ? bindingType : lowerTypeScriptExpressionTypeEvidence(value.expression, context);
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
  const reference = lowerExpressionTypeNameReference(node.expression, context);
  if (!reference) {
    return unsupported(
      node,
      `heritage type ${getTypeScriptNodeText(node.expression, context)} has no reachable declaration`,
    );
  }
  return {
    kind: 'named',
    reference,
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
    resultType:
      getTypeScriptKnownAmbientCallResultTypeEvidence(node, context) ??
      getTypeScriptCollectionCallResultTypeEvidence(node, context) ??
      getTypeScriptInstantiatedCallResultTypeEvidence(node, signature, context) ??
      getTypeScriptWrittenCallResultTypeEvidence(signature, context) ??
      getTypeScriptCheckerTypeEvidence(context.checker.getTypeAtLocation(node), context, 0) ??
      inferInitializerType(node, context),
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

function getTypeScriptInstantiatedCallResultTypeEvidence(
  node: ts.CallExpression,
  signature: Readonly<TypeScriptInvocationSignatureResolution> | undefined,
  context: LoweringContext,
): Readonly<IrType> | undefined {
  const result = signature?.resolved.type;
  const source = result?.getSourceFile();
  if (
    !result ||
    source?.fileName === getCompilerAmbientSurfaceFileName() ||
    (source === context.moduleSourceFile &&
      (!ts.isTypeNode(result) || !hasExternalTypeScriptTypeParameter(result, context)))
  ) {
    return undefined;
  }
  let callee: Readonly<IrType> | undefined;
  try {
    callee = removeIrTypeBindingPatternUndefined(getTypeScriptExpressionBindingTypeEvidence(node.expression, context));
  } catch (error) {
    if (!isUnsupportedSyntaxFailure(error)) throw error;
    const instantiated = getTypeScriptCheckerTypeEvidence(
      context.checker.getTypeAtLocation(node),
      context,
      0,
      true,
      node,
    );
    if (instantiated) return instantiated;
    throw error;
  }
  if (callee?.kind === 'function' && callee.typeParameters.length === 0) {
    return (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) &&
      node.expression.questionDotToken
      ? addIrTypeBindingPatternUndefined(callee.returns)
      : callee.returns;
  }
  return getTypeScriptCheckerTypeEvidence(context.checker.getTypeAtLocation(node), context, 0, true, node);
}

// The checker can preserve an uninstantiated standard-library method result instead of the
// receiver's concrete element/value. Recover the result only for collection identities whose
// source contract makes that relationship explicit; lookalike methods do not qualify by spelling.
function getTypeScriptCollectionCallResultTypeEvidence(
  node: ts.CallExpression,
  context: LoweringContext,
): Readonly<IrType> | undefined {
  if (node.arguments.length !== 1 || !ts.isPropertyAccessExpression(node.expression)) {
    return undefined;
  }
  const receiver = removeIrTypeBindingPatternUndefined(
    getTypeScriptExpressionBindingTypeEvidence(node.expression.expression, context),
  );
  if (node.expression.name.text === 'at' && receiver?.kind === 'array') {
    const elements = receiver.element.kind === 'union' ? receiver.element.types : [receiver.element];
    return commonType([{ kind: 'undefined' }, elements[0]!, ...elements.slice(1)]);
  }
  if (
    node.expression.name.text !== 'get' ||
    receiver?.kind !== 'named' ||
    receiver.reference.kind !== 'ambient' ||
    !['Map', 'ReadonlyMap', 'WeakMap'].includes(receiver.reference.name)
  ) {
    return undefined;
  }
  const value = receiver.typeArguments[1];
  if (!value || value.kind === 'unknown') return undefined;
  const values = value.kind === 'union' ? value.types : [value];
  return commonType([{ kind: 'undefined' }, values[0]!, ...values.slice(1)]);
}

function getTypeScriptKnownAmbientCallResultTypeEvidence(
  node: ts.CallExpression,
  context: LoweringContext,
): Readonly<IrType> | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Math') {
    const reference = lowerIdentifierReference(node.expression.expression, context);
    if (reference.kind === 'ambient' && reference.name === 'Math') return { kind: 'primitive', name: 'number' };
  }
  const receiver = getTypeScriptExpressionBindingTypeEvidence(node.expression.expression, context);
  const first = node.arguments[0];
  if (
    receiver?.kind === 'named' &&
    receiver.reference.kind === 'ambient' &&
    receiver.reference.name === 'HTMLCanvasElement' &&
    node.expression.name.text === 'getContext' &&
    first &&
    ts.isStringLiteralLike(first) &&
    first.text === 'webgl2'
  ) {
    return {
      kind: 'union',
      types: [
        { kind: 'named', reference: { kind: 'ambient', name: 'WebGL2RenderingContext' }, typeArguments: [] },
        { kind: 'null' },
      ],
    };
  }
  if (
    receiver?.kind === 'named' &&
    receiver.reference.kind === 'ambient' &&
    receiver.reference.name === 'Document' &&
    node.expression.name.text === 'querySelector' &&
    first &&
    ts.isStringLiteralLike(first) &&
    first.text === 'canvas'
  ) {
    return {
      kind: 'union',
      types: [
        { kind: 'named', reference: { kind: 'ambient', name: 'HTMLCanvasElement' }, typeArguments: [] },
        { kind: 'null' },
      ],
    };
  }
  if (
    receiver?.kind === 'named' &&
    receiver.reference.kind === 'ambient' &&
    receiver.reference.name === 'Document' &&
    node.expression.name.text === 'createElement' &&
    first &&
    ts.isStringLiteralLike(first) &&
    first.text === 'canvas'
  ) {
    return { kind: 'named', reference: { kind: 'ambient', name: 'HTMLCanvasElement' }, typeArguments: [] };
  }
  return undefined;
}

// Prefer an explicit result annotation when it is already concrete. Besides being the source
// contract, it preserves imported aliases that the checker may expand into anonymous structural
// types. A result mentioning a type parameter or `this` still needs checker instantiation.
function getTypeScriptWrittenCallResultTypeEvidence(
  signature: Readonly<TypeScriptInvocationSignatureResolution> | undefined,
  context: LoweringContext,
): Readonly<IrType> | undefined {
  const result = signature?.resolved.type;
  if (!result || !ts.isTypeNode(result) || hasTypeScriptContextualResultReference(result, context.checker)) {
    return undefined;
  }
  return lowerType(result, context);
}

function hasTypeScriptContextualResultReference(node: ts.TypeNode, checker: ts.TypeChecker): boolean {
  if (ts.isThisTypeNode(node)) return true;
  if (ts.isTypeReferenceNode(node)) {
    const unresolved = checker.getSymbolAtLocation(node.typeName);
    const symbol =
      unresolved?.flags && unresolved.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(unresolved) : unresolved;
    if (symbol?.flags && symbol.flags & ts.SymbolFlags.TypeParameter) return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && ts.isTypeNode(child) && hasTypeScriptContextualResultReference(child, checker)) found = true;
  });
  return found;
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
          ? [getTypeScriptParameterProvidedArgumentInvocationSemantics(node, argument, parameter, position, context)]
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
              ? [
                  getTypeScriptParameterProvidedArgumentInvocationSemantics(
                    node,
                    argument,
                    parameter,
                    position,
                    context,
                  ),
                ]
              : [];
          }),
      providedArgumentCount: dynamic ? 'dynamic' : arguments_.length,
    },
  };
}

function getTypeScriptParameterProvidedArgumentInvocationSemantics(
  invocation: ts.CallExpression | ts.NewExpression,
  argument: ts.Expression,
  parameter: ts.ParameterDeclaration,
  position: number,
  context: LoweringContext,
): IrParameterProvidedArgumentInvocationSemantics {
  const parameterType =
    parameter.type && hasExternalTypeScriptTypeParameter(parameter.type, context)
      ? (getTypeScriptInstantiatedInvocationParameterType(invocation, position, argument, context) ??
        inferInitializerType(argument, context))
      : lowerFunctionTypeParameter(parameter, context).type;
  return {
    argumentType: lowerTypeScriptExpressionTypeEvidence(argument, context) ?? inferInitializerType(argument, context),
    parameterType,
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

function lowerExpressionTypeNameReference(
  expression: ts.Expression,
  context: LoweringContext,
): IrTypeNameReference | undefined {
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
    returns: node.type ? lowerType(node.type, context) : inferTypeScriptFunctionReturnType(node, context),
    typeParameters: lowerTypeParameters(node.typeParameters, context),
  };
}

function inferTypeScriptFunctionReturnType(node: ts.SignatureDeclaration, context: LoweringContext): IrType {
  const signature = context.checker.getSignatureFromDeclaration(node);
  const evidence = signature
    ? getTypeScriptCheckerTypeEvidence(context.checker.getReturnTypeOfSignature(signature), context, 0, true, node)
    : undefined;
  return evidence ?? { kind: 'unknown', source: 'any' };
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
    returns: node.type ? lowerType(node.type, context) : inferTypeScriptFunctionReturnType(node, context),
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
  const ownProperties = lowerTypeProperties(node.members, context);
  const properties: IrObjectTypeProperty[] = [];
  for (const clause of node.heritageClauses ?? []) {
    for (const heritage of clause.types) {
      const materialized =
        lowerTypeScriptClosedAmbientPickHeritageProperties(heritage, context) ??
        (ts.isIdentifier(heritage.expression) && heritage.expression.text === 'ReturnType'
          ? lowerTypeScriptUnresolvedUtilityHeritageProperties(heritage, context, new Set(), new Map())
          : undefined);
      for (const property of materialized ?? []) {
        if (!properties.some((candidate) => candidate.name === property.name)) properties.push(property);
      }
    }
  }
  for (const property of ownProperties) {
    const inherited = properties.findIndex((candidate) => candidate.name === property.name);
    if (inherited < 0) properties.push(property);
    else properties[inherited] = property;
  }
  return {
    binding: lowerTypeBindingIdentity(node.name, context),
    exported: isExported(node),
    extends:
      node.heritageClauses?.flatMap((clause) =>
        clause.types.map((type) => lowerExpressionWithTypeArguments(type, context)),
      ) ?? [],
    kind: 'interface',
    origin: origin(node, context),
    properties,
    typeParameters: lowerTypeParameters(node.typeParameters, context),
  };
}

// A deliberately unresolved ambient Pick still proves a finite structural surface when its target
// is an ambient host type and the checker resolves every selected key to a string literal. Retain
// the heritage edge for target-specific host widening, but carry those properties in neutral IR so
// a target which cannot bind the host interface can flatten only after explicitly accepting them.
function lowerTypeScriptClosedAmbientPickHeritageProperties(
  heritage: ts.ExpressionWithTypeArguments,
  context: LoweringContext,
): readonly IrObjectTypeProperty[] | undefined {
  const utility = context.checker.getSymbolAtLocation(heritage.expression);
  if (
    !ts.isIdentifier(heritage.expression) ||
    heritage.expression.text !== 'Pick' ||
    (utility !== undefined && !isTypeScriptAmbientSymbol(utility, context)) ||
    heritage.typeArguments?.length !== 2
  ) {
    return undefined;
  }
  const target = lowerType(heritage.typeArguments[0]!, context);
  if (target.kind !== 'named' || target.reference.kind !== 'ambient') return undefined;
  const keys = getTypeScriptCheckerStringLiteralTypeValues(heritage.typeArguments[1]!, context);
  if (!keys) return undefined;
  return keys.map((name) => ({
    name,
    optional: false,
    readonly: false,
    type: { kind: 'unknown', source: 'any' },
  }));
}

function getIrTypeConstructionTargetShape(
  type: Readonly<IrType> | undefined,
  context: LoweringContext,
  seen: ReadonlySet<string> = new Set(),
): IrType | undefined {
  if (
    type?.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    type.reference.name === 'Omit' &&
    type.typeArguments.length === 2 &&
    type.typeArguments[0] &&
    type.typeArguments[1]
  ) {
    const inner = getIrTypeConstructionTargetShape(type.typeArguments[0], context, seen);
    const keys = getIrTypeObjectProjectionKeys(type.typeArguments[1]);
    if (inner?.kind !== 'object' || !keys) return type;
    return {
      ...inner,
      properties: inner.properties.filter((property) => !keys.has(property.name)),
    };
  }
  if (
    type?.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    type.reference.name === 'Partial' &&
    type.typeArguments.length === 1 &&
    type.typeArguments[0]
  ) {
    const inner = getIrTypeConstructionTargetShape(type.typeArguments[0], context, seen);
    return inner?.kind === 'object'
      ? {
          ...inner,
          properties: inner.properties.map((property) => ({
            ...property,
            optional: true,
          })),
        }
      : type;
  }
  if (
    type?.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    (type.reference.name === 'Readonly' || type.reference.name === 'Required') &&
    type.typeArguments.length === 1 &&
    type.typeArguments[0]
  ) {
    return getIrTypeConstructionTargetShape(type.typeArguments[0], context, seen);
  }
  if (type?.kind === 'union') {
    const inhabited = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
    if (inhabited.length === 1) return getIrTypeConstructionTargetShape(inhabited[0], context, seen);
  }
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
  const declarationSymbol =
    symbol?.flags && symbol.flags & ts.SymbolFlags.Alias ? context.checker.getAliasedSymbol(symbol) : symbol;
  const declaration = declarationSymbol?.declarations?.find(
    (candidate): candidate is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      ts.isInterfaceDeclaration(candidate) || ts.isTypeAliasDeclaration(candidate),
  );
  if (!declaration) return type;
  const declarationSourceFile = declaration.getSourceFile();
  const declarationOptions = context.analysisModuleOptions.get(declarationSourceFile.fileName);
  if (!declarationOptions) return type;
  const declarationContext = { ...context, options: declarationOptions, sourceFile: declarationSourceFile };
  let unresolved: Readonly<IrType>;
  if (ts.isInterfaceDeclaration(declaration)) {
    const evidence = lowerTypeScriptInterfacePropertiesEvidence(
      declaration,
      declarationContext,
      declarationSymbol ? new Set([declarationSymbol]) : new Set(),
      new Map(),
    );
    const authored = lowerTypeProperties(declaration.members, declarationContext);
    const authoredNames = new Set(authored.map((property) => property.name));
    unresolved = {
      kind: 'object',
      properties: [...evidence.filter((property) => !authoredNames.has(property.name)), ...authored],
    };
  } else {
    try {
      unresolved = lowerType(declaration.type, declarationContext);
    } catch (error) {
      if (isUnsupportedSyntaxFailure(error)) return type;
      throw error;
    }
  }
  const typeParameters = lowerTypeParameters(declaration.typeParameters, declarationContext);
  if (
    type.typeArguments.length > typeParameters.length ||
    typeParameters.slice(type.typeArguments.length).some((parameter) => !parameter.default)
  ) {
    return type;
  }
  const resolved = resolveIrTypeStructuralSubstitution(
    unresolved,
    createIrTypeParameterSubstitutionPlan(typeParameters, type.typeArguments),
  );
  const nextSeen = new Set(seen);
  nextSeen.add(bindingId);
  return getIrTypeConstructionTargetShape(resolved, context, nextSeen);
}

function getIrTypeObjectProjectionKeys(type: Readonly<IrType>): ReadonlySet<string> | undefined {
  if (type.kind === 'literal' && (typeof type.value === 'string' || typeof type.value === 'number')) {
    return new Set([String(type.value)]);
  }
  if (type.kind === 'typeOf' && type.reference.kind === 'binding' && type.reference.path.length === 0) {
    return new Set([type.reference.binding.name]);
  }
  if (type.kind !== 'union') return undefined;
  const keys = type.types.flatMap((member) => [...(getIrTypeObjectProjectionKeys(member) ?? [])]);
  return keys.length === type.types.length ? new Set(keys) : undefined;
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
  if (ts.isGetAccessorDeclaration(node)) {
    if (!node.body) unsupported(node, 'object getters require a body');
    const signature = lowerFunctionSignature(node, context);
    const parameterEntries = lowerParameterBindingEntries(node.parameters, signature.parameters, context);
    return {
      kind: 'getAccessor',
      name: propertyName(node.name, context),
      value: {
        async: false,
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
        parameters: signature.parameters,
        returns: signature.returns,
        thisMode: 'dynamic',
        typeParameters: signature.typeParameters,
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
    const authoredBindingType = node.type ? lowerTypeScriptTypeNodeEvidence(node.type, context) : parameter.type;
    const bindingType = getIrTypeConstructionTargetShape(authoredBindingType, context) ?? authoredBindingType;
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
  if (typeParameter.rest) {
    const dependentCallablePack = lowerDependentCallableParameterPackEvidence(node, typeParameter.type, context);
    return {
      ...parameter,
      ...(dependentCallablePack ? { dependentCallablePack } : {}),
      optional: false,
      rest: true,
    };
  }
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

function lowerDependentCallableParameterPackEvidence(
  node: ts.ParameterDeclaration,
  type: Readonly<IrType>,
  context: LoweringContext,
): IrDependentCallableParameterPackEvidence | undefined {
  if (
    !node.dotDotDotToken ||
    !node.type ||
    !ts.isTypeReferenceNode(node.type) ||
    !ts.isIdentifier(node.type.typeName) ||
    node.type.typeName.text !== 'Parameters' ||
    node.type.typeArguments?.length !== 1 ||
    type.kind !== 'named' ||
    type.reference.kind !== 'ambient' ||
    type.reference.name !== 'Parameters' ||
    type.typeArguments.length !== 1
  ) {
    return undefined;
  }
  const callable = type.typeArguments[0]!;
  const callableNode = node.type.typeArguments[0]!;
  if (
    callable.kind !== 'named' ||
    callable.reference.kind !== 'binding' ||
    callable.reference.path.length !== 0 ||
    callable.reference.binding.kind !== 'typeParameter' ||
    !ts.isTypeReferenceNode(callableNode) ||
    !ts.isIdentifier(callableNode.typeName) ||
    callableNode.typeArguments?.length
  ) {
    return undefined;
  }
  return lowerDependentCallableTypeParameterEvidence(callable, 'parameters', context);
}

function lowerDependentCallableTypeParameterEvidence(
  type: Readonly<IrType>,
  kind: IrDependentCallableParameterPackEvidence['kind'],
  context: LoweringContext,
): IrDependentCallableParameterPackEvidence | undefined {
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.path.length !== 0 ||
    type.reference.binding.kind !== 'typeParameter'
  ) {
    return undefined;
  }
  const callableBinding = type.reference.binding;
  const symbol = [...context.typeBindings].find(([, binding]) => binding.id === callableBinding.id)?.[0];
  const declaration = symbol?.declarations?.find(ts.isTypeParameterDeclaration);
  if (!declaration?.constraint) return undefined;
  const constraint = lowerType(declaration.constraint, context);
  if (constraint.kind !== 'function' || constraint.typeParameters.length > 0) return undefined;
  const binding = lowerTypeBindingIdentity(declaration.name, context);
  if (binding.id !== callableBinding.id) return undefined;
  return {
    callable: binding,
    constraint,
    kind,
    schema: 'flight-compiler-dependent-callable-pack/1',
  };
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
    const elementType: IrType | undefined = ts.isForOfStatement(node)
      ? lowerTypeScriptForOfElementType(node.expression, context)
      : { kind: 'primitive', name: 'string' };
    const iterableType = ts.isForOfStatement(node)
      ? getTypeScriptExpressionBindingTypeEvidence(node.expression, context)
      : undefined;
    const variable = lowerVariables(node.initializer, context, elementType)[0]!;
    return ts.isForOfStatement(node)
      ? {
          await: node.awaitModifier !== undefined,
          body: lowerStatement(node.statement, context),
          iterable: lowerExpression(
            node.expression,
            context,
            elementType ? { element: elementType, kind: 'array', readonly: false } : undefined,
          ),
          ...(iterableType ? { iterableType } : {}),
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
      cases: node.caseBlock.clauses.map((clause) => {
        const unionMemberTest = ts.isCaseClause(clause)
          ? getTypeScriptDiscriminantUnionMemberTestEvidence(node.expression, clause.expression, true, context)
          : undefined;
        return {
          ...(ts.isCaseClause(clause) ? { expression: lowerExpression(clause.expression, context) } : {}),
          statements: lowerStatementList(clause.statements, context),
          ...(unionMemberTest ? { unionMemberTest } : {}),
        };
      }),
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
      resultType: returns,
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
  const localFunctionNodes = nodes.flatMap((node, index) =>
    ts.isFunctionDeclaration(node) ? [{ binding: lowerLocalFunctionBinding(node, context), index, node }] : [],
  );
  const localFunctions = localFunctionNodes.map((localFunction) => ({
    ...localFunction,
    lowering: lowerLocalFunctionDeclaration(localFunction.node, localFunction.binding, context),
  }));
  if (localFunctions.length === 0)
    return nodes.flatMap((node) =>
      ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? [] : [lowerStatement(node, context)],
    );

  const initializationByIndex = new Map<number, IrStatement[]>();
  for (const localFunction of localFunctions) {
    const symbol = context.checker.getSymbolAtLocation(localFunction.node.name!);
    if (!symbol) unsupported(localFunction.node.name!, `binding ${localFunction.node.name!.text} cannot be resolved`);
    const firstUse = nodes.findIndex(
      (node) => !ts.isFunctionDeclaration(node) && typeScriptNodeReferencesSymbol(node, symbol, context.checker),
    );
    const captured = getTypeScriptReferencedSymbols(localFunction.node.body!, context.checker);
    captured.delete(symbol);
    const lastCapturedDeclaration = nodes.reduce(
      (latest, node, index) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((declaration) =>
          getTypeScriptBindingNameSymbols(declaration.name, context.checker).some((candidate) =>
            captured.has(candidate),
          ),
        )
          ? Math.max(latest, index)
          : latest,
      -1,
    );
    const earliestObservableIndex = firstUse < 0 ? localFunction.index : Math.min(localFunction.index, firstUse);
    const initializationIndex = Math.max(earliestObservableIndex, lastCapturedDeclaration + 1);
    if (firstUse >= 0 && initializationIndex > firstUse) {
      unsupported(
        localFunction.node,
        `local function ${localFunction.node.name!.text} cannot be initialized before a reference that precedes its captured bindings`,
      );
    }
    const initializations = initializationByIndex.get(initializationIndex) ?? [];
    initializations.push(localFunction.lowering.initialization);
    initializationByIndex.set(initializationIndex, initializations);
  }

  const statements: IrStatement[] = [
    { declarations: localFunctions.map(({ lowering }) => lowering.declaration), kind: 'variable' },
  ];
  for (let index = 0; index <= nodes.length; index += 1) {
    statements.push(...(initializationByIndex.get(index) ?? []));
    const node = nodes[index];
    if (
      node &&
      !ts.isFunctionDeclaration(node) &&
      !ts.isInterfaceDeclaration(node) &&
      !ts.isTypeAliasDeclaration(node)
    ) {
      statements.push(lowerStatement(node, context));
    }
  }
  return statements;
}

interface TypeScriptLocalFunctionLowering {
  readonly declaration: IrVariable;
  readonly initialization: IrStatement;
}

function lowerLocalFunctionDeclaration(
  node: ts.FunctionDeclaration,
  binding: IrBindingIdentity,
  context: LoweringContext,
): TypeScriptLocalFunctionLowering {
  if (!node.name) unsupported(node, 'local function declarations require a name');
  if (!node.body)
    unsupported(node, `local function ${node.name.text} overload signatures require explicit representation`);
  if (binding.scope !== 'function') {
    unsupported(node, `block-local function ${node.name.text} requires block-entry initialization representation`);
  }
  const signature = lowerFunctionSignature(node, context);
  const type = lowerFunctionType(node, context);
  addTypeScriptBindingTypeEvidence(node.name, type, context);
  const parameterEntries = lowerParameterBindingEntries(node.parameters, signature.parameters, context);
  const initializer: Extract<IrExpression, { kind: 'function' }> = {
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
  };
  const domain = getIrTypeOperatorValueDomain(type);
  return {
    declaration: { binding, initialValue: 'uninitialized', mutable: true, type },
    initialization: {
      expression: {
        kind: 'assignment',
        left: { kind: 'identifier', reference: { binding, kind: 'binding' } },
        operator: '=',
        right: initializer,
        semantics: {
          left: { declared: domain, flow: domain },
          result: domain,
          right: { declared: domain, flow: domain },
        },
      },
      kind: 'expression',
    },
  };
}

function lowerLocalFunctionBinding(node: ts.FunctionDeclaration, context: LoweringContext): IrBindingIdentity {
  if (!node.name) unsupported(node, 'local function declarations require a name');
  const symbol = context.checker.getSymbolAtLocation(node.name);
  if (!symbol) unsupported(node.name, `binding ${node.name.text} cannot be resolved`);
  const binding = { ...lowerBindingSymbol(symbol, node.name, context), kind: 'variable' as const };
  context.bindings.set(symbol, binding);
  return binding;
}

function getTypeScriptBindingNameSymbols(name: ts.BindingName, checker: ts.TypeChecker): readonly ts.Symbol[] {
  if (ts.isIdentifier(name)) {
    const symbol = checker.getSymbolAtLocation(name);
    return symbol ? [symbol] : [];
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : getTypeScriptBindingNameSymbols(element.name, checker),
  );
}

function getTypeScriptReferencedSymbols(node: ts.Node, checker: ts.TypeChecker): Set<ts.Symbol> {
  const symbols = new Set<ts.Symbol>();
  const visit = (candidate: ts.Node): void => {
    if (ts.isIdentifier(candidate)) {
      const symbol = checker.getSymbolAtLocation(candidate);
      if (symbol) symbols.add(symbol);
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return symbols;
}

function typeScriptNodeReferencesSymbol(node: ts.Node, symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  let referenced = false;
  const visit = (candidate: ts.Node): void => {
    if (referenced) return;
    if (ts.isIdentifier(candidate) && checker.getSymbolAtLocation(candidate) === symbol) {
      referenced = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return referenced;
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
  if (ts.isTypePredicateNode(node)) {
    return { kind: 'primitive', name: node.assertsModifier ? 'void' : 'boolean' };
  }
  if (ts.isParenthesizedTypeNode(node)) return lowerType(node.type, context);
  if (ts.isTypeReferenceNode(node)) {
    const localType = lowerTypeScriptFunctionLocalTypeReference(node, context);
    if (localType) return localType;
    const callableUtility = lowerConcreteTypeScriptCallableUtilityReference(node, context);
    if (callableUtility) return callableUtility;
    const mapped = lowerConcreteTypeScriptMappedAliasReference(node, context);
    if (mapped) return mapped;
    const projection = lowerConcreteTypeScriptObjectProjection(node, context);
    if (projection) return projection;
    const conditional = lowerConcreteTypeScriptConditionalAliasReference(node, context);
    if (conditional) return conditional;
    const conditionalFacet = lowerOpenTypeScriptConditionalFacetAliasReference(node, context);
    if (conditionalFacet) return conditionalFacet;
    const name = getTypeScriptNodeText(node.typeName, context);
    const arguments_ =
      node.typeArguments?.map((type) =>
        name === 'NonNullable' &&
        ts.isIndexedAccessTypeNode(type) &&
        isTypeScriptClosedCallableObjectIndexedAccess(type, context)
          ? lowerTypeScriptIndexedAccessSyntax(type, context)
          : lowerType(type, context),
      ) ?? [];
    const reference = lowerTypeNameReference(node.typeName, context);
    if (!reference) return { kind: 'unknown', source: 'unknown' };
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
    const types = lowerCompoundTypes(node.types, node, context);
    if (types.some((type) => type.kind === 'never')) return { kind: 'never' };
    const represented = types.filter((type) => type.kind !== 'unknown' || type.source !== 'unknown');
    if (represented.length === 0) return { kind: 'unknown', source: 'unknown' };
    if (represented.length === 1) return represented[0]!;
    return { kind: 'intersection', types: [represented[0]!, represented[1]!, ...represented.slice(2)] };
  }
  if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) return lowerFunctionType(node, context);
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
    if (node.operator === ts.SyntaxKind.UniqueKeyword) return lowerType(node.type, context);
    if (node.operator === ts.SyntaxKind.ReadonlyKeyword) {
      const type = lowerType(node.type, context);
      if (type.kind === 'array' || type.kind === 'tuple') return { ...type, readonly: true };
      return type;
    }
    unsupported(node, `unsupported type operator ${ts.tokenToString(node.operator) ?? String(node.operator)}`);
  }
  if (ts.isIndexedAccessTypeNode(node)) {
    const concrete = lowerConcreteIndexedAccessType(node, context);
    if (concrete) return concrete;
    return {
      index: lowerType(node.indexType, context),
      kind: 'indexedAccess',
      object: lowerType(node.objectType, context),
    };
  }
  if (ts.isTypeQueryNode(node)) {
    const reference = lowerValueNameReference(node.exprName, context);
    if (reference.kind === 'ambient' || !isTypeScriptBindingIntroducedInModule(reference.binding, context)) {
      const checkerType = getTypeScriptCheckerTypeEvidence(context.checker.getTypeFromTypeNode(node), context, 0, true);
      if (checkerType && isIrTypeScalarTypeQueryEvidence(checkerType)) return checkerType;
    }
    return { kind: 'typeOf', reference };
  }
  if (ts.isTemplateLiteralTypeNode(node)) return { kind: 'primitive', name: 'string' };
  if (ts.isConditionalTypeNode(node)) {
    const concrete = lowerConcreteConditionalType(node, context);
    if (concrete) return concrete;
  }
  if (ts.isMappedTypeNode(node)) {
    const concrete = lowerConcreteMappedType(node, context);
    if (concrete) return concrete;
  }
  unsupported(node, `unsupported type ${ts.SyntaxKind[node.kind]}`);
}

function isIrTypeScalarTypeQueryEvidence(type: Readonly<IrType>): boolean {
  return (
    type.kind === 'literal' ||
    type.kind === 'primitive' ||
    (type.kind === 'union' && type.types.every(isIrTypeScalarTypeQueryEvidence))
  );
}

function lowerTypeScriptFunctionLocalTypeReference(
  node: ts.TypeReferenceNode,
  context: LoweringContext,
): Readonly<IrType> | undefined {
  const unresolved = context.checker.getSymbolAtLocation(node.typeName);
  const symbol = unresolved ? (resolveTypeBindingAliasTarget(unresolved, context) ?? unresolved) : undefined;
  const declaration = symbol?.declarations?.find(
    (candidate): candidate is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      (ts.isInterfaceDeclaration(candidate) || ts.isTypeAliasDeclaration(candidate)) &&
      !ts.isSourceFile(candidate.parent) &&
      !ts.isModuleBlock(candidate.parent),
  );
  if (!declaration) return undefined;
  const substitutions = createTypeScriptSyntacticDeclarationSubstitutions(
    node,
    declaration,
    context.checker,
    new Map(),
  );
  if (!substitutions) return undefined;
  if (ts.isTypeAliasDeclaration(declaration)) {
    return lowerTypeScriptTypeNodeEvidence(declaration.type, context, new Set([symbol!]), substitutions);
  }
  return {
    kind: 'object',
    properties: lowerTypeScriptInterfacePropertiesEvidence(declaration, context, new Set([symbol!]), substitutions),
  };
}

function lowerConcreteTypeScriptCallableUtilityReference(
  node: ts.TypeReferenceNode,
  context: LoweringContext,
): Readonly<IrType> | undefined {
  if (
    !ts.isIdentifier(node.typeName) ||
    (node.typeName.text !== 'Parameters' && node.typeName.text !== 'ReturnType') ||
    node.typeArguments?.length !== 1
  ) {
    return undefined;
  }
  // Leave a dependent Parameters<T> authored against a callable type parameter intact: the IR's
  // dependent-callable-pack contract describes it more faithfully than eagerly widening it here.
  const argument = node.typeArguments[0]!;
  if (node.typeName.text === 'Parameters' && ts.isTypeReferenceNode(argument)) {
    const symbol = context.checker.getSymbolAtLocation(argument.typeName);
    if (symbol?.declarations?.some(ts.isTypeParameterDeclaration)) return undefined;
  }
  const evidence = getTypeScriptCheckerTypeEvidence(context.checker.getTypeFromTypeNode(node), context, 0, true);
  // A deliberately minimal source program may not include a host library declaration for these
  // standard utilities. In that case the checker reports `any`, but retaining the authored utility
  // reference and its `typeof` operand gives backends exact access to the local callable signature.
  // Concrete checker evidence still wins when a library or declaration supplies it.
  return evidence?.kind === 'unknown' ? undefined : evidence;
}

function lowerConcreteTypeScriptObjectProjection(
  node: ts.TypeReferenceNode,
  context: LoweringContext,
): Readonly<IrType> | undefined {
  const name = ts.isIdentifier(node.typeName) ? node.typeName.text : undefined;
  if ((name !== 'Omit' && name !== 'Pick') || node.typeArguments?.length !== 2) return undefined;
  const subject = node.typeArguments[0]!;
  const keyType = node.typeArguments[1]!;
  const properties = lowerTypeScriptCheckerObjectProperties(context.checker.getTypeFromTypeNode(subject), context, 0);
  const keys = getTypeScriptObjectProjectionKeys(keyType);
  if (!properties || !keys) return undefined;
  const available = new Set(properties.map((property) => property.name));
  if ([...keys].some((key) => !available.has(key))) return undefined;
  return {
    kind: 'object',
    properties: properties.filter((property) => (name === 'Pick' ? keys.has(property.name) : !keys.has(property.name))),
  };
}

function lowerConcreteTypeScriptConditionalAliasReference(
  node: ts.TypeReferenceNode,
  context: LoweringContext,
): IrType | undefined {
  // Keep standard utility identity in neutral IR. Expanding lib.d.ts' conditional aliases here can
  // discard the exclusion predicate when its subject is an imported alias or a keyof expression;
  // target backends instead evaluate the retained utility against their resolved module graph.
  if (ts.isIdentifier(node.typeName) && (node.typeName.text === 'Exclude' || node.typeName.text === 'NonNullable')) {
    return undefined;
  }
  if (hasExternalTypeScriptTypeParameter(node, context)) return undefined;
  const unresolved = context.checker.getSymbolAtLocation(node.typeName);
  const symbol = unresolved ? (resolveTypeBindingAliasTarget(unresolved, context) ?? unresolved) : undefined;
  const declaration = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
  if (!symbol || !declaration || !ts.isConditionalTypeNode(declaration.type)) return undefined;
  const substitutions = createTypeScriptSyntacticDeclarationSubstitutions(
    node,
    declaration,
    context.checker,
    new Map(),
  );
  if (!substitutions) return undefined;
  try {
    return lowerConcreteTypeScriptConditionalTypeEvidence(declaration.type, context, new Set([symbol]), substitutions);
  } catch (error) {
    if (isUnsupportedSyntaxFailure(error)) return undefined;
    throw error;
  }
}

function lowerOpenTypeScriptConditionalFacetAliasReference(
  node: ts.TypeReferenceNode,
  context: LoweringContext,
): IrType | undefined {
  const unresolved = context.checker.getSymbolAtLocation(node.typeName);
  const symbol = unresolved ? (resolveTypeBindingAliasTarget(unresolved, context) ?? unresolved) : undefined;
  const declaration = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
  if (!symbol || !declaration || !ts.isConditionalTypeNode(declaration.type)) return undefined;
  const substitutions = createTypeScriptSyntacticDeclarationSubstitutions(
    node,
    declaration,
    context.checker,
    new Map(),
  );
  if (!substitutions) return undefined;
  return lowerOpenTypeScriptConditionalFacetEvidence(declaration.type, context, substitutions);
}

function lowerOpenTypeScriptConditionalFacetEvidence(
  node: ts.ConditionalTypeNode,
  context: LoweringContext,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>,
): Readonly<Extract<IrType, { kind: 'conditionalFacet' }>> | undefined {
  const checkType = getTypeScriptSyntacticTypeSubstitution(node.checkType, context.checker, substitutions);
  const falseType = getTypeScriptSyntacticTypeSubstitution(node.falseType, context.checker, substitutions);
  const trueType = getTypeScriptSyntacticTypeSubstitution(node.trueType, context.checker, substitutions);
  if (
    !ts.isTypeReferenceNode(checkType) ||
    checkType.typeArguments ||
    falseType.kind !== ts.SyntaxKind.UnknownKeyword
  ) {
    return undefined;
  }
  const checkSymbol = context.checker.getSymbolAtLocation(checkType.typeName);
  if (!checkSymbol?.declarations?.some(ts.isTypeParameterDeclaration)) return undefined;
  const path = getTypeScriptConditionalFacetRequiredPath(node.extendsType, context, substitutions);
  if (!path) return undefined;
  const check = lowerType(checkType, context);
  const facet = lowerType(trueType, context);
  if (
    check.kind !== 'named' ||
    check.reference.kind !== 'binding' ||
    check.reference.binding.kind !== 'typeParameter' ||
    check.reference.path.length > 0 ||
    check.typeArguments.length > 0 ||
    facet.kind !== 'named' ||
    facet.reference.kind !== 'binding' ||
    facet.reference.path.length > 0
  ) {
    return undefined;
  }
  return { check, facet, kind: 'conditionalFacet', path };
}

function getTypeScriptConditionalFacetRequiredPath(
  node: ts.TypeNode,
  context: LoweringContext,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>,
): readonly [string, ...string[]] | undefined {
  const substituted = getTypeScriptSyntacticTypeSubstitution(node, context.checker, substitutions);
  if (substituted !== node) {
    return getTypeScriptConditionalFacetRequiredPath(substituted, context, substitutions);
  }
  if (ts.isTypeLiteralNode(node)) {
    if (node.members.length !== 1) return undefined;
    const property = node.members[0];
    if (
      !property ||
      !ts.isPropertySignature(property) ||
      property.questionToken ||
      !hasModifier(property, ts.SyntaxKind.ReadonlyKeyword) ||
      !property.type
    ) {
      return undefined;
    }
    const name = tryPropertyName(property.name);
    const nested = getTypeScriptConditionalFacetRequiredPath(property.type, context, substitutions);
    return name !== undefined && nested ? [name, ...nested] : undefined;
  }
  if (
    !ts.isMappedTypeNode(node) ||
    node.nameType ||
    node.questionToken ||
    node.readonlyToken?.kind !== ts.SyntaxKind.ReadonlyKeyword ||
    node.type?.kind !== ts.SyntaxKind.UnknownKeyword
  ) {
    return undefined;
  }
  const constraint = node.typeParameter.constraint;
  if (!constraint) return undefined;
  const key = getTypeScriptSyntacticTypeSubstitution(constraint, context.checker, substitutions);
  return ts.isLiteralTypeNode(key) && ts.isStringLiteral(key.literal) && key.literal.text.length > 0
    ? [key.literal.text]
    : undefined;
}

function isErasableTypeScriptConditionalFacetHelper(node: ts.TypeAliasDeclaration, context: LoweringContext): boolean {
  if (isExported(node) || !ts.isConditionalTypeNode(node.type)) return false;
  const symbol = context.checker.getSymbolAtLocation(node.name);
  if (!symbol) return false;
  let references = 0;
  let supported = true;
  const visit = (candidate: ts.Node): void => {
    if (!supported) return;
    if (ts.isIdentifier(candidate) && context.checker.getSymbolAtLocation(candidate) === symbol) {
      if (candidate === node.name) return;
      const reference = candidate.parent;
      if (
        !ts.isTypeReferenceNode(reference) ||
        reference.typeName !== candidate ||
        !lowerOpenTypeScriptConditionalFacetAliasReference(reference, context)
      ) {
        supported = false;
        return;
      }
      references += 1;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(context.sourceFile);
  return supported && references > 0;
}

function getTypeScriptObjectProjectionKeys(node: ts.TypeNode): ReadonlySet<string> | undefined {
  if (ts.isParenthesizedTypeNode(node)) return getTypeScriptObjectProjectionKeys(node.type);
  if (ts.isUnionTypeNode(node)) {
    const members = node.types.map(getTypeScriptObjectProjectionKeys);
    if (members.some((member) => !member)) return undefined;
    return new Set(members.flatMap((member) => [...member!]));
  }
  if (!ts.isLiteralTypeNode(node)) return undefined;
  if (ts.isStringLiteral(node.literal) || ts.isNumericLiteral(node.literal)) {
    return new Set([node.literal.text]);
  }
  return undefined;
}

function lowerConcreteConditionalType(node: ts.ConditionalTypeNode, context: LoweringContext): IrType | undefined {
  const readonlyIdentity = lowerTypeScriptDeepReadonlyConditionalRepresentation(node, context);
  if (readonlyIdentity) return readonlyIdentity;
  if (hasExternalTypeScriptTypeParameter(node, context)) {
    return lowerTypeScriptConditionalRuntimeRepresentation(node, context);
  }
  return getTypeScriptCheckerTypeEvidence(context.checker.getTypeFromTypeNode(node), context, 0, true);
}

function lowerTypeScriptDeepReadonlyConditionalRepresentation(
  node: ts.ConditionalTypeNode,
  context: LoweringContext,
): Readonly<IrType> | undefined {
  const declaration = node.parent;
  if (
    !ts.isTypeAliasDeclaration(declaration) ||
    declaration.type !== node ||
    declaration.typeParameters?.length !== 1
  ) {
    return undefined;
  }
  const parameter = declaration.typeParameters[0]!;
  const parameterSymbol = context.checker.getSymbolAtLocation(parameter.name);
  const aliasSymbol = context.checker.getSymbolAtLocation(declaration.name);
  if (
    !parameterSymbol ||
    !aliasSymbol ||
    !isTypeScriptDeepReadonlyArrayBranch(node, parameterSymbol, aliasSymbol, false, context) ||
    !ts.isConditionalTypeNode(node.falseType) ||
    !isTypeScriptDeepReadonlyArrayBranch(node.falseType, parameterSymbol, aliasSymbol, true, context) ||
    !ts.isConditionalTypeNode(node.falseType.falseType) ||
    !isTypeScriptDeepReadonlyObjectBranch(node.falseType.falseType, parameterSymbol, aliasSymbol, context)
  ) {
    return undefined;
  }
  return lowerType(node.checkType, context);
}

function isTypeScriptDeepReadonlyArrayBranch(
  node: ts.ConditionalTypeNode,
  parameterSymbol: ts.Symbol,
  aliasSymbol: ts.Symbol,
  readonly: boolean,
  context: LoweringContext,
): boolean {
  if (!isTypeScriptBareTypeReferenceToSymbol(node.checkType, parameterSymbol, context)) return false;
  const array = readonly
    ? ts.isTypeOperatorNode(node.extendsType) && node.extendsType.operator === ts.SyntaxKind.ReadonlyKeyword
      ? node.extendsType.type
      : undefined
    : node.extendsType;
  if (!array || !ts.isArrayTypeNode(array)) return false;
  const element = ts.isParenthesizedTypeNode(array.elementType) ? array.elementType.type : array.elementType;
  if (!ts.isInferTypeNode(element)) return false;
  const elementSymbol = context.checker.getSymbolAtLocation(element.typeParameter.name);
  if (!elementSymbol || !ts.isTypeReferenceNode(node.trueType)) return false;
  const trueName = getTypeScriptNodeText(node.trueType.typeName, context);
  const recursive = node.trueType.typeArguments?.[0];
  return (
    trueName === 'ReadonlyArray' &&
    node.trueType.typeArguments?.length === 1 &&
    recursive !== undefined &&
    isTypeScriptRecursiveReadonlyReference(recursive, elementSymbol, aliasSymbol, context)
  );
}

function isTypeScriptDeepReadonlyObjectBranch(
  node: ts.ConditionalTypeNode,
  parameterSymbol: ts.Symbol,
  aliasSymbol: ts.Symbol,
  context: LoweringContext,
): boolean {
  if (
    !isTypeScriptBareTypeReferenceToSymbol(node.checkType, parameterSymbol, context) ||
    node.extendsType.kind !== ts.SyntaxKind.ObjectKeyword ||
    !isTypeScriptBareTypeReferenceToSymbol(node.falseType, parameterSymbol, context) ||
    !ts.isMappedTypeNode(node.trueType) ||
    node.trueType.nameType ||
    node.trueType.questionToken ||
    node.trueType.readonlyToken?.kind !== ts.SyntaxKind.ReadonlyKeyword ||
    !node.trueType.type
  ) {
    return false;
  }
  const keySymbol = context.checker.getSymbolAtLocation(node.trueType.typeParameter.name);
  const constraint = node.trueType.typeParameter.constraint;
  if (
    !keySymbol ||
    !constraint ||
    !ts.isTypeOperatorNode(constraint) ||
    constraint.operator !== ts.SyntaxKind.KeyOfKeyword ||
    !isTypeScriptBareTypeReferenceToSymbol(constraint.type, parameterSymbol, context)
  ) {
    return false;
  }
  if (!ts.isTypeReferenceNode(node.trueType.type) || node.trueType.type.typeArguments?.length !== 1) return false;
  const recursiveSymbol = context.checker.getSymbolAtLocation(node.trueType.type.typeName);
  const argument = node.trueType.type.typeArguments[0]!;
  return (
    recursiveSymbol === aliasSymbol &&
    ts.isIndexedAccessTypeNode(argument) &&
    isTypeScriptBareTypeReferenceToSymbol(argument.objectType, parameterSymbol, context) &&
    isTypeScriptBareTypeReferenceToSymbol(argument.indexType, keySymbol, context)
  );
}

function isTypeScriptRecursiveReadonlyReference(
  node: ts.TypeNode,
  argumentSymbol: ts.Symbol,
  aliasSymbol: ts.Symbol,
  context: LoweringContext,
): boolean {
  return (
    ts.isTypeReferenceNode(node) &&
    context.checker.getSymbolAtLocation(node.typeName) === aliasSymbol &&
    node.typeArguments?.length === 1 &&
    isTypeScriptBareTypeReferenceToSymbol(node.typeArguments[0]!, argumentSymbol, context)
  );
}

function isTypeScriptBareTypeReferenceToSymbol(
  node: ts.TypeNode,
  symbol: ts.Symbol,
  context: LoweringContext,
): boolean {
  const unwrapped = ts.isParenthesizedTypeNode(node) ? node.type : node;
  return (
    ts.isTypeReferenceNode(unwrapped) &&
    !unwrapped.typeArguments &&
    context.checker.getSymbolAtLocation(unwrapped.typeName) === symbol
  );
}

// A conditional type can reject some generic instantiations without changing the representation of
// any value that can exist. `T extends Constraint ? T : never`, for example, is still represented by
// T, while a literal true/false conditional is represented by bool. Preserve those representation-
// neutral refinements and refuse conditionals whose inhabited branches require different layouts.
function lowerTypeScriptConditionalRuntimeRepresentation(
  node: ts.ConditionalTypeNode,
  context: LoweringContext,
): IrType | undefined {
  if (containsTypeScriptInferType(node)) return undefined;
  const branches = getTypeScriptConditionalInhabitedBranches(node);
  if (branches.length === 0) return { kind: 'never' };
  const object = lowerTypeScriptConditionalCommonObjectEvidence(branches, context);
  if (object) return object;
  const lowered = branches.map((branch) => lowerType(branch, context));
  const arrays = lowered.filter((branch): branch is Extract<IrType, { kind: 'array' }> => branch.kind === 'array');
  if (arrays.length === lowered.length) {
    const elements = [
      ...new Map(arrays.map((array) => [JSON.stringify(array.element), array.element] as const)).values(),
    ];
    return {
      element:
        elements.length === 1
          ? elements[0]!
          : { kind: 'union', types: [elements[0]!, elements[1]!, ...elements.slice(2)] },
      kind: 'array',
      readonly: arrays.every((array) => array.readonly),
    };
  }
  const represented = lowered.map(getIrTypeRuntimeRepresentationSemantic);
  const first = represented[0]!;
  return represented.every((candidate) => JSON.stringify(candidate) === JSON.stringify(first)) ? first : undefined;
}

function lowerTypeScriptConditionalCommonObjectEvidence(
  branches: readonly ts.TypeNode[],
  context: LoweringContext,
): Readonly<Extract<IrType, { kind: 'object' }>> | undefined {
  const branchProperties = branches.map((branch) =>
    lowerTypeScriptHeritageTypeNodeProperties(branch, context, new Set(), new Map()),
  );
  if (branchProperties.some((properties) => !properties)) return undefined;
  const [first, ...rest] = branchProperties as readonly (readonly IrObjectTypeProperty[])[];
  if (!first) return undefined;
  const properties = first.filter((property) =>
    rest.every((branch) =>
      branch.some(
        (candidate) => candidate.name === property.name && JSON.stringify(candidate) === JSON.stringify(property),
      ),
    ),
  );
  return properties.length > 0 ? { kind: 'object', properties } : undefined;
}

function getTypeScriptConditionalInhabitedBranches(node: ts.ConditionalTypeNode): ts.TypeNode[] {
  return [node.trueType, node.falseType].flatMap((branch): ts.TypeNode[] => {
    if (branch.kind === ts.SyntaxKind.NeverKeyword) return [];
    return ts.isConditionalTypeNode(branch) ? getTypeScriptConditionalInhabitedBranches(branch) : [branch];
  });
}

function containsTypeScriptInferType(node: ts.Node): boolean {
  if (ts.isInferTypeNode(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsTypeScriptInferType(child)) found = true;
  });
  return found;
}

function getIrTypeRuntimeRepresentationSemantic(type: IrType): IrType {
  if (type.kind !== 'literal') return type;
  return {
    kind: 'primitive',
    name: typeof type.value === 'boolean' ? 'boolean' : typeof type.value === 'number' ? 'number' : 'string',
  };
}

function lowerConcreteIndexedAccessType(node: ts.IndexedAccessTypeNode, context: LoweringContext): IrType | undefined {
  if (hasExternalTypeScriptTypeParameter(node, context)) return undefined;
  return getTypeScriptCheckerTypeEvidence(context.checker.getTypeFromTypeNode(node), context, 0, true);
}

function isTypeScriptClosedCallableObjectIndexedAccess(
  node: ts.IndexedAccessTypeNode,
  context: LoweringContext,
): boolean {
  const concrete = lowerConcreteIndexedAccessType(node, context);
  const present =
    concrete?.kind === 'union'
      ? concrete.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined')
      : concrete
        ? [concrete]
        : [];
  if (present.length !== 1 || present[0]?.kind !== 'intersection' || present[0].types.length !== 2) return false;
  const callable = present[0].types.filter(
    (member): member is Extract<IrType, { kind: 'function' }> => member.kind === 'function',
  );
  return (
    callable.length === 1 &&
    callable[0]!.typeParameters.length === 0 &&
    callable[0]!.parameters.every((parameter) => !parameter.optional && !parameter.rest) &&
    present[0].types.some((member) => member.kind === 'object')
  );
}

function lowerTypeScriptIndexedAccessSyntax(node: ts.IndexedAccessTypeNode, context: LoweringContext): IrType {
  return {
    index: lowerType(node.indexType, context),
    kind: 'indexedAccess',
    object: lowerType(node.objectType, context),
  };
}

function lowerTypeAlias(node: ts.TypeAliasDeclaration, context: LoweringContext): IrTypeAliasDeclaration {
  const objectView = getTypeScriptReadonlyRemovalIdentityMappedTypeSource(node.type, context)
    ? ('writable' as const)
    : undefined;
  return {
    binding: lowerTypeBindingIdentity(node.name, context),
    exported: isExported(node),
    kind: 'typeAlias',
    ...(objectView ? { objectView } : {}),
    origin: origin(node, context),
    type: lowerType(node.type, context),
    typeParameters: lowerTypeParameters(node.typeParameters, context),
  };
}

// Unsupported private helpers may still be part of the shape of a declaration that did lower. If
// the helper disappears, its surviving named references become dangling bindings and invalidate the
// whole module before a target can apply its own opaque/external policy. Preserve only aliases used
// outside their declaration, with unknown precision but stable identity and generic arity. An
// unsupported, otherwise unused export remains omitted as before.
function lowerOpaqueTypeAlias(node: ts.TypeAliasDeclaration, context: LoweringContext): IrTypeAliasDeclaration {
  return {
    binding: lowerTypeBindingIdentity(node.name, context),
    exported: isExported(node),
    kind: 'typeAlias',
    origin: origin(node, context),
    type: { kind: 'unknown', source: 'unknown' },
    typeParameters:
      node.typeParameters?.map((parameter) => ({ binding: lowerTypeBindingIdentity(parameter.name, context) })) ?? [],
  };
}

function isTypeAliasReferencedOutsideDeclaration(node: ts.TypeAliasDeclaration, context: LoweringContext): boolean {
  const symbol = context.checker.getSymbolAtLocation(node.name);
  if (!symbol) return false;
  return [...(context.symbolReferenceStatements().get(symbol) ?? [])].some((statement) => statement !== node);
}

function lowerTypeNameReference(node: ts.EntityName, context: LoweringContext): IrTypeNameReference | undefined {
  return lowerTypeNameNodeReference(node, context);
}

function lowerTypeNameNodeReference(
  node: ts.EntityName | ts.Expression,
  context: LoweringContext,
): IrTypeNameReference | undefined {
  const parts = getTypeNameNodeParts(node);
  if (!parts) return { kind: 'ambient', name: getTypeScriptNodeText(node, context) };
  const symbol = context.checker.getSymbolAtLocation(parts.root);
  if (isTypeScriptAmbientSymbol(symbol, context)) {
    return { kind: 'ambient', name: getTypeScriptNodeText(node, context) };
  }
  // A normal import can introduce both sides of a merged TypeScript declaration. The authored
  // ImportSpecifier is value-space, but its aliased target may also own a type alias, interface,
  // class, or enum. Preserve that type lane as its own inferred import identity: targets such as
  // Haxe do not share TypeScript's merged namespace and may need distinct facade names for the two
  // declarations.
  const aliasedTypeSymbol = symbol ? resolveTypeBindingAliasTarget(symbol, context) : undefined;
  if (symbol && aliasedTypeSymbol && !symbol.declarations?.some(isTypeBindingDeclaration)) {
    const inferred = lowerTypeScriptInferredTypeImportBinding(aliasedTypeSymbol, context);
    if (inferred) {
      context.typeBindings.set(symbol, inferred);
      context.typeBindings.set(aliasedTypeSymbol, inferred);
      return { binding: inferred, kind: 'binding', path: parts.path };
    }
  }
  if (symbol?.declarations?.some(isTypeBindingDeclaration)) {
    if (!hasTypeBindingDeclarationInModule(symbol, context)) {
      const aliased = resolveTypeBindingAliasTarget(symbol, context);
      const inferred = lowerTypeScriptInferredTypeImportBinding(aliased ?? symbol, context);
      if (!inferred) return undefined;
      context.typeBindings.set(symbol, inferred);
      if (aliased) context.typeBindings.set(aliased, inferred);
    }
    return { binding: lowerTypeBindingSymbol(symbol, parts.root, context), kind: 'binding', path: parts.path };
  }
  if (symbol?.declarations?.some(isValueBindingDeclaration)) {
    const declaration = symbol.declarations.find(
      (candidate): candidate is ts.ClassDeclaration | ts.EnumDeclaration =>
        ts.isClassDeclaration(candidate) || ts.isEnumDeclaration(candidate),
    );
    const inferred = declaration ? lowerTypeScriptInferredTypeImportBinding(symbol, context) : undefined;
    return {
      binding: inferred ?? lowerBindingSymbol(symbol, parts.root, context),
      kind: 'binding',
      path: parts.path,
    };
  }
  return { kind: 'ambient', name: getTypeScriptNodeText(node, context) };
}

function lowerValueNameReference(node: ts.EntityName | ts.Expression, context: LoweringContext): IrValueNameReference {
  const parts = getTypeNameNodeParts(node);
  if (!parts) return { kind: 'ambient', name: getTypeScriptNodeText(node, context) };
  const symbol = context.checker.getSymbolAtLocation(parts.root);
  return symbol?.declarations?.some(isValueBindingDeclaration) && !isTypeScriptAmbientSymbol(symbol, context)
    ? { binding: lowerBindingSymbol(symbol, parts.root, context), kind: 'binding', path: parts.path }
    : { kind: 'ambient', name: getTypeScriptNodeText(node, context) };
}

function getTypeScriptValueNamespaceMemberReference(
  node: ts.PropertyAccessExpression,
  context: LoweringContext,
): Readonly<{ namespaceMember: IrValueNameReference }> | undefined {
  const symbol = context.checker.getSymbolAtLocation(node.name);
  const namespaceMember = symbol?.declarations?.some(
    (declaration) => ts.isModuleBlock(declaration.parent) && ts.isModuleDeclaration(declaration.parent.parent),
  );
  return namespaceMember ? { namespaceMember: lowerValueNameReference(node, context) } : undefined;
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

function lowerTypeScriptTypePropertyKey(
  node: ts.PropertyName,
  context: LoweringContext,
): Readonly<{ computedKey?: IrValueNameReference | undefined; name: string; phantom?: true | undefined }> | undefined {
  const name = tryPropertyName(node);
  if (name !== undefined) return { name };
  if (!ts.isComputedPropertyName(node)) return undefined;
  const flags = context.checker.getTypeAtLocation(node.expression).flags;
  if ((flags & ts.TypeFlags.ESSymbolLike) === 0) return undefined;
  const computedKey = lowerValueNameReference(node.expression, context);
  const storageName =
    computedKey.kind === 'binding'
      ? [computedKey.binding.name, ...computedKey.path].join('_')
      : computedKey.name.replaceAll('.', '_');
  return storageName.length > 0
    ? {
        computedKey,
        name: storageName,
        ...(isTypeScriptPhantomUniqueSymbolKey(node.expression, context) ? { phantom: true as const } : {}),
      }
    : undefined;
}

function isTypeScriptPhantomUniqueSymbolKey(node: ts.Expression, context: LoweringContext): boolean {
  const symbol = context.checker.getSymbolAtLocation(node);
  const declaration = symbol?.valueDeclaration;
  const statement = declaration?.parent?.parent;
  if (
    !symbol ||
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !statement ||
    !ts.isVariableStatement(statement) ||
    !isErasableTypeScriptUniqueSymbolDeclaration(statement)
  ) {
    return false;
  }
  let typeOnly = true;
  const visit = (candidate: ts.Node): void => {
    if (!typeOnly) return;
    if (ts.isIdentifier(candidate) && context.checker.getSymbolAtLocation(candidate) === symbol) {
      if (candidate === declaration.name) return;
      if (
        ts.isComputedPropertyName(candidate.parent) &&
        (ts.isPropertySignature(candidate.parent.parent) || ts.isMethodSignature(candidate.parent.parent))
      ) {
        return;
      }
      typeOnly = false;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(context.sourceFile);
  return typeOnly;
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
    if (ts.isConstructSignatureDeclaration(member)) {
      const signatures = members.filter(ts.isConstructSignatureDeclaration);
      if (member !== signatures[0]) continue;
      if (
        members.some(
          (candidate) =>
            !ts.isConstructSignatureDeclaration(candidate) &&
            'name' in candidate &&
            candidate.name !== undefined &&
            tryPropertyName(candidate.name) === 'construct',
        )
      ) {
        unsupported(member, 'construct signature factory conflicts with object member construct');
      }
      const types = signatures.map((signature) => lowerFunctionType(signature, context));
      const [first, second, ...rest] = types;
      properties.push({
        name: 'construct',
        optional: false,
        readonly: true,
        role: 'construct',
        type: first && second ? { kind: 'intersection', types: [first, second, ...rest] } : first!,
      });
      continue;
    }
    if (ts.isPropertySignature(member)) {
      const key = lowerTypeScriptTypePropertyKey(member.name, context);
      if (!key) continue;
      if (!member.type) unsupported(member, 'property signature requires a type');
      if (properties.some((property) => property.name === key.name)) {
        unsupported(member, `object type property ${key.name} is declared more than once`);
      }
      properties.push({
        ...key,
        optional: member.questionToken !== undefined,
        readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
        type: lowerPropertyType(member.type),
      });
      continue;
    }
    if (ts.isIndexSignatureDeclaration(member)) continue;
    if (ts.isMethodSignature(member)) {
      if (loweredMethods.has(member)) continue;
      const name = tryPropertyName(member.name);
      if (name === undefined) continue;
      if (properties.some((property) => property.name === name)) {
        unsupported(member, `object type member ${name} mixes property and method declarations`);
      }
      const overloads = members.filter(
        (candidate): candidate is ts.MethodSignature =>
          ts.isMethodSignature(candidate) && tryPropertyName(candidate.name) === name,
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

function lowerConcreteMappedType(node: ts.MappedTypeNode, context: LoweringContext): IrType | undefined {
  const identity = lowerTypeScriptReadonlyRemovalIdentityMappedType(node, context);
  if (identity) return identity;
  if (hasExternalTypeScriptTypeParameter(node, context)) return undefined;
  const type = context.checker.getTypeFromTypeNode(node);
  const properties = lowerTypeScriptCheckerObjectProperties(type, context, 0, node);
  return properties ? { kind: 'object', properties } : undefined;
}

// `{ -readonly [Key in keyof Type]: Type[Key] }` changes view permissions but not object identity or
// storage. Retaining Type lets each target preserve the referent while honoring that writable view.
function lowerTypeScriptReadonlyRemovalIdentityMappedType(
  node: ts.MappedTypeNode,
  context: LoweringContext,
): IrType | undefined {
  const source = getTypeScriptReadonlyRemovalIdentityMappedTypeSource(node, context);
  return source ? lowerType(source, context) : undefined;
}

function getTypeScriptReadonlyRemovalIdentityMappedTypeSource(
  node: ts.TypeNode,
  context: LoweringContext,
): ts.TypeNode | undefined {
  if (
    !ts.isMappedTypeNode(node) ||
    node.readonlyToken?.kind !== ts.SyntaxKind.MinusToken ||
    node.questionToken ||
    node.nameType ||
    !node.type ||
    !ts.isIndexedAccessTypeNode(node.type)
  ) {
    return undefined;
  }
  const constraint = node.typeParameter.constraint;
  if (!constraint || !ts.isTypeOperatorNode(constraint) || constraint.operator !== ts.SyntaxKind.KeyOfKeyword) {
    return undefined;
  }
  const mappedParameter = context.checker.getSymbolAtLocation(node.typeParameter.name);
  const indexParameter = getTypeScriptTypeReferenceSymbol(node.type.indexType, context);
  const source = getTypeScriptTypeReferenceSymbol(constraint.type, context);
  const indexedSource = getTypeScriptTypeReferenceSymbol(node.type.objectType, context);
  if (!mappedParameter || mappedParameter !== indexParameter || !source || source !== indexedSource) {
    return undefined;
  }
  return constraint.type;
}

function getTypeScriptTypeReferenceSymbol(node: ts.TypeNode, context: LoweringContext): ts.Symbol | undefined {
  return ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)
    ? context.checker.getSymbolAtLocation(node.typeName)
    : undefined;
}

function isTypeScriptNodeWithin(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function hasExternalTypeScriptTypeParameter(node: ts.TypeNode, context: LoweringContext): boolean {
  const local = new Set<ts.Symbol>();
  const collect = (child: ts.Node): void => {
    if (ts.isTypeParameterDeclaration(child)) {
      const symbol = context.checker.getSymbolAtLocation(child.name);
      if (symbol) local.add(symbol);
    }
    ts.forEachChild(child, collect);
  };
  collect(node);
  let external = false;
  const visit = (child: ts.Node): void => {
    if (external) return;
    if (ts.isIdentifier(child)) {
      const symbol = context.checker.getSymbolAtLocation(child);
      if (symbol && !local.has(symbol) && symbol.declarations?.some(ts.isTypeParameterDeclaration)) {
        external = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return external;
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
    nodes?.map((node) => {
      if (hasModifier(node, ts.SyntaxKind.ConstKeyword)) {
        unsupported(node, 'const type parameters require explicit inference-preserving lowering');
      }
      return {
        binding: lowerTypeBindingIdentity(node.name, context),
        ...(node.constraint ? { constraint: lowerType(node.constraint, context) } : {}),
        ...(node.default ? { default: lowerType(node.default, context) } : {}),
      };
    }) ?? []
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
        : getTypeScriptUninitializedVariableType(node, context);
  const valueType = node.type ? lowerTypeScriptTypeNodeEvidence(node.type, context) : type;
  const target = ts.isIdentifier(node.name)
    ? { binding: lowerBindingIdentity(node.name, context) }
    : {
        pattern: lowerBindingPattern(
          node.name,
          context,
          getIrTypeConstructionTargetShape(valueType, context) ?? valueType,
        ),
      };
  if (ts.isIdentifier(node.name) && valueType) addTypeScriptBindingTypeEvidence(node.name, valueType, context);
  return {
    ...target,
    ...(node.initializer ? { initializer: lowerExpression(node.initializer, context, valueType, type) } : {}),
    mutable,
    ...(type ? { type } : {}),
  };
}

function getTypeScriptUninitializedVariableType(
  node: ts.VariableDeclaration,
  context: LoweringContext,
): IrType | undefined {
  if (!ts.isIdentifier(node.name)) return undefined;
  const symbol = context.checker.getSymbolAtLocation(node.name);
  if (!symbol) return undefined;
  const evidence = new Map<string, IrType>();
  const visit = (candidate: ts.Node): void => {
    if (
      candidate !== node.name &&
      ts.isIdentifier(candidate) &&
      context.checker.getSymbolAtLocation(candidate) === symbol
    ) {
      const type = getTypeScriptCheckerTypeEvidence(context.checker.getTypeAtLocation(candidate), context, 0);
      if (type && type.kind !== 'unknown') evidence.set(JSON.stringify(type), type);
    }
    ts.forEachChild(candidate, visit);
  };
  visit(context.sourceFile);
  const types = [...evidence.values()];
  return types[0] ? commonType([types[0], ...types.slice(1)]) : undefined;
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

function lowerTypeScriptForOfElementType(
  expression: ts.Expression,
  context: LoweringContext,
  seen: ReadonlySet<ts.Node> = new Set(),
): IrType | undefined {
  if (seen.has(expression)) return undefined;
  const nextSeen = new Set(seen);
  nextSeen.add(expression);
  if (ts.isArrayLiteralExpression(expression)) {
    const tuple = lowerTypeScriptArrayLiteralTupleElementType(expression, context);
    if (tuple) return tuple;
    const elementTypes = expression.elements.flatMap((element): readonly IrType[] => {
      if (ts.isOmittedExpression(element)) return [];
      if (ts.isSpreadElement(element)) {
        const spreadElement = lowerTypeScriptForOfElementType(element.expression, context, nextSeen);
        return spreadElement ? [spreadElement] : [];
      }
      return [inferInitializerType(element, context)];
    });
    if (elementTypes[0]) return commonType([elementTypes[0], ...elementTypes.slice(1)]);
  }
  if (ts.isIdentifier(expression)) {
    const symbol = context.checker.getSymbolAtLocation(expression);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (declaration && ts.isVariableDeclaration(declaration) && !declaration.type && declaration.initializer) {
      const initializerElement = lowerTypeScriptForOfElementType(declaration.initializer, context, nextSeen);
      if (initializerElement) return initializerElement;
    }
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ['concat', 'filter', 'reverse', 'slice', 'sort', 'splice'].includes(expression.expression.name.text)
  ) {
    const receiverElement = lowerTypeScriptForOfElementType(expression.expression.expression, context, nextSeen);
    if (receiverElement) return receiverElement;
  }
  const collectionView = lowerTypeScriptCollectionViewElementType(expression, context);
  if (collectionView) return collectionView;
  if (
    ts.isNewExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    (expression.expression.text === 'Map' || expression.expression.text === 'Set')
  ) {
    const [firstType, secondType] = expression.typeArguments ?? [];
    if (expression.expression.text === 'Set' && firstType) return lowerType(firstType, context);
    if (expression.expression.text === 'Map' && firstType && secondType) {
      return {
        elements: [firstType, secondType].map((type) => ({
          optional: false,
          rest: false,
          type: lowerType(type, context),
        })),
        kind: 'tuple',
        readonly: true,
      };
    }
    const argument = expression.arguments?.[0];
    if (argument) return lowerTypeScriptForOfElementType(argument, context, nextSeen);
  }
  const ambientCallElement = lowerTypeScriptAmbientCallArrayElementType(expression, context);
  if (ambientCallElement) return ambientCallElement;
  if (ts.isCallExpression(expression)) {
    const signature = context.checker.getResolvedSignature(expression);
    const resultType = signature ? context.checker.getReturnTypeOfSignature(signature) : undefined;
    const result = resultType ? getTypeScriptCheckerTypeEvidence(resultType, context, 0, true, expression) : undefined;
    const element = getIrTypeIndexedElementEvidence(result, undefined);
    if (element) return element;
  }
  const iterableType = getTypeScriptSyntacticExpressionTypeEvidence(expression, context.checker);
  if (!iterableType) return getTypeScriptForOfBindingElementType(expression, context);
  const element = getTypeScriptTypeNodeIterableElementEvidence(iterableType, context, new Set());
  if (!element) return getTypeScriptForOfBindingElementType(expression, context);
  if ('key' in element) {
    return {
      elements: [
        {
          optional: false,
          rest: false,
          type: lowerTypeScriptTypeNodeEvidence(element.key, context, new Set(), element.substitutions),
        },
        {
          optional: false,
          rest: false,
          type: lowerTypeScriptTypeNodeEvidence(element.value, context, new Set(), element.substitutions),
        },
      ],
      kind: 'tuple',
      readonly: true,
    };
  }
  // Preserve the written identity of directly exposed interfaces/classes. Expanding an interface
  // into an anonymous structural object here loses the fact that `for (const item of items: Item[])`
  // produces an Item. Aliases and substituted parameters still take the evidence path so tuple and
  // generic iterable elements retain their concrete shapes.
  if (element.substitutions.size === 0 && ts.isTypeReferenceNode(element.type)) {
    const unresolved = context.checker.getSymbolAtLocation(element.type.typeName);
    const symbol =
      unresolved?.flags && unresolved.flags & ts.SymbolFlags.Alias
        ? context.checker.getAliasedSymbol(unresolved)
        : unresolved;
    if (
      symbol?.declarations?.some(
        (declaration) => ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration),
      )
    ) {
      return lowerType(element.type, context);
    }
  }
  if (ts.isTypeReferenceNode(element.type)) {
    const unresolved = context.checker.getSymbolAtLocation(element.type.typeName);
    const symbol =
      unresolved?.flags && unresolved.flags & ts.SymbolFlags.Alias
        ? context.checker.getAliasedSymbol(unresolved)
        : unresolved;
    const declaration = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
    if (symbol && declaration) {
      if (!context.analysisModuleOptions.has(declaration.getSourceFile().fileName)) {
        return lowerTypeScriptTypeNodeEvidence(element.type, context, new Set(), element.substitutions);
      }
      const substitutions = createTypeScriptSyntacticAliasSubstitutions(
        element.type,
        declaration,
        context.checker,
        element.substitutions,
      );
      if (substitutions) {
        return lowerTypeScriptTypeNodeEvidence(declaration.type, context, new Set([symbol]), substitutions);
      }
    }
  }
  return lowerTypeScriptTypeNodeEvidence(element.type, context, new Set(), element.substitutions);
}

function getTypeScriptForOfBindingElementType(expression: ts.Expression, context: LoweringContext): IrType | undefined {
  const bindingType = getTypeScriptExpressionBindingTypeEvidence(expression, context);
  return (
    getIrTypeIndexedElementEvidence(bindingType, undefined) ??
    getIrTypeIndexedElementEvidence(getIrTypeConstructionTargetShape(bindingType, context), undefined)
  );
}

function lowerTypeScriptAmbientCallArrayElementType(
  expression: ts.Expression,
  context: LoweringContext,
): IrType | undefined {
  if (!ts.isCallExpression(expression)) return undefined;
  const declaration = context.checker.getResolvedSignature(expression)?.declaration;
  // The written return node belongs to the ambient surface and may contain surface-owned type
  // parameters. Its checker result is the scoped call-site evidence: materialize only a proven
  // array element, leaving non-array and still-unresolved calls for the normal syntactic path.
  if (declaration?.getSourceFile().fileName !== getCompilerAmbientSurfaceFileName()) return undefined;
  const type = context.checker.getTypeAtLocation(expression);
  if (!context.checker.isArrayType(type)) return undefined;
  const element = context.checker.getTypeArguments(type as ts.TypeReference)[0];
  return element ? getTypeScriptCheckerTypeEvidence(element, context, 0, true) : undefined;
}

function lowerTypeScriptCollectionViewElementType(
  expression: ts.Expression,
  context: LoweringContext,
): IrType | undefined {
  if (
    !ts.isCallExpression(expression) ||
    expression.arguments.length !== 0 ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    !['entries', 'keys', 'values'].includes(expression.expression.name.text)
  ) {
    return undefined;
  }
  const receiverType = getTypeScriptSyntacticExpressionTypeEvidence(expression.expression.expression, context.checker);
  if (!receiverType) return undefined;
  const element = getTypeScriptTypeNodeIterableElementEvidence(receiverType, context, new Set());
  if (!element) return undefined;
  const projection = expression.expression.name.text;
  if ('key' in element) {
    const key = lowerTypeScriptTypeNodeEvidence(element.key, context, new Set(), element.substitutions);
    const value = lowerTypeScriptTypeNodeEvidence(element.value, context, new Set(), element.substitutions);
    return projection === 'entries'
      ? {
          elements: [key, value].map((type) => ({ optional: false, rest: false, type })),
          kind: 'tuple',
          readonly: true,
        }
      : projection === 'keys'
        ? key
        : value;
  }
  const value = lowerTypeScriptTypeNodeEvidence(element.type, context, new Set(), element.substitutions);
  return projection === 'entries'
    ? {
        elements: [value, value].map((type) => ({ optional: false, rest: false, type })),
        kind: 'tuple',
        readonly: true,
      }
    : value;
}

function lowerTypeScriptArrayLiteralTupleElementType(
  expression: ts.ArrayLiteralExpression,
  context: LoweringContext,
): Extract<IrType, { kind: 'tuple' }> | undefined {
  if (expression.elements.length === 0) return undefined;
  const rows = expression.elements.flatMap((element): ts.ArrayLiteralExpression[] => {
    if (ts.isSpreadElement(element) || !ts.isArrayLiteralExpression(element)) return [];
    if (element.elements.some((value) => ts.isOmittedExpression(value) || ts.isSpreadElement(value))) return [];
    return [element];
  });
  if (rows.length !== expression.elements.length || !rows[0]) return undefined;
  const width = rows[0].elements.length;
  if (width === 0 || rows.some((row) => row.elements.length !== width)) return undefined;
  return {
    elements: Array.from({ length: width }, (_, index): IrTupleTypeElement => {
      const types = rows.map((row) => inferInitializerType(row.elements[index]! as ts.Expression, context));
      return {
        optional: false,
        rest: false,
        type: commonType([types[0]!, ...types.slice(1)]),
      };
    }),
    kind: 'tuple',
    readonly: false,
  };
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
  // nothing in the module being lowered. The same is true of a generic callee's raw return syntax:
  // its type parameters belong to the callee, while the call site needs the checker's instantiation.
  // Whatever path reached either form, it stops here.
  if (
    !type ||
    type.getSourceFile().fileName === getCompilerAmbientSurfaceFileName() ||
    hasExternalTypeScriptTypeParameter(type, context)
  ) {
    return undefined;
  }
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

interface TypeScriptMapElementEvidence {
  readonly key: ts.TypeNode;
  readonly substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>;
  readonly value: ts.TypeNode;
}

function getTypeScriptTypeNodeIterableElementEvidence(
  type: ts.TypeNode,
  context: LoweringContext,
  seen: ReadonlySet<ts.Symbol>,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode> = new Map(),
): TypeScriptTypeNodeEvidence | TypeScriptMapElementEvidence | undefined {
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
    if (
      ['Array', 'Iterable', 'IterableIterator', 'ReadonlyArray', 'ReadonlySet', 'Set'].includes(name ?? '') &&
      type.typeArguments?.length === 1 &&
      element
    ) {
      return { substitutions, type: element };
    }
    if (
      (name === 'Map' || name === 'ReadonlyMap') &&
      type.typeArguments?.length === 2 &&
      type.typeArguments[0] &&
      type.typeArguments[1]
    ) {
      return { key: type.typeArguments[0], substitutions, value: type.typeArguments[1] };
    }
    const unresolved = context.checker.getSymbolAtLocation(type.typeName);
    const symbol =
      unresolved?.flags && unresolved.flags & ts.SymbolFlags.Alias
        ? context.checker.getAliasedSymbol(unresolved)
        : unresolved;
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
  if (ts.isConditionalTypeNode(type)) {
    const conditional = lowerConcreteTypeScriptConditionalTypeEvidence(type, context, seen, substitutions);
    if (conditional) return conditional;
    const conditionalFacet = lowerOpenTypeScriptConditionalFacetEvidence(type, context, substitutions);
    if (conditionalFacet) return conditionalFacet;
  }
  if (ts.isTypeReferenceNode(type)) {
    const mapped = lowerConcreteTypeScriptMappedAliasReference(type, context);
    if (mapped) return mapped;
    const conditional = lowerConcreteTypeScriptConditionalAliasReference(type, context);
    if (conditional) return conditional;
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
    if (isTypeScriptAmbientSymbol(symbol, context)) {
      const reference = lowerTypeNameReference(type.typeName, context);
      if (!reference) return { kind: 'unknown', source: 'unknown' };
      return {
        kind: 'named',
        reference,
        typeArguments:
          type.typeArguments?.map((argument) =>
            lowerTypeScriptTypeNodeEvidence(argument, context, seen, substitutions),
          ) ?? [],
      };
    }
    // A failed concrete expansion of an authored mapped/conditional alias must not then open the
    // declaration without its instantiation and report the helper syntax itself. Preserve the named
    // alias instead: targets can represent an opaque generic boundary, while the successful paths
    // above still materialize every shape for which the checker supplied closed evidence.
    if (
      declaration &&
      ts.isTypeAliasDeclaration(declaration) &&
      (ts.isMappedTypeNode(declaration.type) || ts.isConditionalTypeNode(declaration.type))
    ) {
      return lowerType(type, context);
    }
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
    const reference = lowerTypeNameReference(type.typeName, context);
    if (!reference) return { kind: 'unknown', source: 'unknown' };
    return {
      kind: 'named',
      reference,
      typeArguments:
        type.typeArguments?.map((argument) =>
          lowerTypeScriptTypeNodeEvidence(argument, context, seen, substitutions),
        ) ?? [],
    };
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

// Checker evidence frequently reaches an imported mapped helper through a contextual object type.
// The authored type reference has already instantiated the helper, so query that instantiated shape
// before recursively opening the alias declaration and losing its substitutions.
function lowerConcreteTypeScriptMappedAliasReference(
  node: ts.TypeReferenceNode,
  context: LoweringContext,
): Readonly<Extract<IrType, { kind: 'object' }>> | undefined {
  // Built-in utilities have explicit neutral representations. Expanding TypeScript's library aliases
  // here would erase nominal member identities that a barrel must introduce into the current module.
  if (
    hasExternalTypeScriptTypeParameter(node, context) ||
    (ts.isIdentifier(node.typeName) &&
      ['Omit', 'Partial', 'Pick', 'Readonly', 'Record', 'Required'].includes(node.typeName.text))
  ) {
    return undefined;
  }
  const unresolved = context.checker.getSymbolAtLocation(node.typeName);
  const symbol = unresolved ? (resolveTypeBindingAliasTarget(unresolved, context) ?? unresolved) : undefined;
  const declaration = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
  if (!declaration || !ts.isMappedTypeNode(declaration.type)) return undefined;
  let properties: readonly IrObjectTypeProperty[] | undefined;
  try {
    properties = lowerTypeScriptCheckerObjectProperties(
      context.checker.getTypeFromTypeNode(node),
      context,
      0,
      declaration.type,
    );
  } catch (error) {
    if (isUnsupportedSyntaxFailure(error)) return undefined;
    throw error;
  }
  return properties ? { kind: 'object', properties } : undefined;
}

function lowerConcreteTypeScriptConditionalTypeEvidence(
  node: ts.ConditionalTypeNode,
  context: LoweringContext,
  seen: ReadonlySet<ts.Symbol>,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>,
): IrType | undefined {
  const checkType = getTypeScriptSyntacticTypeSubstitution(node.checkType, context.checker, substitutions);
  const extendsType = getTypeScriptSyntacticTypeSubstitution(node.extendsType, context.checker, substitutions);
  if (
    hasExternalTypeScriptTypeParameter(checkType, context) ||
    hasExternalTypeScriptTypeParameter(extendsType, context)
  ) {
    return undefined;
  }
  const selected = context.checker.isTypeAssignableTo(
    context.checker.getTypeFromTypeNode(checkType),
    context.checker.getTypeFromTypeNode(extendsType),
  )
    ? node.trueType
    : node.falseType;
  return lowerTypeScriptTypeNodeEvidence(selected, context, seen, substitutions);
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
  // Conflicting inherited branches are ambiguous and remain a refusal. An authored member is the
  // interface's selected view of that slot, however, so it replaces the inherited representation;
  // this is how a derived Entity narrows its runtime slot from EntityRuntime to NodeRuntime.
  const mergeProperty = (property: IrObjectTypeProperty, node: ts.Node, authoredOverride = false): void => {
    const index = properties.findIndex((candidate) => candidate.name === property.name);
    if (index < 0) {
      properties.push(property);
      return;
    }
    if (!authoredOverride && JSON.stringify(properties[index]) !== JSON.stringify(property)) {
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
      const base = symbol?.declarations?.find(
        (candidate): candidate is ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
          ts.isClassDeclaration(candidate) ||
          ts.isInterfaceDeclaration(candidate) ||
          ts.isTypeAliasDeclaration(candidate),
      );
      if (!symbol || !base || isTypeScriptAmbientSymbol(symbol, context)) {
        const utilityProperties = lowerTypeScriptUnresolvedUtilityHeritageProperties(
          heritage,
          context,
          seen,
          substitutions,
        );
        if (!utilityProperties) {
          const external = lowerTypeNameNodeReference(heritage.expression, context);
          if (external?.kind === 'ambient') continue;
          unsupported(heritage, 'syntactic interface heritage requires an object type declaration');
        }
        utilityProperties.forEach((property) => mergeProperty(property, heritage));
        continue;
      }
      const baseName = base.name?.text ?? '<anonymous-class>';
      if (seen.has(symbol)) unsupported(heritage, `interface ${declaration.name.text} has cyclic heritage`);
      const nextSubstitutions = createTypeScriptSyntacticDeclarationSubstitutions(
        heritage,
        base,
        context.checker,
        substitutions,
      );
      if (!nextSubstitutions) {
        unsupported(heritage, `interface ${baseName} heritage type arguments cannot be substituted`);
      }
      const nextSeen = new Set(seen);
      nextSeen.add(symbol);
      const inherited = ts.isInterfaceDeclaration(base)
        ? lowerTypeScriptInterfacePropertiesEvidence(base, context, nextSeen, nextSubstitutions)
        : ts.isClassDeclaration(base)
          ? lowerTypeScriptClassPropertiesEvidence(base, context, nextSeen, nextSubstitutions)
          : lowerTypeScriptHeritageTypeNodeProperties(base.type, context, nextSeen, nextSubstitutions);
      if (!inherited) unsupported(heritage, `interface heritage type alias ${baseName} is not object-shaped`);
      inherited.forEach((property) => mergeProperty(property, heritage));
    }
  }
  lowerTypeScriptTypePropertiesEvidence(declaration.members, context, seen, substitutions).forEach((property) =>
    mergeProperty(property, declaration, true),
  );
  return properties;
}

function lowerTypeScriptUnresolvedUtilityHeritageProperties(
  heritage: ts.ExpressionWithTypeArguments,
  context: LoweringContext,
  seen: ReadonlySet<ts.Symbol>,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>,
): readonly IrObjectTypeProperty[] | undefined {
  if (!ts.isIdentifier(heritage.expression)) return undefined;
  const arguments_ = heritage.typeArguments ?? [];
  if (heritage.expression.text === 'Pick' && arguments_.length === 2) {
    const keys =
      getTypeScriptStringLiteralTypeValues(arguments_[1]!, context, new Set()) ??
      getTypeScriptCheckerStringLiteralTypeValues(arguments_[1]!, context);
    if (!keys) unsupported(heritage, 'Pick heritage requires a closed set of string literal keys');
    const inherited = lowerTypeScriptHeritageTypeNodeProperties(arguments_[0]!, context, seen, substitutions);
    return keys.map(
      (name) =>
        inherited?.find((property) => property.name === name) ?? {
          name,
          optional: false,
          readonly: false,
          type: { kind: 'unknown', source: 'any' },
        },
    );
  }
  if (
    (heritage.expression.text === 'Partial' ||
      heritage.expression.text === 'Readonly' ||
      heritage.expression.text === 'Required') &&
    arguments_.length === 1
  ) {
    const inherited = lowerTypeScriptHeritageTypeNodeProperties(arguments_[0]!, context, seen, substitutions);
    if (!inherited) return undefined;
    if (heritage.expression.text === 'Partial') {
      return inherited.map((property) => ({ ...property, optional: true }));
    }
    if (heritage.expression.text === 'Readonly') {
      return inherited.map((property) => ({ ...property, readonly: true }));
    }
    return inherited.map((property) => ({ ...property, optional: false }));
  }
  if (heritage.expression.text !== 'ReturnType' || arguments_.length !== 1) return undefined;
  const query = arguments_[0]!;
  if (!ts.isTypeQueryNode(query)) unsupported(heritage, 'ReturnType heritage requires a type query');
  const unresolved = context.checker.getSymbolAtLocation(query.exprName);
  const symbol =
    unresolved?.flags && unresolved.flags & ts.SymbolFlags.Alias
      ? context.checker.getAliasedSymbol(unresolved)
      : unresolved;
  const declaration = symbol?.declarations?.find(
    (candidate): candidate is ts.FunctionDeclaration | ts.FunctionExpression | ts.MethodDeclaration =>
      (ts.isFunctionDeclaration(candidate) ||
        ts.isFunctionExpression(candidate) ||
        ts.isMethodDeclaration(candidate)) &&
      candidate.type !== undefined,
  );
  if (!symbol || !declaration?.type) {
    unsupported(heritage, 'ReturnType heritage requires a function with an explicit object return type');
  }
  const declarationSource = declaration.getSourceFile();
  const declarationOptions = context.analysisModuleOptions.get(declarationSource.fileName);
  const declarationContext = declarationOptions
    ? { ...context, options: declarationOptions, sourceFile: declarationSource }
    : context;
  const inherited = lowerTypeScriptHeritageTypeNodeProperties(
    declaration.type,
    declarationContext,
    seen,
    substitutions,
  );
  if (!inherited) unsupported(heritage, 'ReturnType heritage function must return an object-shaped type');
  return inherited;
}

function lowerTypeScriptHeritageTypeNodeProperties(
  type: ts.TypeNode,
  context: LoweringContext,
  seen: ReadonlySet<ts.Symbol>,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>,
): readonly IrObjectTypeProperty[] | undefined {
  const substituted = getTypeScriptSyntacticTypeSubstitution(type, context.checker, substitutions);
  if (substituted !== type) {
    return lowerTypeScriptHeritageTypeNodeProperties(substituted, context, seen, substitutions);
  }
  if (ts.isParenthesizedTypeNode(type)) {
    return lowerTypeScriptHeritageTypeNodeProperties(type.type, context, seen, substitutions);
  }
  if (ts.isIntersectionTypeNode(type)) {
    const properties: IrObjectTypeProperty[] = [];
    for (const member of type.types) {
      const inherited = lowerTypeScriptHeritageTypeNodeProperties(member, context, seen, substitutions);
      if (!inherited) return undefined;
      for (const property of inherited) {
        const existing = properties.find((candidate) => candidate.name === property.name);
        if (!existing) properties.push(property);
        else if (JSON.stringify(existing) !== JSON.stringify(property)) {
          const checkerType = context.checker.getTypeFromTypeNode(type);
          const checkerProperty =
            context.checker.getPropertyOfType(checkerType, property.name) ??
            context.checker.getPropertiesOfType(checkerType).find((candidate) =>
              candidate.declarations?.some((declaration) => {
                const name = ts.getNameOfDeclaration(declaration);
                return (
                  name !== undefined &&
                  ts.isComputedPropertyName(name) &&
                  getTypeScriptNodeText(name.expression, context).replaceAll('.', '_') === property.name
                );
              }),
            );
          if (!checkerProperty) return undefined;
          const checkerPropertyType = context.checker.getTypeOfSymbolAtLocation(checkerProperty, type);
          if (checkerPropertyType.flags & ts.TypeFlags.Never) return undefined;
          const lowered = lowerTypeScriptCheckerPropertyType(
            checkerPropertyType,
            Boolean(checkerProperty.flags & ts.SymbolFlags.Optional),
            context,
            0,
          );
          if (!lowered) return undefined;
          properties[properties.indexOf(existing)] = {
            ...property,
            optional: Boolean(checkerProperty.flags & ts.SymbolFlags.Optional),
            readonly: getTypeScriptCheckerPropertyReadonly(checkerProperty),
            type: lowered,
          };
        }
      }
    }
    return properties;
  }
  if (ts.isTypeReferenceNode(type)) {
    const utility = ts.isIdentifier(type.typeName) ? type.typeName.text : undefined;
    const subject = type.typeArguments?.[0];
    if (subject && ['Omit', 'Partial', 'Pick', 'Readonly', 'Required'].includes(utility ?? '')) {
      const properties = lowerTypeScriptHeritageTypeNodeProperties(subject, context, seen, substitutions);
      if (!properties) return undefined;
      if (utility === 'Pick' || utility === 'Omit') {
        const keysType = type.typeArguments?.[1];
        const keys = keysType
          ? (getTypeScriptStringLiteralTypeValues(keysType, context, new Set()) ??
            getTypeScriptCheckerStringLiteralTypeValues(keysType, context))
          : undefined;
        if (!keys) return undefined;
        const available = new Set(properties.map((property) => property.name));
        if (keys.some((key) => !available.has(key))) return undefined;
        const selected = new Set(keys);
        return properties.filter((property) => (utility === 'Pick') === selected.has(property.name));
      }
      if (type.typeArguments?.length !== 1) return undefined;
      if (utility === 'Partial') return properties.map((property) => ({ ...property, optional: true }));
      if (utility === 'Readonly') return properties.map((property) => ({ ...property, readonly: true }));
      if (utility === 'Required') return properties.map((property) => ({ ...property, optional: false }));
    }
    const unresolved = context.checker.getSymbolAtLocation(type.typeName);
    const symbol =
      unresolved?.flags && unresolved.flags & ts.SymbolFlags.Alias
        ? context.checker.getAliasedSymbol(unresolved)
        : unresolved;
    const declaration = symbol?.declarations?.find(
      (candidate): candidate is ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
        ts.isClassDeclaration(candidate) ||
        ts.isInterfaceDeclaration(candidate) ||
        ts.isTypeAliasDeclaration(candidate),
    );
    if (symbol && declaration && !seen.has(symbol)) {
      const nextSubstitutions = createTypeScriptSyntacticDeclarationSubstitutions(
        type,
        declaration,
        context.checker,
        substitutions,
      );
      if (!nextSubstitutions) return undefined;
      const nextSeen = new Set(seen);
      nextSeen.add(symbol);
      if (ts.isInterfaceDeclaration(declaration)) {
        return lowerTypeScriptInterfacePropertiesEvidence(declaration, context, nextSeen, nextSubstitutions);
      }
      if (ts.isClassDeclaration(declaration)) {
        return lowerTypeScriptClassPropertiesEvidence(declaration, context, nextSeen, nextSubstitutions);
      }
      return lowerTypeScriptHeritageTypeNodeProperties(declaration.type, context, nextSeen, nextSubstitutions);
    }
  }
  return getTypeScriptHeritageObjectProperties(lowerTypeScriptTypeNodeEvidence(type, context, seen, substitutions));
}

function getTypeScriptStringLiteralTypeValues(
  type: ts.TypeNode,
  context: LoweringContext,
  seen: ReadonlySet<ts.Symbol>,
): readonly string[] | undefined {
  if (ts.isParenthesizedTypeNode(type)) return getTypeScriptStringLiteralTypeValues(type.type, context, seen);
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return [type.literal.text];
  if (ts.isUnionTypeNode(type)) {
    const values = type.types.flatMap((member) => getTypeScriptStringLiteralTypeValues(member, context, seen) ?? []);
    return values.length === type.types.length ? [...new Set(values)] : undefined;
  }
  if (!ts.isTypeReferenceNode(type)) return undefined;
  const unresolved = context.checker.getSymbolAtLocation(type.typeName);
  const symbol =
    unresolved?.flags && unresolved.flags & ts.SymbolFlags.Alias
      ? context.checker.getAliasedSymbol(unresolved)
      : unresolved;
  const declaration = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
  if (!symbol || !declaration || seen.has(symbol)) return undefined;
  return getTypeScriptStringLiteralTypeValues(declaration.type, context, new Set(seen).add(symbol));
}

function getTypeScriptCheckerStringLiteralTypeValues(
  node: ts.TypeNode,
  context: LoweringContext,
): readonly string[] | undefined {
  const type = context.checker.getTypeFromTypeNode(node);
  const members = type.isUnion() ? type.types : [type];
  if (members.some((member) => !(member.flags & ts.TypeFlags.StringLiteral))) return undefined;
  return [...new Set(members.map((member) => (member as ts.StringLiteralType).value))];
}

function lowerTypeScriptClassPropertiesEvidence(
  declaration: ts.ClassDeclaration,
  context: LoweringContext,
  _seen: ReadonlySet<ts.Symbol>,
  substitutions: ReadonlyMap<ts.Symbol, ts.TypeNode>,
): readonly IrObjectTypeProperty[] {
  const properties: IrObjectTypeProperty[] = [];
  const methodNames = new Set<string>();
  for (const member of declaration.members) {
    if (
      hasModifier(member, ts.SyntaxKind.StaticKeyword) ||
      hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
      hasModifier(member, ts.SyntaxKind.ProtectedKeyword) ||
      ts.isConstructorDeclaration(member)
    ) {
      continue;
    }
    if (ts.isPropertyDeclaration(member)) {
      if (!member.type && !member.initializer)
        unsupported(member, 'class heritage field requires a type or initializer');
      properties.push({
        name: propertyName(member.name, context),
        optional: member.questionToken !== undefined,
        readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
        type: member.type
          ? lowerTypeScriptTypeNodeEvidence(member.type, context, new Set(), substitutions)
          : inferInitializerType(member.initializer!, context),
      });
      continue;
    }
    if (ts.isMethodDeclaration(member)) {
      const name = propertyName(member.name, context);
      if (methodNames.has(name)) continue;
      methodNames.add(name);
      const methods = declaration.members.filter(
        (candidate): candidate is ts.MethodDeclaration =>
          ts.isMethodDeclaration(candidate) &&
          !hasModifier(candidate, ts.SyntaxKind.StaticKeyword) &&
          !hasModifier(candidate, ts.SyntaxKind.PrivateKeyword) &&
          !hasModifier(candidate, ts.SyntaxKind.ProtectedKeyword) &&
          propertyName(candidate.name, context) === name,
      );
      const types = methods.map((method) =>
        lowerTypeScriptFunctionTypeEvidence(method, context, new Set(), substitutions),
      );
      const [first, second, ...rest] = types;
      properties.push({
        name,
        optional: member.questionToken !== undefined,
        readonly: true,
        type: first && second ? { kind: 'intersection', types: [first, second, ...rest] } : first!,
      });
      continue;
    }
    if (ts.isGetAccessorDeclaration(member) && member.type) {
      properties.push({
        name: propertyName(member.name, context),
        optional: false,
        readonly: true,
        type: lowerTypeScriptTypeNodeEvidence(member.type, context, new Set(), substitutions),
      });
    }
  }
  return properties;
}

function getTypeScriptHeritageObjectProperties(type: Readonly<IrType>): readonly IrObjectTypeProperty[] | undefined {
  if (type.kind === 'object') return type.properties;
  if (type.kind !== 'intersection') return undefined;
  const properties: IrObjectTypeProperty[] = [];
  for (const member of type.types) {
    const inherited = getTypeScriptHeritageObjectProperties(member);
    if (!inherited) return undefined;
    for (const property of inherited) {
      const existing = properties.find((candidate) => candidate.name === property.name);
      if (!existing) properties.push(property);
      else if (JSON.stringify(existing) !== JSON.stringify(property)) return undefined;
    }
  }
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
    const elementType =
      sourceType?.kind === 'tuple'
        ? sourceType.elements[index]?.type
        : sourceType?.kind === 'array'
          ? sourceType.element
          : undefined;
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
  if (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) {
    return inferInitializerType(node.expression, context);
  }
  if (isTypeScriptConstAssertion(node)) return inferInitializerType(node.expression, context);
  if (ts.isNonNullExpression(node)) {
    return (
      removeIrTypeAbsentMembersSemantic(inferInitializerType(node.expression, context)) ?? {
        kind: 'never',
      }
    );
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return lowerType(node.type, context);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: 'primitive', name: 'boolean' };
  }
  if (ts.isNumericLiteral(node)) return { kind: 'primitive', name: 'number' };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: 'null' };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { kind: 'primitive', name: 'string' };
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    const left = removeIrTypeAbsentMembersSemantic(inferInitializerType(node.left, context));
    const right = inferInitializerType(node.right, context);
    return left ? commonType([left, right]) : right;
  }
  if (ts.isCallExpression(node)) {
    const signature = getTypeScriptInvocationSignatureResolution(node, context.checker);
    const callResult =
      getTypeScriptKnownAmbientCallResultTypeEvidence(node, context) ??
      getTypeScriptCollectionCallResultTypeEvidence(node, context) ??
      getTypeScriptInstantiatedCallResultTypeEvidence(node, signature, context) ??
      getTypeScriptWrittenCallResultTypeEvidence(signature, context) ??
      getTypeScriptCheckerTypeEvidence(context.checker.getTypeAtLocation(node), context, 0, true, node);
    if (callResult) return callResult;
  }
  const writtenConstruction = getTypeScriptWrittenNewExpressionTypeEvidence(node, context);
  if (writtenConstruction) return writtenConstruction;
  if (ts.isArrayLiteralExpression(node)) {
    const elementTypes = node.elements.flatMap((element) => {
      if (ts.isOmittedExpression(element)) return [];
      if (ts.isSpreadElement(element)) {
        const iterableElement = lowerTypeScriptForOfElementType(element.expression, context);
        return iterableElement ? [iterableElement] : [];
      }
      return [inferInitializerType(element, context)];
    });
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
      if (ts.isSpreadAssignment(member)) {
        const spreadType =
          getTypeScriptExpressionBindingTypeEvidence(member.expression, context) ??
          lowerTypeScriptExpressionTypeEvidence(member.expression, context);
        const spreadShape = getIrTypeConstructionTargetShape(spreadType, context);
        if (spreadShape?.kind !== 'object') return { kind: 'unknown', source: 'object' };
        for (const property of spreadShape.properties) properties.set(property.name, { ...property, readonly: false });
        continue;
      }
      if (ts.isComputedPropertyName(member.name)) return { kind: 'unknown', source: 'object' };
      const name = propertyName(member.name, context);
      const type = ts.isShorthandPropertyAssignment(member)
        ? inferInitializerType(member.name, context)
        : ts.isPropertyAssignment(member)
          ? inferInitializerType(member.initializer, context)
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
  // An identifier can carry a narrower flow type than its declaration. Read that proof before the
  // syntactic declaration evidence so `if (tuple === null) return; const [a] = tuple` reaches the
  // binding-pattern pass as a tuple rather than as the original tuple-or-null union.
  if (ts.isIdentifier(node)) {
    const declared = getTypeScriptExpressionDeclaredType(node, context);
    const flow = context.checker.getTypeAtLocation(node);
    if (declared && context.checker.typeToString(flow) !== context.checker.typeToString(declared)) {
      const narrowed = getTypeScriptCheckerTypeEvidence(flow, context, 0);
      if (narrowed) return narrowed;
    }
    // Binding-pattern lowering can prove a type that the deliberately small ambient surface cannot
    // reconstruct through the checker. Preserve that proof when the binding is used to infer an
    // anonymous object literal, as in a mapped tuple becoming `{ start, end, delta }`.
    const bindingType = getTypeScriptExpressionBindingTypeEvidence(node, context);
    if (bindingType) return bindingType;
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const bindingType = getTypeScriptExpressionBindingTypeEvidence(node, context);
    if (bindingType) return bindingType;
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

function getTypeScriptWrittenNewExpressionTypeEvidence(
  node: ts.Expression,
  context: LoweringContext,
): Readonly<Extract<IrType, { kind: 'named' }>> | undefined {
  if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression) || !node.typeArguments?.length) return undefined;
  const reference = lowerIdentifierReference(node.expression, context);
  if (reference.kind === 'super' || reference.kind === 'this') return undefined;
  return {
    kind: 'named',
    reference: reference.kind === 'binding' ? { ...reference, path: [] } : reference,
    typeArguments: node.typeArguments.map((type) => lowerTypeScriptTypeNodeEvidence(type, context)),
  };
}

function isTypeScriptConstAssertion(node: ts.Expression): node is ts.AsExpression | ts.TypeAssertion {
  if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) return false;
  return (
    ts.isTypeReferenceNode(node.type) &&
    ts.isIdentifier(node.type.typeName) &&
    node.type.typeName.text === 'const' &&
    !node.type.typeArguments
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
  const unionMemberTest = getTypeScriptUnionMemberTestEvidence(node, context);
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
    ...(unionMemberTest ? { unionMemberTest } : {}),
  };
}

function getTypeScriptUnionMemberTestEvidence(
  node: ts.BinaryExpression,
  context: LoweringContext,
): IrUnionMemberTestEvidence | undefined {
  if (node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
    return getTypeScriptInstanceofUnionMemberTestEvidence(node.left, node.right, context);
  }
  const whenResult =
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
    node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      ? true
      : node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
        ? false
        : undefined;
  if (whenResult === undefined) return undefined;
  return (
    getTypeScriptTypeofUnionMemberTestEvidence(node.left, node.right, whenResult, context) ??
    getTypeScriptTypeofUnionMemberTestEvidence(node.right, node.left, whenResult, context) ??
    getTypeScriptDiscriminantUnionMemberTestEvidence(node.left, node.right, whenResult, context) ??
    getTypeScriptDiscriminantUnionMemberTestEvidence(node.right, node.left, whenResult, context)
  );
}

function getTypeScriptInstanceofUnionMemberTestEvidence(
  test: ts.Expression,
  constructor: ts.Expression,
  context: LoweringContext,
): IrUnionMemberTestEvidence | undefined {
  const subject = unwrapTypeScriptParenthesizedExpression(test);
  if (!ts.isIdentifier(subject)) return undefined;
  const source = getTypeScriptUnionBindingEvidence(subject, context);
  if (!source) return undefined;
  const constructorName = ts.isIdentifier(constructor) ? constructor.text : undefined;
  if (!constructorName) return undefined;
  const members = source.type.types.filter(
    (member) => getTypeScriptInstanceofIrTypeName(member, context) === constructorName,
  );
  if (members.length !== 1) return undefined;
  return { binding: source.binding, member: members[0]!, whenResult: true };
}

function getTypeScriptInstanceofIrTypeName(type: Readonly<IrType>, context: LoweringContext): string | undefined {
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    (type.reference.name === 'Readonly' || type.reference.name === 'Required') &&
    type.typeArguments.length === 1 &&
    type.typeArguments[0]
  ) {
    return getTypeScriptInstanceofIrTypeName(type.typeArguments[0], context);
  }
  const resolved = getIrTypeConstructionTargetShape(type, context);
  if (resolved && resolved !== type) return getTypeScriptInstanceofIrTypeName(resolved, context);
  return type.kind === 'named' && type.reference.kind === 'ambient' ? type.reference.name : undefined;
}

function getTypeScriptTypeofUnionMemberTestEvidence(
  test: ts.Expression,
  expected: ts.Expression,
  whenResult: boolean,
  context: LoweringContext,
): IrUnionMemberTestEvidence | undefined {
  if (!ts.isTypeOfExpression(test) || !ts.isStringLiteralLike(expected)) return undefined;
  const subject = unwrapTypeScriptParenthesizedExpression(test.expression);
  if (!ts.isIdentifier(subject)) return undefined;
  const source = getTypeScriptUnionBindingEvidence(subject, context);
  if (!source) return undefined;
  const members = source.type.types.filter((member) => getIrTypeTypeofName(member) === expected.text);
  if (members.length !== 1) return undefined;
  return { binding: source.binding, member: members[0]!, whenResult };
}

function getIrTypeTypeofName(type: Readonly<IrType>): string | undefined {
  if (type.kind === 'primitive') return type.name === 'void' ? 'undefined' : type.name;
  if (type.kind === 'literal') return typeof type.value;
  if (type.kind === 'function') return 'function';
  if (type.kind === 'undefined') return 'undefined';
  if (type.kind === 'null') return 'object';
  if (type.kind === 'array' || type.kind === 'object' || type.kind === 'tuple') return 'object';
  if (type.kind === 'named' && type.reference.kind === 'ambient') return 'object';
  return undefined;
}

function getTypeScriptDiscriminantUnionMemberTestEvidence(
  test: ts.Expression,
  expected: ts.Expression,
  whenResult: boolean,
  context: LoweringContext,
): IrUnionMemberTestEvidence | undefined {
  const literal = getTypeScriptLiteralExpressionValue(expected);
  if (literal === undefined || !ts.isPropertyAccessExpression(test) || test.questionDotToken) return undefined;
  const subject = unwrapTypeScriptParenthesizedExpression(test.expression);
  if (!ts.isIdentifier(subject)) return undefined;
  const source = getTypeScriptUnionBindingEvidence(subject, context);
  if (!source) return undefined;
  const members: IrType[] = [];
  for (const member of source.type.types) {
    const shape = getIrTypeConstructionTargetShape(member, context);
    const property =
      shape?.kind === 'object' ? shape.properties.find((candidate) => candidate.name === test.name.text) : undefined;
    const propertyValue = property?.type.kind === 'literal' ? property.type.value : undefined;
    if (propertyValue === undefined) return undefined;
    if (Object.is(propertyValue, literal)) members.push(member);
  }
  if (members.length !== 1) return undefined;
  return { binding: source.binding, member: members[0]!, whenResult };
}

function getTypeScriptUnionBindingEvidence(
  node: ts.Identifier,
  context: LoweringContext,
): Readonly<{ binding: IrBindingIdentity; type: Extract<IrType, { kind: 'union' }> }> | undefined {
  const symbol = context.checker.getSymbolAtLocation(node);
  const declared = symbol ? context.bindingTypes.get(symbol) : undefined;
  const members = declared ? getTypeScriptNarrowingAlternatives(declared, context, new Set()) : [];
  const type = members[0] ? commonType([members[0], ...members.slice(1)]) : undefined;
  if (type?.kind !== 'union') return undefined;
  const reference = lowerIdentifierReference(node, context);
  return reference.kind === 'binding' ? { binding: reference.binding, type } : undefined;
}

function getTypeScriptNarrowingAlternatives(
  type: Readonly<IrType>,
  context: LoweringContext,
  resolvingAliases: ReadonlySet<string>,
): IrType[] {
  if (type.kind === 'union') {
    return type.types.flatMap((member) => getTypeScriptNarrowingAlternatives(member, context, resolvingAliases));
  }
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.path.length > 0 ||
    resolvingAliases.has(type.reference.binding.id)
  ) {
    return [type];
  }
  const bindingId = type.reference.binding.id;
  const symbol = [...context.typeBindings].find(([, binding]) => binding.id === bindingId)?.[0];
  const declarationSymbol =
    symbol?.flags && symbol.flags & ts.SymbolFlags.Alias ? context.checker.getAliasedSymbol(symbol) : symbol;
  const declaration = declarationSymbol?.declarations?.find(ts.isTypeAliasDeclaration);
  if (!declaration) return [type];
  const declarationSourceFile = declaration.getSourceFile();
  const declarationOptions = context.analysisModuleOptions.get(declarationSourceFile.fileName);
  if (!declarationOptions) return [type];
  const declarationContext = { ...context, options: declarationOptions, sourceFile: declarationSourceFile };
  const target = resolveIrTypeStructuralSubstitution(
    lowerType(declaration.type, declarationContext),
    createIrTypeParameterSubstitutionPlan(
      lowerTypeParameters(declaration.typeParameters, declarationContext),
      type.typeArguments,
    ),
  );
  const nextResolvingAliases = new Set(resolvingAliases).add(bindingId);
  return getTypeScriptNarrowingAlternatives(target, context, nextResolvingAliases);
}

function getTypeScriptLiteralExpressionValue(expression: ts.Expression): boolean | number | string | undefined {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text.replaceAll('_', ''));
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expression.operand)
  ) {
    return -Number(expression.operand.text.replaceAll('_', ''));
  }
  return undefined;
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
  const declared = getTypeScriptExpressionDeclaredType(operand, context);
  const declaredMembers = declared?.isUnion() ? declared.types : declared ? [declared] : [];
  return {
    admitsNull:
      members.some((member) => member.kind === 'null') ||
      declaredMembers.some((member) => (member.flags & ts.TypeFlags.Null) !== 0),
    admitsUndefined:
      members.some((member) => member.kind === 'undefined') ||
      declaredMembers.some((member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0),
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
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!symbol || !declaration) return {};
  const declared = context.checker.getTypeOfSymbolAtLocation(symbol, declaration);
  const declaredMembers = declared.isUnion() ? declared.types : [declared];
  const checkerDeclaredAbsent = declaredMembers.some(
    (member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) !== 0,
  );
  const recordedType = context.bindingTypes.get(symbol);
  if (!checkerDeclaredAbsent && (!recordedType || !hasIrTypeAbsentMemberSemantic(recordedType))) return {};
  const flow = context.checker.getTypeAtLocation(node);
  const members = flow.isUnion() ? flow.types : [flow];
  const absent = members.some(
    (member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) !== 0,
  );
  const indeterminate = members.some(
    (member) => (member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0,
  );
  return !absent && !indeterminate
    ? { presence: 'narrowedPresent' }
    : hasTypeScriptSyntacticReferencePresence(node, symbol, recordedType, context)
      ? { presence: 'narrowedPresent' }
      : {};
}

function getTypeScriptAccessPresence(
  node: ts.ElementAccessExpression | ts.PropertyAccessExpression,
  context: LoweringContext,
): { presence?: 'narrowedPresent' } {
  const declared = getTypeScriptExpressionDeclaredType(node, context);
  if (!declared) return {};
  const declaredMembers = declared.isUnion() ? declared.types : [declared];
  if (
    !declaredMembers.some(
      (member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) !== 0,
    )
  ) {
    return {};
  }
  const flow = context.checker.getTypeAtLocation(node);
  const members = flow.isUnion() ? flow.types : [flow];
  const absent = members.some(
    (member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) !== 0,
  );
  const indeterminate = members.some(
    (member) => (member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0,
  );
  return !absent && !indeterminate ? { presence: 'narrowedPresent' } : {};
}

function hasTypeScriptSyntacticReferencePresence(
  node: ts.Identifier,
  symbol: ts.Symbol,
  recordedType: Readonly<IrType> | undefined,
  context: LoweringContext,
): boolean {
  const absentKinds = getIrTypeAbsentKindsSemantic(recordedType);
  if (absentKinds.size === 0) return false;
  for (let child: ts.Node = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      isTypeScriptNodeWithin(child, parent.right) &&
      hasTypeScriptPositiveArrayPredicate(parent.left, symbol, recordedType, context)
    ) {
      return true;
    }
    if (
      ts.isConditionalExpression(parent) &&
      isTypeScriptNodeWithin(child, parent.whenTrue) &&
      hasTypeScriptPositiveArrayPredicate(parent.condition, symbol, recordedType, context)
    ) {
      return true;
    }
    if (ts.isIfStatement(parent)) {
      if (
        isTypeScriptNodeWithin(child, parent.thenStatement) &&
        hasTypeScriptPositiveArrayPredicate(parent.expression, symbol, recordedType, context)
      ) {
        return true;
      }
      const branch = getTypeScriptNullishComparisonPresence(parent.expression, symbol, absentKinds, context);
      if (branch && isTypeScriptNodeWithin(child, parent.thenStatement) && branch.whenTrue) return true;
      if (branch && parent.elseStatement && isTypeScriptNodeWithin(child, parent.elseStatement) && branch.whenFalse) {
        return true;
      }
    }
    if (ts.isBlock(parent)) {
      const statementIndex = parent.statements.findIndex((statement) => isTypeScriptNodeWithin(node, statement));
      if (statementIndex >= 0) {
        const established = getTypeScriptPriorPresentAssignment(
          parent.statements.slice(0, statementIndex),
          symbol,
          absentKinds,
          context,
        );
        if (established !== undefined) return established;
      }
    }
    if (ts.isFunctionLike(parent)) break;
  }
  return false;
}

function hasTypeScriptPositiveArrayPredicate(
  expression: ts.Expression,
  symbol: ts.Symbol,
  recordedType: Readonly<IrType> | undefined,
  context: LoweringContext,
): boolean {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return (
      hasTypeScriptPositiveArrayPredicate(expression.left, symbol, recordedType, context) ||
      hasTypeScriptPositiveArrayPredicate(expression.right, symbol, recordedType, context)
    );
  }
  const presentType = recordedType ? removeIrTypeAbsentMembersSemantic(recordedType) : undefined;
  if (
    !presentType ||
    (presentType.kind !== 'array' && presentType.kind !== 'tuple') ||
    !ts.isCallExpression(expression) ||
    expression.arguments.length !== 1 ||
    !ts.isIdentifier(expression.arguments[0]!) ||
    context.checker.getSymbolAtLocation(expression.arguments[0]!) !== symbol ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== 'isArray' ||
    !ts.isIdentifier(expression.expression.expression)
  ) {
    return false;
  }
  const receiver = lowerIdentifierReference(expression.expression.expression, context);
  return receiver.kind === 'ambient' && receiver.name === 'Array';
}

function getTypeScriptPriorPresentAssignment(
  statements: readonly ts.Statement[],
  symbol: ts.Symbol,
  absentKinds: ReadonlySet<'null' | 'undefined'>,
  context: LoweringContext,
): boolean | undefined {
  for (let index = statements.length - 1; index >= 0; index--) {
    const statement = statements[index]!;
    const assignment = getTypeScriptDirectBindingAssignment(statement, symbol, context);
    if (assignment !== undefined) return assignment;
    if (ts.isIfStatement(statement) && !statement.elseStatement) {
      const branch = getTypeScriptNullishComparisonPresence(statement.expression, symbol, absentKinds, context);
      if (branch?.whenFalse && getTypeScriptPresentAssignmentInBranch(statement.thenStatement, symbol, context)) {
        return true;
      }
    }
    if (doesTypeScriptStatementAssignBinding(statement, symbol, context.checker)) return false;
  }
  return undefined;
}

function getTypeScriptPresentAssignmentInBranch(
  statement: ts.Statement,
  symbol: ts.Symbol,
  context: LoweringContext,
): boolean {
  const statements = ts.isBlock(statement) ? statement.statements : [statement];
  for (let index = statements.length - 1; index >= 0; index--) {
    const assignment = getTypeScriptDirectBindingAssignment(statements[index]!, symbol, context);
    if (assignment !== undefined) return assignment;
    if (doesTypeScriptStatementAssignBinding(statements[index]!, symbol, context.checker)) return false;
  }
  return false;
}

function getTypeScriptDirectBindingAssignment(
  statement: ts.Statement,
  symbol: ts.Symbol,
  context: LoweringContext,
): boolean | undefined {
  if (
    !ts.isExpressionStatement(statement) ||
    !ts.isBinaryExpression(statement.expression) ||
    statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isIdentifier(statement.expression.left) ||
    context.checker.getSymbolAtLocation(statement.expression.left) !== symbol
  ) {
    return undefined;
  }
  const type = inferInitializerType(statement.expression.right, context);
  return type.kind !== 'unknown' && !hasIrTypeAbsentMemberSemantic(type);
}

function doesTypeScriptStatementAssignBinding(
  statement: ts.Statement,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  let assigned = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      ts.isIdentifier(node.left) &&
      checker.getSymbolAtLocation(node.left) === symbol
    ) {
      assigned = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return assigned;
}

function getTypeScriptNullishComparisonPresence(
  expression: ts.Expression,
  symbol: ts.Symbol,
  absentKinds: ReadonlySet<'null' | 'undefined'>,
  context: LoweringContext,
): Readonly<{ whenFalse: boolean; whenTrue: boolean }> | undefined {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (!ts.isBinaryExpression(expression)) return undefined;
  const left = getTypeScriptNullishComparisonOperand(expression.left, symbol, context);
  const right = getTypeScriptNullishComparisonOperand(expression.right, symbol, context);
  const compared = left.binding ? right.absent : right.binding ? left.absent : undefined;
  if (!compared) return undefined;
  const loose =
    expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
    expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
  const excludesAll = loose || (absentKinds.size === 1 && absentKinds.has(compared));
  const equality =
    expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
    expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const inequality =
    expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
    expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  return equality
    ? { whenFalse: excludesAll, whenTrue: false }
    : inequality
      ? { whenFalse: false, whenTrue: excludesAll }
      : undefined;
}

function getTypeScriptNullishComparisonOperand(
  expression: ts.Expression,
  symbol: ts.Symbol,
  context: LoweringContext,
): Readonly<{ absent?: 'null' | 'undefined'; binding: boolean }> {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return { absent: 'null', binding: false };
  if (ts.isIdentifier(expression)) {
    const reference = lowerIdentifierReference(expression, context);
    if (reference.kind === 'ambient' && reference.name === 'undefined') {
      return { absent: 'undefined', binding: false };
    }
    return { binding: context.checker.getSymbolAtLocation(expression) === symbol };
  }
  return { binding: false };
}

function getIrTypeAbsentKindsSemantic(type: Readonly<IrType> | undefined): ReadonlySet<'null' | 'undefined'> {
  const kinds = new Set<'null' | 'undefined'>();
  const visit = (candidate: Readonly<IrType> | undefined): void => {
    if (candidate?.kind === 'null' || candidate?.kind === 'undefined') kinds.add(candidate.kind);
    else if (candidate?.kind === 'union') candidate.types.forEach(visit);
  };
  visit(type);
  return kinds;
}

// Which alternative of a union-typed binding this reference was proved to hold. The proof is the
// checker's, not this compiler's: the declared type is a union of alternatives and the flow type
// at this reference is exactly one of them. Named alternatives carry the type's own name;
// primitive alternatives carry the primitive name the typeof operator would return. A union of
// literals or of anonymous shapes has no member name to carry, so it is left unnarrowed rather
// than described by a name a target cannot resolve.
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
  if (flow.isUnion()) {
    if (
      flow.types.length === 2 &&
      flow.types.every((t) => t.flags & ts.TypeFlags.BooleanLiteral) &&
      declared.types.some((t) => t.flags & ts.TypeFlags.BooleanLiteral) &&
      declared.types.some((t) => !(t.flags & ts.TypeFlags.BooleanLiteral))
    )
      return { narrowedMember: 'boolean' };
    return {};
  }
  const narrowed = getTypeScriptNamedTypeMemberName(flow) ?? getTypeScriptPrimitiveTypeName(flow);
  if (!narrowed) return {};
  const members = declared.types.map(
    (member) => getTypeScriptNamedTypeMemberName(member) ?? getTypeScriptPrimitiveTypeName(member),
  );
  return members.filter((member) => member === narrowed).length === 1 ? { narrowedMember: narrowed } : {};
}

function getTypeScriptNarrowedStructuralPropertyAccess(
  node: ts.PropertyAccessExpression,
  context: LoweringContext,
): { structuralAccess?: 'narrowed' } {
  if (!ts.isIdentifier(node.expression)) return {};
  const symbol = context.checker.getSymbolAtLocation(node.expression);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!symbol || !declaration) return {};
  const declared = context.checker.getTypeOfSymbolAtLocation(symbol, declaration);
  if (context.checker.getPropertyOfType(declared, node.name.text)) return {};
  const flow = context.checker.getTypeAtLocation(node.expression);
  return context.checker.getPropertyOfType(flow, node.name.text) ? { structuralAccess: 'narrowed' } : {};
}

// Whether the written type declares this member optional. The declaration is the authority rather
// than the checker's type, because a checker with no library types reports too little and because
// what a target needs to know is what the source wrote.
// Which kind of ambient value this member was read from. Only the written type answers: a checker
// with the ambient surface loaded would also answer for a value the source never described, and a
// backend cannot bind a member whose receiver it cannot name.
function getIrResolvedMemberReceiver(type: Readonly<IrType> | undefined): IrResolvedMemberReceiver | undefined {
  if (!type) return undefined;
  if (type.kind === 'union') {
    const inhabited = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
    const resolved = inhabited.map(getIrResolvedMemberReceiver);
    // A partially ambient union is not an ambient receiver. For example, after narrowing
    // `number | Padding` to `Padding`, a read of `padding.left` must remain a source field read,
    // not become the nonexistent built-in `number.left`. Only attach ambient-member policy when
    // every possible inhabited member supplies the same receiver identity.
    if (resolved.some((receiver) => receiver === undefined)) return undefined;
    const receivers = new Set(resolved);
    return receivers.size === 1 ? [...receivers][0] : undefined;
  }
  if (type.kind === 'array') return 'array';
  if (type.kind === 'tuple') return 'tuple';
  if (type.kind === 'named' && type.reference.kind === 'ambient') {
    if (
      ['Partial', 'Readonly', 'Required'].includes(type.reference.name) &&
      type.typeArguments.length === 1 &&
      type.typeArguments[0]
    ) {
      return getIrResolvedMemberReceiver(type.typeArguments[0]);
    }
    const ambientReceivers: Record<string, IrResolvedMemberReceiver> = {
      AbortSignal: 'abortSignal',
      ArrayBuffer: 'arrayBuffer',
      ArrayBufferLike: 'arrayBuffer',
      DataView: 'dataView',
      Date: 'date',
      Error: 'error',
      Float32Array: 'typedArray',
      Float64Array: 'typedArray',
      Int16Array: 'typedArray',
      Int32Array: 'typedArray',
      Int8Array: 'typedArray',
      Map: 'map',
      Promise: 'task',
      RegExp: 'regexp',
      RegExpExecArray: 'array',
      ReadonlyMap: 'map',
      ReadonlySet: 'set',
      Set: 'set',
      TextDecoder: 'textDecoder',
      Uint16Array: 'typedArray',
      Uint32Array: 'typedArray',
      Uint8Array: 'typedArray',
      Uint8ClampedArray: 'typedArray',
      URL: 'url',
      WeakMap: 'map',
    };
    return ambientReceivers[type.reference.name];
  }
  if (type.kind === 'literal') {
    return typeof type.value === 'string' ? 'string' : typeof type.value === 'number' ? 'number' : undefined;
  }
  if (type.kind !== 'primitive') return undefined;
  return type.name === 'string' ? 'string' : type.name === 'number' ? 'number' : undefined;
}

function getIrResolvedMemberReceiverFromNarrowedFlow(
  expression: ts.Expression,
  context: LoweringContext,
): IrResolvedMemberReceiver | undefined {
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = context.checker.getSymbolAtLocation(expression);
  const recorded = symbol ? context.bindingTypes.get(symbol) : undefined;
  if (symbol && recorded && hasTypeScriptSyntacticReferencePresence(expression, symbol, recorded, context)) {
    const present = removeIrTypeAbsentMembersSemantic(recorded);
    const receiver = getIrResolvedMemberReceiver(present);
    if (receiver) return receiver;
  }
  const flow = context.checker.getTypeAtLocation(expression);
  const flowEvidence = getTypeScriptCheckerTypeEvidence(flow, context, 0, false, expression);
  const flowReceiver = getIrResolvedMemberReceiver(flowEvidence);
  if (flowReceiver) return flowReceiver;
  if (flow.isUnion()) {
    if (flow.types.every((member) => member.flags & ts.TypeFlags.StringLiteral)) return 'string';
    if (flow.types.every((member) => member.flags & ts.TypeFlags.NumberLiteral)) return 'number';
    return undefined;
  }
  const name = getTypeScriptPrimitiveTypeName(flow);
  if (name === 'string') return 'string';
  if (name === 'number') return 'number';
  return undefined;
}

function isTypeScriptOptionalMemberAccess(node: ts.PropertyAccessExpression, context: LoweringContext): boolean {
  const symbol = context.checker.getSymbolAtLocation(node.name);
  const declaration = symbol ? getTypeScriptPreferredSymbolDeclaration(symbol, context) : undefined;
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

function getTypeScriptPrimitiveTypeName(type: ts.Type): string | undefined {
  if (type.flags & ts.TypeFlags.String) return 'string';
  if (type.flags & ts.TypeFlags.Number) return 'number';
  if (type.flags & ts.TypeFlags.Boolean) return 'boolean';
  return undefined;
}

// What a callback's parameter holds, when the source did not annotate it and the position it was
// passed to decides. `values.map((value) => value * 2)` writes no type for `value`; the ambient
// surface says `map` takes `(value: T, index: number) => U` and the checker instantiates `T`. That
// instantiation is normally the checker's work. When the deliberately small ambient surface does
// not expose a collection view object, the written receiver and callback position provide the same
// evidence without pretending the iterator itself has a portable runtime representation.
function getTypeScriptContextualParameterType(
  node: ts.ParameterDeclaration,
  context: LoweringContext,
): Readonly<IrType> | undefined {
  const checkerType = getTypeScriptCheckerTypeEvidence(context.checker.getTypeAtLocation(node), context, 0);
  if (checkerType && checkerType.kind !== 'unknown') return checkerType;
  const callback = node.parent;
  const call = callback.parent;
  if (
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !ts.isCallExpression(call) ||
    !call.arguments.includes(callback) ||
    !ts.isPropertyAccessExpression(call.expression)
  ) {
    return checkerType;
  }
  const parameterIndex = callback.parameters.indexOf(node);
  const method = call.expression.name.text;
  const elementType = lowerTypeScriptForOfElementType(call.expression.expression, context);
  if (!elementType) return checkerType;
  if (method === 'sort' && (parameterIndex === 0 || parameterIndex === 1)) return elementType;
  if (['every', 'filter', 'find', 'findIndex', 'forEach', 'map', 'some'].includes(method)) {
    if (parameterIndex === 0) return elementType;
    if (parameterIndex === 1) return { kind: 'primitive', name: 'number' };
  }
  return checkerType;
}

// A type the checker resolved to something this module declares. The declaration's own name is what
// the neutral model carries, so the reference is rebuilt from it rather than from the checker's
// spelling — a type named in a callback parameter is the same type the module already introduced.
function getTypeScriptDeclaredTypeEvidence(
  type: ts.Type,
  context: LoweringContext,
  depth: number,
  lexicalSite?: ts.Node,
): Readonly<IrType> | undefined {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const declaration = symbol?.declarations?.[0];
  if (!symbol || !declaration || declaration.getSourceFile() !== context.sourceFile) return undefined;
  if (
    ts.isInterfaceDeclaration(declaration) &&
    !ts.isSourceFile(declaration.parent) &&
    !ts.isModuleBlock(declaration.parent)
  ) {
    const properties = lowerTypeScriptCheckerObjectProperties(type, context, 0, undefined, lexicalSite);
    return properties ? { kind: 'object', properties } : undefined;
  }
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
  const typeArguments = getTypeScriptCheckerTypeArguments(type, context.checker);
  const loweredArguments = typeArguments.flatMap((argument) => {
    const lowered = getTypeScriptCheckerTypeEvidence(argument, context, depth + 1, true, lexicalSite);
    return lowered ? [lowered] : [];
  });
  if (loweredArguments.length !== typeArguments.length) return undefined;
  return { kind: 'named', reference: { binding, kind: 'binding', path: [] }, typeArguments: loweredArguments };
}

function getTypeScriptCheckerTypeEvidence(
  type: ts.Type,
  context: LoweringContext,
  depth: number,
  structural = false,
  lexicalSite?: ts.Node,
): Readonly<IrType> | undefined {
  const checker = context.checker;
  if (depth > 4 && !(type.flags & ts.TypeFlags.TypeParameter)) {
    const named = getTypeScriptCheckerNamedTypeEvidence(type, context, depth, lexicalSite);
    if (named) return named;
  }
  if (depth > 4) return undefined;
  // A raw checker type parameter has no call-site instantiation to carry and may belong to a
  // different generic declaration than the expression currently being lowered. Authored references
  // already travel through lowerType with their lexical binding; inferred evidence must fall back
  // rather than leak another function's type parameter into this scope.
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const symbol = type.getSymbol();
    const declaration = symbol?.declarations?.find(ts.isTypeParameterDeclaration);
    const binding = symbol ? context.typeBindings.get(symbol) : undefined;
    return binding && declaration && lexicalSite && isTypeScriptNodeWithin(lexicalSite, declaration.parent)
      ? { kind: 'named', reference: { binding, kind: 'binding', path: [] }, typeArguments: [] }
      : undefined;
  }
  if (structural && type.flags & ts.TypeFlags.StringLiteral) {
    return { kind: 'literal', value: (type as ts.StringLiteralType).value };
  }
  if (structural && type.flags & ts.TypeFlags.NumberLiteral) {
    return { kind: 'literal', value: (type as ts.NumberLiteralType).value };
  }
  if (structural && type.flags & ts.TypeFlags.BooleanLiteral) {
    return { kind: 'literal', value: checker.typeToString(type) === 'true' };
  }
  if (type.isUnion()) {
    const symbol = type.aliasSymbol ?? type.getSymbol();
    const isEnum = Boolean(symbol?.flags && symbol.flags & ts.SymbolFlags.Enum);
    if (isEnum || type.aliasSymbol) {
      const named = getTypeScriptCheckerNamedTypeEvidence(type, context, depth, lexicalSite);
      if (
        named &&
        (isEnum ||
          (named.kind === 'named' && named.reference.kind === 'binding' && named.reference.binding.kind === 'import'))
      ) {
        return named;
      }
    }
    if (structural && type.types.every((member) => member.flags & ts.TypeFlags.BooleanLiteral)) {
      return { kind: 'primitive', name: 'boolean' };
    }
    const members = type.types.flatMap((member) => {
      const lowered = getTypeScriptCheckerTypeEvidence(member, context, depth + 1, structural, lexicalSite);
      return lowered ? [lowered] : [];
    });
    if (members.length !== type.types.length || members.length === 0) return undefined;
    return commonType([members[0]!, ...members.slice(1)]);
  }
  if (type.isIntersection()) {
    const members = type.types.flatMap((member) => {
      const lowered = getTypeScriptCheckerTypeEvidence(member, context, depth + 1, true, lexicalSite);
      return lowered ? [lowered] : [];
    });
    if (members.length !== type.types.length || members.length < 2) return undefined;
    return { kind: 'intersection', types: [members[0]!, members[1]!, ...members.slice(2)] };
  }
  if (type.flags & ts.TypeFlags.BooleanLike) return { kind: 'primitive', name: 'boolean' };
  if (type.flags & ts.TypeFlags.BigIntLike) return { kind: 'primitive', name: 'bigint' };
  if (type.flags & ts.TypeFlags.NumberLike) return { kind: 'primitive', name: 'number' };
  if (type.flags & ts.TypeFlags.StringLike) return { kind: 'primitive', name: 'string' };
  if (type.flags & ts.TypeFlags.ESSymbolLike) return { kind: 'primitive', name: 'symbol' };
  if (type.flags & ts.TypeFlags.Void) return { kind: 'primitive', name: 'void' };
  if (type.flags & ts.TypeFlags.Undefined) return { kind: 'undefined' };
  if (type.flags & ts.TypeFlags.Null) return { kind: 'null' };
  if (type.flags & ts.TypeFlags.Never) return { kind: 'never' };
  if (type.flags & ts.TypeFlags.Any) return { kind: 'unknown', source: 'any' };
  if (type.flags & ts.TypeFlags.Unknown) return { kind: 'unknown', source: 'unknown' };
  if (type.flags & ts.TypeFlags.NonPrimitive) return { kind: 'unknown', source: 'object' };
  if (checker.isTupleType(type)) {
    const reference = type as ts.TupleTypeReference;
    if (reference.target.combinedFlags & ts.ElementFlags.Variable) return undefined;
    const arguments_ = checker.getTypeArguments(reference);
    const elements = arguments_.flatMap((argument, index): IrTupleTypeElement[] => {
      const lowered = getTypeScriptCheckerTypeEvidence(argument, context, depth + 1, structural, lexicalSite);
      if (!lowered) return [];
      return [
        reference.target.elementFlags[index] === ts.ElementFlags.Optional
          ? { optional: true, rest: false, type: lowered }
          : { optional: false, rest: false, type: lowered },
      ];
    });
    if (elements.length !== arguments_.length) return undefined;
    return { elements, kind: 'tuple', readonly: reference.target.readonly };
  }
  if (checker.isArrayType(type)) {
    const element = checker.getTypeArguments(type as ts.TypeReference)[0];
    const lowered = element
      ? getTypeScriptCheckerTypeEvidence(element, context, depth + 1, structural, lexicalSite)
      : undefined;
    return lowered ? { element: lowered, kind: 'array', readonly: false } : undefined;
  }
  const declared = getTypeScriptDeclaredTypeEvidence(type, context, depth, lexicalSite);
  if (declared) return declared;
  const named = getTypeScriptCheckerNamedTypeEvidence(type, context, depth, lexicalSite);
  if (named) return named;
  const functionType = getTypeScriptCheckerFunctionTypeEvidence(type, context, depth, lexicalSite);
  if (functionType) return functionType;
  if (!structural) return undefined;
  const properties = lowerTypeScriptCheckerObjectProperties(type, context, depth, undefined, lexicalSite);
  return properties ? { kind: 'object', properties } : undefined;
}

function getTypeScriptCheckerFunctionTypeEvidence(
  type: ts.Type,
  context: LoweringContext,
  depth: number,
  lexicalSite?: ts.Node,
): Readonly<IrType> | undefined {
  if (context.checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0) return undefined;
  const signatures = context.checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  if (signatures.length === 0 || signatures.some((signature) => (signature.typeParameters?.length ?? 0) > 0)) {
    return undefined;
  }
  const functions = signatures.flatMap((signature): Extract<IrType, { kind: 'function' }>[] => {
    const parameters = signature.getParameters().flatMap((parameter): IrFunctionTypeParameter[] => {
      if (parameter.getName() === 'this') return [];
      const declaration = parameter.valueDeclaration;
      const type = context.checker.getTypeOfSymbolAtLocation(
        parameter,
        lexicalSite ?? declaration ?? context.sourceFile,
      );
      const lowered = getTypeScriptCheckerTypeEvidence(type, context, depth + 1, true, lexicalSite);
      if (!lowered) return [];
      const value = { name: parameter.getName(), type: lowered };
      if (declaration && ts.isParameter(declaration) && declaration.dotDotDotToken) {
        return [{ ...value, optional: false, rest: true }];
      }
      const optional =
        Boolean(parameter.flags & ts.SymbolFlags.Optional) ||
        (declaration !== undefined &&
          ts.isParameter(declaration) &&
          (declaration.questionToken !== undefined || declaration.initializer !== undefined));
      return optional ? [{ ...value, optional: true, rest: false }] : [{ ...value, optional: false, rest: false }];
    });
    if (parameters.length !== signature.getParameters().filter((parameter) => parameter.getName() !== 'this').length) {
      return [];
    }
    const returns = getTypeScriptCheckerTypeEvidence(
      context.checker.getReturnTypeOfSignature(signature),
      context,
      depth + 1,
      true,
      lexicalSite,
    );
    return returns ? [{ kind: 'function', parameters, returns, typeParameters: [] }] : [];
  });
  if (functions.length !== signatures.length || !functions[0]) return undefined;
  return functions.length === 1
    ? functions[0]
    : { kind: 'intersection', types: [functions[0], functions[1]!, ...functions.slice(2)] };
}

function getTypeScriptCheckerNamedTypeEvidence(
  type: ts.Type,
  context: LoweringContext,
  depth: number,
  lexicalSite?: ts.Node,
): Readonly<IrType> | undefined {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  // TypeScript gives anonymous call/object types implementation-detail symbol names. They must
  // continue to structural lowering rather than escape as runtime ambient dependencies.
  if (
    !symbol ||
    symbol.name === '__type' ||
    symbol.name === '__object' ||
    Boolean(symbol.flags & (ts.SymbolFlags.TypeParameter | ts.SymbolFlags.Method | ts.SymbolFlags.Property))
  ) {
    return undefined;
  }
  const binding = getTypeScriptCheckerTypeBinding(symbol, context);
  const ambient = isTypeScriptAmbientSymbol(symbol, context);
  if (!binding && !ambient) return undefined;
  const typeArguments = getTypeScriptCheckerTypeArguments(type, context.checker);
  const loweredArguments = typeArguments.flatMap((argument) => {
    const lowered = getTypeScriptCheckerTypeEvidence(argument, context, depth + 1, true, lexicalSite);
    return lowered ? [lowered] : [];
  });
  if (loweredArguments.length !== typeArguments.length) return undefined;
  return {
    kind: 'named',
    reference: binding
      ? { binding, kind: 'binding', path: [] }
      : { kind: 'ambient', name: getTypeScriptAmbientSymbolName(symbol, context) },
    typeArguments: loweredArguments,
  };
}

function getTypeScriptAmbientSymbolName(symbol: ts.Symbol, context: LoweringContext): string {
  const declaration =
    symbol.declarations?.find(
      (candidate) => candidate.getSourceFile().fileName === getCompilerAmbientSurfaceFileName(),
    ) ??
    symbol.declarations?.find((candidate) => !context.analysisModuleOptions.has(candidate.getSourceFile().fileName));
  const namespaceNames: string[] = [];
  for (let parent = declaration?.parent; parent; parent = parent.parent) {
    if (ts.isModuleDeclaration(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) {
      namespaceNames.unshift(parent.name.text);
    }
  }
  return [...namespaceNames, symbol.name].join('.');
}

function getTypeScriptCheckerTypeBinding(
  symbol: ts.Symbol,
  context: LoweringContext,
): IrBindingIdentity | IrTypeBindingIdentity | undefined {
  const direct = context.typeBindings.get(symbol) ?? context.bindings.get(symbol);
  if (
    direct &&
    isTypeScriptNominalCheckerTypeBinding(direct) &&
    isTypeScriptBindingIntroducedInModule(direct, context)
  ) {
    return direct;
  }
  const aliases = [...context.typeBindings, ...context.bindings].flatMap(([candidate, binding]) =>
    candidate.flags & ts.SymbolFlags.Alias &&
    context.checker.getAliasedSymbol(candidate) === symbol &&
    isTypeScriptNominalCheckerTypeBinding(binding) &&
    isTypeScriptBindingIntroducedInModule(binding, context)
      ? [binding]
      : [],
  );
  const unique = new Map(aliases.map((binding) => [binding.id, binding]));
  if (unique.size > 0) return unique.size === 1 ? [...unique.values()][0] : undefined;
  return lowerTypeScriptInferredTypeImportBinding(symbol, context);
}

function isTypeScriptNominalCheckerTypeBinding(binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>): boolean {
  return binding.space === 'type' || binding.kind === 'class' || binding.kind === 'enum' || binding.kind === 'import';
}

function isTypeScriptBindingIntroducedInModule(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  context: LoweringContext,
): boolean {
  const options = context.analysisModuleOptions.get(context.moduleSourceFile.fileName);
  return (
    options !== undefined &&
    binding.packageName === options.packageName &&
    binding.source === relativeSource(context.moduleSourceFile.fileName, options.upstreamDirectory)
  );
}

function getTypeScriptCheckerTypeArguments(type: ts.Type, checker: ts.TypeChecker): readonly ts.Type[] {
  // A non-generic alias of a generic target can retain the target's TypeReference arguments even
  // though the alias itself accepts none. Once alias identity is selected above, only the alias's
  // own arguments belong on the IR reference; falling through to getTypeArguments would turn
  // `type Concrete = Pair<number, string>` into the invalid application `Concrete<number, string>`.
  if (type.aliasSymbol) return type.aliasTypeArguments ?? [];
  if (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
    return checker.getTypeArguments(type as ts.TypeReference);
  }
  return [];
}

function lowerTypeScriptCheckerObjectProperties(
  type: ts.Type,
  context: LoweringContext,
  depth: number,
  mapped?: ts.MappedTypeNode,
  lexicalSite?: ts.Node,
): readonly IrObjectTypeProperty[] | undefined {
  if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) || depth > 4) return undefined;
  if (
    context.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    context.checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0 ||
    context.checker.getIndexInfosOfType(type).length > 0
  ) {
    return undefined;
  }
  const properties: IrObjectTypeProperty[] = [];
  for (const property of context.checker.getPropertiesOfType(type)) {
    const name = property.getName();
    if (name.startsWith('__@')) return undefined;
    const optional = Boolean(property.flags & ts.SymbolFlags.Optional);
    const propertyType = context.checker.getTypeOfSymbolAtLocation(property, mapped ?? context.sourceFile);
    const lowered = lowerTypeScriptCheckerPropertyType(propertyType, optional, context, depth + 1, lexicalSite);
    if (!lowered) return undefined;
    properties.push({
      name,
      optional,
      readonly: getTypeScriptCheckerPropertyReadonly(property, mapped),
      type: lowered,
    });
  }
  return properties;
}

function lowerTypeScriptCheckerPropertyType(
  type: ts.Type,
  optional: boolean,
  context: LoweringContext,
  depth: number,
  lexicalSite?: ts.Node,
): Readonly<IrType> | undefined {
  const candidates =
    optional && type.isUnion() && type.types.some((member) => !(member.flags & ts.TypeFlags.Undefined))
      ? type.types.filter((member) => !(member.flags & ts.TypeFlags.Undefined))
      : [type];
  if (candidates.length > 1 && candidates.every((candidate) => candidate.flags & ts.TypeFlags.BooleanLiteral)) {
    return { kind: 'primitive', name: 'boolean' };
  }
  const lowered = candidates.flatMap((candidate) => {
    const evidence = getTypeScriptCheckerTypeEvidence(candidate, context, depth, true, lexicalSite);
    return evidence ? [evidence] : [];
  });
  return lowered.length === candidates.length && lowered[0] ? commonType([lowered[0], ...lowered.slice(1)]) : undefined;
}

function getTypeScriptCheckerPropertyReadonly(property: ts.Symbol, mapped?: ts.MappedTypeNode): boolean {
  if (mapped?.readonlyToken) return mapped.readonlyToken.kind !== ts.SyntaxKind.MinusToken;
  return property.declarations?.some((declaration) => hasModifier(declaration, ts.SyntaxKind.ReadonlyKeyword)) === true;
}

function hasIrTypeAbsentMemberSemantic(type: Readonly<IrType>): boolean {
  if (type.kind === 'null' || type.kind === 'undefined') return true;
  return type.kind === 'union' && type.types.some((member) => hasIrTypeAbsentMemberSemantic(member));
}

function getTypeScriptExpressionBindingTypeEvidence(
  expression: ts.Expression,
  context: LoweringContext,
): Readonly<IrType> | undefined {
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return lowerTypeScriptTypeNodeEvidence(expression.type, context);
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return getTypeScriptExpressionBindingTypeEvidence(expression.expression, context);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const receiver = getIrTypeConstructionTargetShape(
      getTypeScriptExpressionBindingTypeEvidence(expression.expression, context),
      context,
    );
    if (getIrResolvedMemberReceiver(receiver) === 'typedArray' && expression.name.text === 'buffer') {
      // Project-mode TypeScript may select the generic lib declaration (`buffer: TArrayBuffer`)
      // instead of the compiler ambient declaration even though both describe the same member.
      // Retain the portable ambient result so a following ArrayBuffer member (for example slice)
      // remains resolvable without depending on which merged declaration the checker returned.
      return {
        kind: 'named',
        reference: { kind: 'ambient', name: 'ArrayBuffer' },
        typeArguments: [],
      };
    }
    if (receiver?.kind === 'object') {
      const property = receiver.properties.find((candidate) => candidate.name === expression.name.text);
      if (property) return property.optional ? addIrTypeBindingPatternUndefined(property.type) : property.type;
    }
    // The member's own declaration carries the written type, which a receiver named by a reference
    // does not: resolving the reference would mean resolving every alias the source went through.
    const symbol = context.checker.getSymbolAtLocation(expression.name);
    const declaration = symbol ? getTypeScriptPreferredSymbolDeclaration(symbol, context) : undefined;
    if (
      declaration &&
      (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)) &&
      declaration.type
    ) {
      if (hasExternalTypeScriptTypeParameter(declaration.type, context)) {
        const instantiated = getTypeScriptCheckerTypeEvidence(
          context.checker.getTypeAtLocation(expression),
          context,
          0,
          true,
          expression,
        );
        if (instantiated) return instantiated;
      }
      const written = lowerTypeScriptTypeNodeEvidence(declaration.type, context);
      return declaration.questionToken ? { kind: 'union', types: [written, { kind: 'undefined' }] } : written;
    }
    if (declaration && (ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration))) {
      const externalTypeParameter = [declaration.type, ...declaration.parameters.map((parameter) => parameter.type)]
        .filter((type): type is ts.TypeNode => type !== undefined)
        .some((type) => hasExternalTypeScriptTypeParameter(type, context));
      if (externalTypeParameter) {
        const instantiated = getTypeScriptCheckerTypeEvidence(
          context.checker.getTypeAtLocation(expression),
          context,
          0,
          true,
          expression,
        );
        if (instantiated?.kind === 'function') {
          return declaration.questionToken
            ? { kind: 'union', types: [instantiated, { kind: 'undefined' }] }
            : instantiated;
        }
      }
      const written = lowerFunctionType(declaration, context);
      return declaration.questionToken ? { kind: 'union', types: [written, { kind: 'undefined' }] } : written;
    }
    return getIrTypeMemberEvidence(receiver, expression.name.text);
  }
  // A call's result has no declaration to read a written type off, and a call into the ambient
  // surface returns the surface's own type parameter. The checker's instantiation is what says an
  // array came back, which is what decides whether the member read next is an array's.
  if (ts.isCallExpression(expression)) {
    return getTypeScriptCheckerTypeEvidence(context.checker.getTypeAtLocation(expression), context, 0, true);
  }
  if (ts.isElementAccessExpression(expression)) {
    const index =
      expression.argumentExpression && ts.isNumericLiteral(expression.argumentExpression)
        ? Number(expression.argumentExpression.text)
        : undefined;
    const receiver = getIrTypeConstructionTargetShape(
      getTypeScriptExpressionBindingTypeEvidence(expression.expression, context),
      context,
    );
    return (
      getIrTypeIndexedElementEvidence(receiver, index) ??
      getTypeScriptCheckerTypeEvidence(context.checker.getTypeAtLocation(expression), context, 0)
    );
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = context.checker.getSymbolAtLocation(expression);
  if (!symbol) return undefined;
  const recorded = context.bindingTypes.get(symbol);
  if (recorded) return recorded;
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration)) return undefined;
  if (declaration.type) return lowerTypeScriptTypeNodeEvidence(declaration.type, context);
  return declaration.initializer
    ? getTypeScriptWrittenNewExpressionTypeEvidence(declaration.initializer, context)
    : undefined;
}

function getTypeScriptPreferredSymbolDeclaration(
  symbol: ts.Symbol,
  context: LoweringContext,
): ts.Declaration | undefined {
  return (
    symbol.declarations?.find(
      (candidate) => candidate.getSourceFile().fileName === getCompilerAmbientSurfaceFileName(),
    ) ??
    symbol.valueDeclaration ??
    symbol.declarations?.find((candidate) => context.analysisModuleOptions.has(candidate.getSourceFile().fileName)) ??
    symbol.declarations?.[0]
  );
}

function resolveTypeScriptExpressionPropertyTypeEvidence(type: Readonly<IrType>, context: LoweringContext): IrType {
  if (type.kind === 'union') {
    return {
      kind: 'union',
      types: type.types.map((member) => resolveTypeScriptExpressionPropertyTypeEvidence(member, context)) as [
        IrType,
        IrType,
        ...IrType[],
      ],
    };
  }
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.binding.kind === 'import' ||
    (type.reference.binding.packageName === context.options.packageName &&
      type.reference.binding.source === relativeSource(context.sourceFile.fileName, context.options.upstreamDirectory))
  ) {
    return type;
  }
  return getIrTypeConstructionTargetShape(type, context) ?? type;
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

function createTypeScriptAnalysis(
  sources: readonly Readonly<TypeScriptModuleInput>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan>,
  mode: 'isolated' | 'project',
): TypeScriptAnalysis {
  const analysisSourceFiles = sources.map(({ sourceFile }) =>
    ts.createSourceFile(sourceFile.fileName, sourceFile.text, sourceFile.languageVersion, true),
  );
  // The package graph is checked as one real TypeScript program. The TypeScript dependency is pinned
  // by this package, so its bundled standard-library declarations are part of compiler identity rather
  // than host-machine state. The compiler ambient surface augments that project with the runtime
  // members whose lowering contracts are explicit; backend completeness checks still reject any
  // external symbol or constructor for which a target has not elected an ABI.
  const surfaceFile = ts.createSourceFile(
    getCompilerAmbientSurfaceFileName(),
    createCompilerAmbientSurfaceSource(),
    analysisSourceFiles[0]?.languageVersion ?? ts.ScriptTarget.Latest,
    true,
  );
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noImplicitAny: true,
    ...(mode === 'isolated' ? { noLib: true, noResolve: true } : {}),
    strictNullChecks: true,
    target: ts.ScriptTarget.ESNext,
  };
  const files = new Map(analysisSourceFiles.map((sourceFile) => [sourceFile.fileName, sourceFile] as const));
  files.set(surfaceFile.fileName, surfaceFile);
  const modules: readonly TypeScriptAnalysisModuleRecord[] = sources.map((source) => ({
    fileName: source.sourceFile.fileName,
    packageName: source.packageName,
    source: relativeSource(source.sourceFile.fileName, source.upstreamDirectory),
  }));
  const resolutionIndex = createTypeScriptAnalysisModuleResolutionIndex(modules, moduleResolution);
  const host = ts.createCompilerHost(options, true);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  host.fileExists = (file) => files.has(file) || (mode === 'project' && defaultFileExists(file));
  host.getSourceFile = (file, languageVersionOrOptions, onError, shouldCreateNewSourceFile) =>
    files.get(file) ??
    (mode === 'project'
      ? defaultGetSourceFile(file, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
      : undefined);
  host.readFile = (file) => files.get(file)?.text ?? (mode === 'project' ? defaultReadFile(file) : undefined);
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map(
      (specifier) =>
        resolveTypeScriptAnalysisModule(specifier, containingFile, resolutionIndex) ??
        (mode === 'project'
          ? ts.resolveModuleName(specifier, containingFile, options, host).resolvedModule
          : undefined),
    );
  host.writeFile = () => undefined;
  const program = ts.createProgram({
    host,
    options,
    rootNames: [surfaceFile.fileName, ...analysisSourceFiles.map((sourceFile) => sourceFile.fileName)],
  });
  const checker = program.getTypeChecker();
  const sourceFiles = analysisSourceFiles.map((sourceFile) => program.getSourceFile(sourceFile.fileName)!);
  let referenceStatements: ReadonlyMap<ts.Symbol, ReadonlySet<ts.Statement>> | undefined;
  return {
    checker,
    sourceFiles,
    symbolReferenceStatements() {
      return (referenceStatements ??= createTypeScriptSymbolReferenceStatements(sourceFiles, checker));
    },
  };
}

function createTypeScriptSymbolReferenceStatements(
  sourceFiles: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
): ReadonlyMap<ts.Symbol, ReadonlySet<ts.Statement>> {
  const statementsBySymbol = new Map<ts.Symbol, Set<ts.Statement>>();
  const visit = (candidate: ts.Node, statement: ts.Statement): void => {
    if (ts.isIdentifier(candidate)) {
      const candidateSymbol = checker.getSymbolAtLocation(candidate);
      const resolvedCandidate =
        candidateSymbol?.flags && candidateSymbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(candidateSymbol)
          : candidateSymbol;
      if (resolvedCandidate) {
        const statements = statementsBySymbol.get(resolvedCandidate);
        if (statements) statements.add(statement);
        else statementsBySymbol.set(resolvedCandidate, new Set([statement]));
      }
    }
    ts.forEachChild(candidate, (child) => visit(child, statement));
  };
  for (const sourceFile of sourceFiles) {
    for (const statement of sourceFile.statements) visit(statement, statement);
  }
  return statementsBySymbol;
}

function createTypeScriptAnalysisModuleResolutionIndex(
  modules: readonly TypeScriptAnalysisModuleRecord[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan>,
): TypeScriptAnalysisModuleResolutionIndex {
  const defaultTargetsBySpecifier = new Map<string, TypeScriptAnalysisModuleRecord[]>();
  const exactTargetsByRequest = new Map<string, TypeScriptAnalysisModuleRecord[]>();
  const modulesByFileName = new Map(modules.map((module) => [module.fileName, module] as const));
  const modulesByIdentity = new Map<string, TypeScriptAnalysisModuleRecord[]>();
  for (const module of modules) {
    const key = getTypeScriptAnalysisModuleIdentityKey(module.packageName, module.source);
    const matching = modulesByIdentity.get(key);
    if (matching) matching.push(module);
    else modulesByIdentity.set(key, [module]);
  }
  for (const edge of moduleResolution.edges) {
    const targetKey = getTypeScriptAnalysisModuleIdentityKey(edge.target.packageName, edge.target.source);
    const targets = modulesByIdentity.get(targetKey) ?? [];
    if (edge.importer) {
      const requestKey = getTypeScriptAnalysisModuleRequestKey(edge.importer, edge.specifier);
      const matching = exactTargetsByRequest.get(requestKey);
      if (matching) matching.push(...targets);
      else exactTargetsByRequest.set(requestKey, [...targets]);
    } else {
      const matching = defaultTargetsBySpecifier.get(edge.specifier);
      if (matching) matching.push(...targets);
      else defaultTargetsBySpecifier.set(edge.specifier, [...targets]);
    }
  }
  return { defaultTargetsBySpecifier, exactTargetsByRequest, modulesByFileName };
}

function getTypeScriptAnalysisModuleIdentityKey(packageName: string, source: string): string {
  return `${packageName}\0${normalizePathPortable(source)}`;
}

function getTypeScriptAnalysisModuleRequestKey(
  importer: Readonly<Pick<TypeScriptAnalysisModuleRecord, 'packageName' | 'source'>>,
  specifier: string,
): string {
  return `${getTypeScriptAnalysisModuleIdentityKey(importer.packageName, importer.source)}\0${specifier}`;
}

function resolveTypeScriptAnalysisModule(
  specifier: string,
  containingFile: string,
  index: Readonly<TypeScriptAnalysisModuleResolutionIndex>,
): ts.ResolvedModule | undefined {
  const importer = index.modulesByFileName.get(containingFile);
  if (!importer) return undefined;
  const requestKey = getTypeScriptAnalysisModuleRequestKey(importer, specifier);
  const targets = index.exactTargetsByRequest.has(requestKey)
    ? index.exactTargetsByRequest.get(requestKey)!
    : (index.defaultTargetsBySpecifier.get(specifier) ?? []);
  const relativeCandidates = getTypeScriptAnalysisRelativeCandidates(containingFile, specifier);
  const candidates = [
    ...targets,
    ...[...relativeCandidates]
      .map((candidate) => index.modulesByFileName.get(candidate))
      .filter((module): module is TypeScriptAnalysisModuleRecord => module?.packageName === importer.packageName),
  ];
  const resolved = [...new Map(candidates.map((candidate) => [candidate.fileName, candidate])).values()];
  return resolved.length === 1
    ? {
        isExternalLibraryImport: false,
        resolvedFileName: resolved[0]!.fileName,
      }
    : undefined;
}

function getTypeScriptAnalysisRelativeCandidates(containingFile: string, specifier: string): ReadonlySet<string> {
  if (specifier !== '.' && specifier !== '..' && !specifier.startsWith('./') && !specifier.startsWith('../')) {
    return new Set();
  }
  const resolved = normalizePathPortable(path.resolve(path.dirname(containingFile), specifier));
  const candidates = new Set([resolved]);
  for (const [emitted, sourceExtension] of [
    ['.cjs', '.cts'],
    ['.js', '.ts'],
    ['.jsx', '.tsx'],
    ['.mjs', '.mts'],
  ] as const) {
    if (resolved.endsWith(emitted)) candidates.add(`${resolved.slice(0, -emitted.length)}${sourceExtension}`);
  }
  if (!/\.[^/]+$/u.test(resolved)) {
    for (const extension of ['.cts', '.mts', '.ts', '.tsx']) {
      candidates.add(`${resolved}${extension}`);
      candidates.add(`${resolved}/index${extension}`);
    }
  }
  return candidates;
}

function lowerIdentifierReference(node: ts.Identifier, context: LoweringContext): IrIdentifierReference {
  const symbol =
    ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? context.checker.getShorthandAssignmentValueSymbol(node.parent)
      : context.checker.getSymbolAtLocation(node);
  return symbol?.declarations?.some(isValueBindingDeclaration) && !isTypeScriptAmbientSymbol(symbol, context)
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

// A declaration supplied by the compiler surface, TypeScript's pinned standard library, or an
// external declaration package is ambient however well the checker resolves it. Those declarations
// provide exact type evidence but are not bindings introduced by a source module; the backend's
// external-symbol plan decides whether their names have a target representation.
function isTypeScriptAmbientSymbol(symbol: ts.Symbol | undefined, context: LoweringContext): boolean {
  const declarations = symbol?.declarations;
  return (
    declarations !== undefined &&
    declarations.length > 0 &&
    declarations.every(
      (declaration) =>
        !context.analysisModuleOptions.has(declaration.getSourceFile().fileName) ||
        (isTypeScriptDeclareDeclaration(declaration) &&
          !isTypeScriptCompilerErasedUniqueSymbolDeclaration(declaration)),
    )
  );
}

// A local `declare const key: unique symbol` has no emitted declaration, but its references still
// carry compiler-owned binding identity so computed-key facets remain tied to that declaration.
// Treating every written `declare` as an external value loses that identity and turns the key into
// an unbound ambient lookup.
function isTypeScriptCompilerErasedUniqueSymbolDeclaration(declaration: ts.Declaration): boolean {
  return (
    ts.isVariableDeclaration(declaration) &&
    declaration.type !== undefined &&
    ts.isTypeOperatorNode(declaration.type) &&
    declaration.type.operator === ts.SyntaxKind.UniqueKeyword
  );
}

function isTypeScriptDeclareDeclaration(declaration: ts.Declaration): boolean {
  for (let node: ts.Node | undefined = declaration; node && !ts.isSourceFile(node); node = node.parent) {
    if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return false;
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
  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = context.checker.getAliasedSymbol(symbol);
    if (aliased !== symbol && !context.bindings.has(aliased)) context.bindings.set(aliased, binding);
  }
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
  const aliased = resolveTypeBindingAliasTarget(symbol, context);
  if (aliased) {
    const aliasedCached = context.typeBindings.get(aliased);
    if (aliasedCached) {
      context.typeBindings.set(symbol, aliasedCached);
      return aliasedCached;
    }
  }
  const declaration = symbol.declarations?.find(isTypeBindingDeclaration);
  // An authored import is its own provenance. During lowerImports, the resulting IrImport has not
  // been appended to the context yet, so inferred discovery must not synthesize the same request.
  const inferredImport =
    declaration &&
    typeBindingDeclarationKind(declaration) === 'import' &&
    declaration.getSourceFile() === context.moduleSourceFile
      ? undefined
      : lowerTypeScriptInferredTypeImportBinding(aliased ?? symbol, context);
  if (inferredImport) {
    context.typeBindings.set(symbol, inferredImport);
    if (aliased) context.typeBindings.set(aliased, inferredImport);
    return inferredImport;
  }
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
  if (aliased) context.typeBindings.set(aliased, binding);
  return binding;
}

// Checker evidence can expose an exported type which the current source did not spell, such as the
// return type of an imported function. Prefer the exact authored request which exposes that type. A
// same-package hidden member has no such request, but its unique declaration owner is also a stable
// route: introduce a direct relative type import rather than erasing its nominal identity.
function lowerTypeScriptInferredTypeImportBinding(
  symbol: ts.Symbol,
  context: LoweringContext,
): IrTypeBindingIdentity | undefined {
  const declaration = symbol.declarations?.find(
    (
      candidate,
    ): candidate is ts.ClassDeclaration | ts.EnumDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      (ts.isClassDeclaration(candidate) ||
        ts.isEnumDeclaration(candidate) ||
        ts.isInterfaceDeclaration(candidate) ||
        ts.isTypeAliasDeclaration(candidate)) &&
      ts.isSourceFile(candidate.parent) &&
      candidate.name !== undefined &&
      isExported(candidate),
  );
  if (!declaration || declaration.getSourceFile().fileName === context.moduleSourceFile.fileName) return undefined;
  // The imported module's export table is the provenance boundary. Comparing leaf declaration files
  // misses export-star barrels, where two types reached through one request intentionally live in
  // different files. Exact checker-symbol identity keeps renamed exports sound and ambiguity explicit.
  const routes = new Map<string, { importDeclaration: ts.ImportDeclaration; imported: string; specifier: string }>();
  for (const statement of context.moduleSourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const moduleSymbol = context.checker.getSymbolAtLocation(statement.moduleSpecifier);
    if (!moduleSymbol) continue;
    const named = statement.importClause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const importedBinding of named.elements) {
        const local = context.checker.getSymbolAtLocation(importedBinding.name);
        const target = local && local.flags & ts.SymbolFlags.Alias ? context.checker.getAliasedSymbol(local) : local;
        if (target !== symbol) continue;
        const specifier = statement.moduleSpecifier.text;
        const imported = importedBinding.propertyName?.text ?? importedBinding.name.text;
        routes.set(JSON.stringify([specifier, imported]), {
          importDeclaration: statement,
          imported,
          specifier,
        });
      }
    }
    for (const exported of context.checker.getExportsOfModule(moduleSymbol)) {
      const target = exported.flags & ts.SymbolFlags.Alias ? context.checker.getAliasedSymbol(exported) : exported;
      if (target !== symbol) continue;
      const specifier = statement.moduleSpecifier.text;
      routes.set(JSON.stringify([specifier, exported.name]), {
        importDeclaration: statement,
        imported: exported.name,
        specifier,
      });
    }
  }
  if (routes.size > 1) return undefined;
  const authored = [...routes.values()][0];
  const direct = authored ? undefined : getTypeScriptUniqueSamePackageTypeImportRoute(symbol, context);
  const route = authored
    ? {
        imported: authored.imported,
        originNode: authored.importDeclaration.moduleSpecifier,
        specifier: authored.specifier,
      }
    : direct;
  if (!route) return undefined;
  const { imported, originNode, specifier } = route;
  const moduleOptions = context.analysisModuleOptions.get(context.moduleSourceFile.fileName);
  if (!moduleOptions) return undefined;
  const moduleContext = { ...context, options: moduleOptions, sourceFile: context.moduleSourceFile };
  const sourceOrigin = origin(originNode, moduleContext);
  const binding: IrTypeBindingIdentity = {
    ...sourceOrigin,
    id: `type-binding:${JSON.stringify([
      sourceOrigin.packageName,
      sourceOrigin.source,
      'inferred-import',
      specifier,
      imported,
    ])}`,
    kind: 'import',
    name: symbol.name,
    scope: 'module',
    space: 'type',
  };
  const existing = context.imports
    .flatMap((imported) => imported.bindings)
    .find((candidate) => candidate.binding.id === binding.id)?.binding;
  if (existing?.space === 'type') {
    context.typeBindings.set(symbol, existing);
    return existing;
  }
  context.imports.push({
    bindings: [{ binding, imported, typeOnly: true }],
    specifier,
    typeOnly: true,
  });
  context.typeBindings.set(symbol, binding);
  return binding;
}

function getTypeScriptUniqueSamePackageTypeImportRoute(
  symbol: ts.Symbol,
  context: LoweringContext,
): Readonly<{ imported: string; originNode: ts.Node; specifier: string }> | undefined {
  const ownerFiles = new Map<string, ts.SourceFile>();
  for (const declaration of symbol.declarations ?? []) {
    if (
      (!ts.isClassDeclaration(declaration) &&
        !ts.isEnumDeclaration(declaration) &&
        !ts.isInterfaceDeclaration(declaration) &&
        !ts.isTypeAliasDeclaration(declaration)) ||
      !ts.isSourceFile(declaration.parent) ||
      !isExported(declaration) ||
      hasModifier(declaration, ts.SyntaxKind.DefaultKeyword) ||
      declaration.name === undefined ||
      declaration.name.text !== symbol.name
    ) {
      continue;
    }
    ownerFiles.set(declaration.getSourceFile().fileName, declaration.getSourceFile());
  }
  if (ownerFiles.size !== 1) return undefined;
  const owner = [...ownerFiles.values()][0]!;
  const ownerOptions = context.analysisModuleOptions.get(owner.fileName);
  if (
    !ownerOptions ||
    ownerOptions.packageName !== context.options.packageName ||
    owner.fileName === context.moduleSourceFile.fileName
  ) {
    return undefined;
  }
  const specifier = getTypeScriptDirectSamePackageImportSpecifier(context.moduleSourceFile.fileName, owner.fileName);
  return specifier ? { imported: symbol.name, originNode: context.moduleSourceFile, specifier } : undefined;
}

function getTypeScriptDirectSamePackageImportSpecifier(fromFile: string, targetFile: string): string | undefined {
  const from = normalizePathPortable(fromFile);
  const target = normalizePathPortable(targetFile);
  if (target.endsWith('.d.ts')) return undefined;
  const emittedTarget = target
    .replace(/\.cts$/u, '.cjs')
    .replace(/\.mts$/u, '.mjs')
    .replace(/\.tsx$/u, '.jsx')
    .replace(/\.ts$/u, '.js');
  if (emittedTarget === target) return undefined;
  const relative = path.posix.relative(path.posix.dirname(from), emittedTarget);
  if (!relative) return undefined;
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function hasTypeBindingDeclarationInModule(symbol: ts.Symbol, context: LoweringContext): boolean {
  const direct = context.typeBindings.get(symbol);
  if (direct && isTypeScriptBindingIntroducedInModule(direct, context)) return true;
  const aliased = resolveTypeBindingAliasTarget(symbol, context);
  const aliasedBinding = aliased ? context.typeBindings.get(aliased) : undefined;
  if (aliasedBinding && isTypeScriptBindingIntroducedInModule(aliasedBinding, context)) return true;
  return (
    symbol.declarations?.some(
      (declaration) =>
        isTypeBindingDeclaration(declaration) &&
        declaration.getSourceFile().fileName === context.moduleSourceFile.fileName,
    ) ?? false
  );
}

function resolveTypeBindingAliasTarget(symbol: ts.Symbol, context: LoweringContext): ts.Symbol | undefined {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return undefined;
  const aliased = context.checker.getAliasedSymbol(symbol);
  if (aliased === symbol || !aliased.declarations?.some(isTypeBindingDeclaration)) return undefined;
  return aliased;
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
  if (ts.isFunctionDeclaration(node) && ts.isModuleBlock(node.parent) && ts.isModuleDeclaration(node.parent.parent)) {
    return 'module';
  }
  if (ts.isFunctionDeclaration(node) && ts.isBlock(node.parent) && ts.isFunctionLike(node.parent.parent)) {
    return 'function';
  }
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
    if (ts.isSourceFile(parent)) {
      if (
        variableDeclaration &&
        variableDeclaration.parent.flags & ts.NodeFlags.BlockScoped &&
        !isTypeScriptDirectModuleVariableDeclaration(variableDeclaration)
      ) {
        return 'block';
      }
      if (ts.isFunctionDeclaration(node) && node.parent !== parent) return 'block';
      return 'module';
    }
  }
  return 'block';
}

function isTypeScriptDirectModuleVariableDeclaration(node: ts.VariableDeclaration): boolean {
  const owner = node.parent.parent;
  return ts.isVariableStatement(owner) && ts.isSourceFile(owner.parent);
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
  const cached = context.origins.get(node);
  if (cached) return cached;
  const start = node.getStart(context.sourceFile);
  const position = context.sourceFile.getLineAndCharacterOfPosition(start);
  const resolved = {
    column: position.character + 1,
    fingerprint: fingerprintTypeScriptNode(node, context.sourceFile),
    line: position.line + 1,
    packageName: context.options.packageName,
    source: relativeSource(context.sourceFile.fileName, context.options.upstreamDirectory),
  };
  context.origins.set(node, resolved);
  return resolved;
}

function propertyName(node: ts.PropertyName, _context: LoweringContext): string {
  const name = tryPropertyName(node);
  if (name !== undefined) return name;
  unsupported(node, 'computed property names require expression-level representation');
}

function tryPropertyName(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text
    : undefined;
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

function hasValueNamespaceMembers(node: ts.ModuleDeclaration): boolean {
  if (!node.body) return false;
  if (ts.isModuleDeclaration(node.body)) return hasValueNamespaceMembers(node.body);
  if (!ts.isModuleBlock(node.body)) return false;
  return node.body.statements.some(
    (statement) =>
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isVariableStatement(statement) ||
      ts.isEnumDeclaration(statement) ||
      (ts.isModuleDeclaration(statement) && hasValueNamespaceMembers(statement)),
  );
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

const compilerEmptyModuleResolutionPlan: CompilerModuleResolutionPlan = Object.freeze({
  edges: Object.freeze([]),
  schema: 'flight-compiler-module-resolution/1',
});
