import path from 'node:path';

import {
  createBackendEmissionFailure,
  createCompilerGeneratedFileHeader,
  createIrModuleTargetNameAllocation,
  indentSourceLines,
  isCompilerTargetNameAllocationFailure,
} from '../../compiler-emission/src/index.js';
import { analyzeIrModuleTraversal, getIrModuleTraversalPathValue } from '../../compiler-ir-traversal/src/index.js';
import {
  createCompilerLoweringPassAwaitConditionHoisting,
  createCompilerLoweringPassBindingPattern,
  createCompilerLoweringPassCStyleFor,
  createCompilerLoweringPassExtraArgumentErasure,
  createCompilerLoweringPassInterfaceInheritance,
  createCompilerLoweringPassSwitchFallthrough,
  createCompilerLoweringPassSwitchSuspension,
  createCompilerLoweringPassVariableHoisting,
  createIrClassInitializationPlan,
  lowerIrModuleWithCompilerPasses,
} from '../../compiler-lowering/src/index.js';
import {
  analyzeCompilerRuntimeExternalConstructorAbiCompleteness,
  analyzeCompilerRuntimeExternalSymbolCompleteness,
  collectIrModulesRuntimeExternalConstructorInvocations,
  collectIrModulesRuntimeExternalSymbolIdentities,
} from '../../compiler-runtime-contract/src/index.js';
import { analyzeIrModuleStructuralObjectCompatibilityAcrossModules } from '../../compiler-structural/src/index.js';
import { analyzeIrModuleAsyncStateMachines } from '../../compiler-task/src/index.js';
import type {
  CompilerBackend,
  CompilerHaxeTaskLowering,
  CompilerHaxeTaskLoweringFunction,
  CompilerModuleResolutionPlan,
  EmittedFile,
  HaxeCompilerBackendOptions,
} from '../../compiler-types/src/index.js';
import type {
  IrAssignmentOperator,
  IrAssignmentOperatorSemantics,
  IrBinaryOperator,
  IrBinaryOperatorSemantics,
  IrBindingIdentity,
  IrClassDeclaration,
  IrControlFlowLabelIdentity,
  IrDeclaration,
  IrEnumDeclaration,
  IrExpression,
  IrFunctionDeclaration,
  IrIdentifierReference,
  IrImport,
  IrInterfaceDeclaration,
  IrModule,
  IrObjectTypeProperty,
  IrParameter,
  IrPostfixUnaryOperator,
  IrPrefixUnaryOperator,
  IrStatement,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeBindingIdentity,
  IrTypeReference,
  IrTypeParameter,
  IrUnaryOperatorSemantics,
  IrVariable,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';
import { convertPackageNameToHaxePackageName, convertSourcePathToHaxeModuleName } from './haxeCompilerIdentity.js';
import { createCompilerRuntimeExternalConstructorAbiPlanHaxe } from './haxeRuntimeExternalConstructorAbi.js';
import {
  createCompilerRuntimeExternalSymbolBindingPlanHaxe,
  getCompilerRuntimeExternalSymbolTargetHaxe,
} from './haxeRuntimeExternalSymbolBinding.js';
import { createCompilerRuntimeTaskCapabilityPlanHaxe } from './haxeRuntimeTaskCapability.js';
import { emitCompilerHaxeTaskLoweringFunction } from './haxeTaskEmission.js';
import { isCompilerHaxeTaskLoweringFailure, lowerCompilerAsyncStateMachinesHaxe } from './haxeTaskLowering.js';

interface EmitContext {
  breakableDepth: number;
  controlFlowLabels: HaxeControlFlowLabel[];
  generatedNames: Set<string>;
  module: Readonly<IrModule>;
  options: Readonly<HaxeCompilerBackendOptions>;
  packageName: string;
  targetNames: ReadonlyMap<string, string>;
  taskFunctions: WeakMap<object, CompilerHaxeTaskLoweringFunction>;
  taskLowering: Readonly<CompilerHaxeTaskLowering>;
}

interface HaxeControlFlowLabel {
  readonly continuable: boolean;
  readonly depth: number;
  readonly identity: Readonly<IrControlFlowLabelIdentity>;
  readonly stateName: string;
}

export function createHaxeCompilerBackend(): CompilerBackend<HaxeCompilerBackendOptions> {
  return {
    emitModule(module, { moduleResolution, modules, options }) {
      return [emitIrModuleHaxeWithContext(module, modules, moduleResolution, options)];
    },
    name: 'haxe',
  };
}

export function emitIrModuleHaxe(
  sourceModule: Readonly<IrModule>,
  options: Readonly<HaxeCompilerBackendOptions> = {},
): EmittedFile {
  return emitIrModuleHaxeWithContext(sourceModule, [sourceModule], undefined, options);
}

function emitIrModuleHaxeWithContext(
  sourceModule: Readonly<IrModule>,
  sourceModules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
  options: Readonly<HaxeCompilerBackendOptions>,
): EmittedFile {
  const module = lowerIrModuleWithCompilerPasses(sourceModule, [
    createCompilerLoweringPassExtraArgumentErasure(),
    createCompilerLoweringPassAwaitConditionHoisting(),
    createCompilerLoweringPassBindingPattern(),
    createCompilerLoweringPassVariableHoisting(),
    createCompilerLoweringPassCStyleFor(),
    createCompilerLoweringPassInterfaceInheritance(),
    createCompilerLoweringPassSwitchFallthrough(),
    createCompilerLoweringPassSwitchSuspension(),
  ]);
  assertStructuralObjectCompatibilityHaxe(
    module,
    replaceIrModuleBackendContext(sourceModules, module),
    moduleResolution,
  );
  assertRuntimeExternalSymbolBindingsHaxe(module);
  assertRuntimeExternalConstructorAbiHaxe(module);
  let taskLowering: CompilerHaxeTaskLowering;
  try {
    taskLowering = lowerCompilerAsyncStateMachinesHaxe(
      analyzeIrModuleAsyncStateMachines(module),
      createCompilerRuntimeTaskCapabilityPlanHaxe(),
      { runtimeModule: options.runtimeModule },
    );
  } catch (error) {
    if (isCompilerHaxeTaskLoweringFailure(error)) {
      throw createBackendEmissionFailure('haxe', module, error.message);
    }
    throw error;
  }
  const packageName = convertPackageNameToHaxePackageName(module.packageName, options.rootPackage);
  let targetNames: Map<string, string>;
  try {
    targetNames = new Map(
      createIrModuleTargetNameAllocation(module, (binding) => ({
        namespace: 'identifier',
        preferredName:
          binding.space === 'type' || binding.kind === 'class' || binding.kind === 'enum'
            ? safeHaxeTypeName(binding.name)
            : safeHaxeName(binding.name),
      })).map((allocation) => [allocation.identity, allocation.name]),
    );
  } catch (error) {
    if (isCompilerTargetNameAllocationFailure(error)) {
      throw createBackendEmissionFailure(
        'haxe',
        module,
        `public declarations share fixed Haxe target name ${error.targetName}`,
      );
    }
    throw error;
  }
  const context: EmitContext = {
    breakableDepth: 0,
    controlFlowLabels: [],
    generatedNames: new Set(targetNames.values()),
    module,
    options,
    packageName,
    targetNames,
    taskFunctions: new WeakMap(),
    taskLowering,
  };
  for (const functionPlan of taskLowering.functions) {
    const source = getIrModuleTraversalPathValue(module, functionPlan.path);
    if (!source || typeof source !== 'object') {
      emissionError(context, `Haxe task function source path does not exist: ${JSON.stringify(functionPlan.path)}`);
    }
    context.taskFunctions.set(source, functionPlan);
  }
  if (taskLowering.refusals.length > 0) {
    const refusal = taskLowering.refusals[0]!;
    emissionError(
      context,
      `async state machine ${refusal.code} at ${JSON.stringify(refusal.path)} in ${JSON.stringify(refusal.scopePath)}`,
    );
  }
  assertIrModuleSuperConstructorCallShapeHaxe(module, context);
  if (module.exports.length > 0) {
    emissionError(context, 're-exports and export assignments require Haxe module-facade lowering');
  }
  const moduleName = haxeImplementationModule(module.source);
  const typeDeclarations = module.declarations.filter(
    (declaration) =>
      declaration.kind === 'class' ||
      declaration.kind === 'enum' ||
      declaration.kind === 'interface' ||
      declaration.kind === 'typeAlias',
  );
  const valueDeclarations = module.declarations.filter(
    (declaration): declaration is IrFunctionDeclaration | IrVariableDeclaration =>
      declaration.kind === 'function' || declaration.kind === 'variable',
  );
  const lines = [createCompilerGeneratedFileHeader(module, '//', options.upstreamCommit), `package ${packageName};`];
  const imports = emitImports(module.imports, context);
  if (imports.length > 0) lines.push('', ...imports);
  for (const declaration of typeDeclarations) lines.push('', ...emitTypeDeclaration(declaration, context));
  if (valueDeclarations.length > 0) {
    lines.push('', `class ${moduleName} {`);
    valueDeclarations.forEach((declaration, index) => {
      if (index > 0) lines.push('');
      lines.push(...indentSourceLines(emitModuleValue(declaration, context)));
    });
    lines.push('}');
  }
  return {
    contents: lines.join('\n'),
    path: `${packageName.replaceAll('.', '/')}/${moduleName}.hx`,
  };
}

function assertIrModuleSuperConstructorCallShapeHaxe(module: Readonly<IrModule>, context: EmitContext): void {
  analyzeIrModuleTraversal(module, {
    expression(expression, path) {
      if (!isIrExpressionSuperConstructorCallHaxe(expression)) return;
      const declarationIndex = path[1];
      const declaration = typeof declarationIndex === 'number' ? module.declarations[declarationIndex] : undefined;
      const directDerivedConstructorCall =
        path.length === 6 &&
        path[0] === 'declarations' &&
        path[2] === 'classConstructor' &&
        path[3] === 'body' &&
        typeof path[4] === 'number' &&
        path[5] === 'expression' &&
        declaration?.kind === 'class' &&
        declaration.extends !== undefined;
      if (!directDerivedConstructorCall) {
        emissionError(context, 'super constructor calls require a direct derived-constructor statement in Haxe');
      }
    },
  });
}

function emitClass(declaration: Readonly<IrClassDeclaration>, context: EmitContext): string[] {
  const implemented = declaration.implements.map((reference) => {
    if (reference.kind !== 'named' || reference.reference.kind !== 'binding') {
      return emissionError(
        context,
        `class ${declaration.binding.name} implements a type with no nominal Haxe interface`,
      );
    }
    const target = context.module.declarations.find(
      (candidate) =>
        candidate.kind === 'interface' &&
        reference.reference.kind === 'binding' &&
        candidate.binding.id === reference.reference.binding.id,
    );
    if (!target) {
      return emissionError(
        context,
        `class ${declaration.binding.name} implements an interface declared outside this module`,
      );
    }
    return emitType(reference, context);
  });
  const parameters = emitTypeParameters(declaration.typeParameters, context);
  const extendsType = declaration.extends ? ` extends ${emitType(declaration.extends, context)}` : '';
  const implementsTypes = implemented.map((name) => ` implements ${name}`).join('');
  const abstract = declaration.abstract ? 'abstract ' : '';
  const initialization = createIrClassInitializationPlan(declaration);
  const requiresErrorNameStorage =
    isIrClassErrorSubclassHaxe(declaration) &&
    !declaration.fields.some((field) => !field.static && field.name === 'name');
  if (initialization.constructor.kind === 'implicit-derived') {
    emissionError(
      context,
      `class ${declaration.binding.name} implicit derived constructor requires inherited-ABI forwarding`,
    );
  }
  const directSuperCalls = declaration.classConstructor?.body.filter(isIrStatementSuperConstructorCall) ?? [];
  if (declaration.extends && declaration.classConstructor && directSuperCalls.length !== 1) {
    emissionError(
      context,
      `class ${declaration.binding.name} requires one direct super constructor call for Haxe initialization`,
    );
  }
  const lines = [
    `${declaration.exported ? '' : 'private '}${abstract}class ${getBindingTargetNameHaxe(declaration.binding, context)}${parameters}${extendsType}${implementsTypes} {`,
  ];
  if (requiresErrorNameStorage) {
    lines.push('  public var name:String;');
  }
  declaration.fields.forEach((field, index) => {
    if (index > 0 || lines.length > 1) lines.push('');
    const visibility = field.visibility === 'public' ? 'public ' : field.visibility === 'private' ? 'private ' : '';
    const storage = field.readonly ? 'final' : 'var';
    const static_ = field.static ? 'static ' : '';
    const fieldInitialization = initialization.fields[index]!;
    const initializer =
      field.initializer && fieldInitialization.timing !== 'derived-super-return'
        ? ` = ${emitExpression(field.initializer, context)}`
        : '';
    lines.push(
      `  ${visibility}${static_}${storage} ${safeHaxeName(field.name)}:${emitType(field.type, context)}${initializer};`,
    );
  });
  if (
    declaration.classConstructor &&
    (declaration.classConstructor.parameters.length > 0 || declaration.classConstructor.body.length > 0)
  ) {
    if (declaration.fields.length > 0 || requiresErrorNameStorage) lines.push('');
    lines.push(`  public function new(${emitParameters(declaration.classConstructor.parameters, context)}) {`);
    const body: string[] = [];
    body.push(
      ...emitIrClassFieldInitializationsHaxe(declaration, initialization, 'base-constructor-body-entry', context),
    );
    for (const statement of declaration.classConstructor.body) {
      body.push(...emitStatements([statement], context));
      if (isIrStatementSuperConstructorCall(statement)) {
        if (requiresErrorNameStorage) body.push('this.name = "Error";');
        body.push(...emitIrClassFieldInitializationsHaxe(declaration, initialization, 'derived-super-return', context));
        body.push(
          ...emitIrClassFieldInitializationsHaxe(
            declaration,
            initialization,
            'derived-super-return-after-fields',
            context,
          ),
        );
      }
    }
    lines.push(...indentSourceLines(body, 2), '  }');
  }
  declaration.methods.forEach((method) => {
    if (lines.length > 1) lines.push('');
    const visibility = method.visibility === 'public' ? 'public ' : method.visibility === 'private' ? 'private ' : '';
    const static_ = method.static ? 'static ' : '';
    lines.push(
      `  ${visibility}${static_}function ${safeHaxeName(method.name)}${emitTypeParameters(method.typeParameters, context)}(${emitParameters(method.parameters, context)}):${emitType(method.returns, context)} {`,
      ...indentSourceLines(
        method.async ? emitCompilerHaxeTaskFunctionBody(method, context) : emitStatements(method.body, context),
        2,
      ),
      '  }',
    );
  });
  lines.push('}');
  return lines;
}

function emitEnum(declaration: Readonly<IrEnumDeclaration>, context: EmitContext): string[] {
  const kinds = new Set(declaration.members.map((member) => typeof member.value));
  if (kinds.size > 1) emissionError(context, `enum ${declaration.binding.name} mixes string and numeric values`);
  if (declaration.members.some((member) => typeof member.value === 'number' && !Number.isFinite(member.value))) {
    emissionError(context, `enum ${declaration.binding.name} has a non-finite numeric value`);
  }
  const underlying = kinds.has('string')
    ? 'String'
    : declaration.members.some((member) => !Number.isInteger(member.value))
      ? 'Float'
      : 'Int';
  const lines = [
    `enum abstract ${getBindingTargetNameHaxe(declaration.binding, context)}(${underlying}) from ${underlying} to ${underlying} {`,
  ];
  declaration.members.forEach((member) => {
    const value = typeof member.value === 'string' ? JSON.stringify(member.value) : String(member.value);
    lines.push(`  var ${safeHaxeName(member.name)} = ${value};`);
  });
  lines.push('}');
  return lines;
}

function emitCompilerHaxeTaskFunctionBody(source: object, context: EmitContext): readonly string[] {
  const functionPlan = context.taskFunctions.get(source);
  if (!functionPlan) emissionError(context, 'async function has no Haxe task lowering plan');
  return emitCompilerHaxeTaskLoweringFunction(functionPlan, context.taskLowering.runtime, context.module, {
    emitExpression: (expression) => emitExpression(expression, context),
    emitStatement: (statement) => emitStatement(statement, context),
    fail: (message) => emissionError(context, message),
    getBindingName: (binding) => getBindingTargetNameHaxe(binding, context),
    getGeneratedName: (preferredName) => getGeneratedTargetNameHaxe(preferredName, context),
  });
}

function emitExpression(expression: Readonly<IrExpression>, context: EmitContext): string {
  switch (expression.kind) {
    case 'array':
      return `[${expression.elements.map((element) => (element ? emitExpression(element, context) : 'null')).join(', ')}]`;
    case 'assignment': {
      const left = emitExpression(expression.left, context);
      const right = emitExpression(expression.right, context);
      return `${left} ${emitAssignmentOperatorHaxe(expression.operator, expression.semantics, context)} ${right}`;
    }
    case 'await':
      emissionError(context, 'await requires the Haxe async-lowering pass');
    case 'binary': {
      const left = emitExpression(expression.left, context);
      const right = emitExpression(expression.right, context);
      return `(${left} ${emitBinaryOperatorHaxe(expression.operator, expression.semantics, context)} ${right})`;
    }
    case 'call':
      if (expression.semantics.statementValue) return emitStatementValueExpressionHaxe(expression, context);
      return `${expression.callee.kind === 'function' ? `(${emitExpression(expression.callee, context)})` : emitExpression(expression.callee, context)}${expression.optional ? '?.' : ''}(${emitCallArgumentsHaxe(expression, context)})`;
    case 'cast':
      return `(cast ${emitExpression(expression.expression, context)} : ${emitType(expression.type, context)})`;
    case 'conditional':
      return `(${emitExpression(expression.condition, context)} ? ${emitExpression(expression.whenTrue, context)} : ${emitExpression(expression.whenFalse, context)})`;
    case 'element':
      if (expression.semantics.receivers.includes('object')) {
        if (expression.optional) {
          emissionError(context, 'optional computed object access requires reflective null-safe lowering');
        }
        if (expression.semantics.receivers.length !== 1 || expression.semantics.key !== 'string') {
          emissionError(context, 'computed object access requires unresolved JavaScript property-key coercion');
        }
        return `Reflect.field(${emitExpression(expression.object, context)}, ${emitExpression(expression.index, context)})`;
      }
      if (expression.semantics.receivers.includes('tuple')) {
        const index = getElementAccessTupleIndexHaxe(expression, context);
        return `${emitExpression(expression.object, context)}[${String(index)}]`;
      }
      return `${emitExpression(expression.object, context)}${expression.optional ? '?.' : ''}[${emitExpression(expression.index, context)}]`;
    case 'function':
      if (expression.typeParameters.length > 0)
        emissionError(context, 'generic function expressions are not valid Haxe values');
      if (expression.async) {
        return `function(${emitParameters(expression.parameters, context)}) {\n${indentSourceLines(
          emitCompilerHaxeTaskFunctionBody(expression, context),
        ).join('\n')}\n}`;
      }
      return expression.expression
        ? `function(${emitParameters(expression.parameters, context)}) return ${emitExpression(expression.expression, context)}`
        : `function(${emitParameters(expression.parameters, context)}) {\n${indentSourceLines(emitStatements(expression.body, context)).join('\n')}\n}`;
    case 'identifier':
      return emitIdentifierReferenceHaxe(expression.reference, context);
    case 'literal':
      return emitLiteral(expression.value);
    case 'new':
      if (expression.callee.kind !== 'identifier') {
        emissionError(context, 'qualified constructors require Haxe type-path lowering');
      }
      return `new ${emitExpression(expression.callee, context)}(${expression.arguments.map((argument) => emitExpression(argument, context)).join(', ')})`;
    case 'object':
      return `{ ${expression.members
        .map((member) => {
          if (member.kind !== 'property') {
            emissionError(context, 'structural object compatibility preflight accepted an unresolved member');
          }
          return `${safeHaxeName(member.name)}: ${emitExpression(member.value, context)}`;
        })
        .join(', ')} }`;
    case 'objectRest': {
      if (expression.excluded.some((key) => key.kind === 'computed' && key.coercion !== 'string')) {
        emissionError(context, 'computed object-rest exclusions require unresolved JavaScript property-key coercion');
      }
      const name = getGeneratedTargetNameHaxe('objectRestValue', context);
      const exclusions = expression.excluded
        .map(
          (key) =>
            `Reflect.deleteField(${name}, ${key.kind === 'named' ? JSON.stringify(key.name) : emitExpression(key.expression, context)});`,
        )
        .join(' ');
      return `(function() { final ${name} = Reflect.copy(${emitExpression(expression.object, context)}); ${exclusions} return ${name}; })()`;
    }
    case 'property':
      return `${emitExpression(expression.object, context)}${expression.optional ? '?.' : '.'}${safeHaxeName(expression.name)}`;
    case 'regexp':
      return `~/${expression.pattern}/${expression.flags}`;
    case 'spread':
      emissionError(context, 'spread expressions require call or collection lowering');
    case 'template':
      return expression.parts
        .map((part) => (typeof part === 'string' ? emitLiteral(part) : `Std.string(${emitExpression(part, context)})`))
        .join(' + ');
    case 'tuple':
      return `[${expression.elements
        .map((element) => (element.expression ? emitExpression(element.expression, context) : 'null'))
        .join(', ')}]`;
    case 'tupleSpread':
      return emitTupleSpreadExpressionHaxe(expression, context);
    case 'tupleRest':
      return `${emitExpression(expression.object, context)}.slice(${String(expression.start)})`;
    case 'tupleSuffix':
      return `${emitExpression(expression.object, context)}.slice(${String(expression.start)})`;
    case 'unary': {
      const operand = emitExpression(expression.operand, context);
      const operator = expression.postfix
        ? emitPostfixUnaryOperatorHaxe(expression.operator, expression.semantics, context)
        : emitPrefixUnaryOperatorHaxe(expression.operator, expression.semantics, context);
      return expression.postfix ? `${operand}${operator}` : `${operator} ${operand}`;
    }
    case 'undefinedValue':
      return 'null';
    case 'undefinedDefault':
      return `(${emitExpression(expression.value, context)} ?? ${emitExpression(expression.fallback, context)})`;
  }
}

function emitCallArgumentsHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string {
  const signature = expression.semantics.signature;
  if (
    signature &&
    signature.restParameter === undefined &&
    typeof signature.providedArgumentCount === 'number' &&
    signature.providedArgumentCount > signature.parameterCount
  ) {
    emissionError(context, 'extra JavaScript call arguments require target-neutral erasure lowering');
  }
  const defaulted = new Map(
    expression.semantics.defaultParameters?.provided.map((provided) => [provided.position, provided]) ?? [],
  );
  return expression.arguments
    .map((argument, index) => {
      if (defaulted.get(index)?.value === 'undefined') {
        emissionError(context, 'explicit undefined default arguments require Haxe omission lowering');
      }
      return emitExpression(argument, context);
    })
    .join(', ');
}

function emitStatementValueExpressionHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string {
  if (expression.callee.kind !== 'function' || expression.arguments.length > 0) {
    emissionError(context, 'statement-value call requires a zero-argument function carrier');
  }
  const completion = expression.callee.body.at(-1);
  if (completion?.kind !== 'return' || !completion.expression) {
    emissionError(context, 'statement-value call requires a final value return');
  }
  const statements = emitStatements(expression.callee.body.slice(0, -1), context);
  return `({ ${[...statements, `${emitExpression(completion.expression, context)};`].join(' ')} })`;
}

function emitFunction(declaration: Readonly<IrFunctionDeclaration>, context: EmitContext): string[] {
  const access = declaration.exported ? 'public ' : 'private ';
  return [
    `${access}static function ${getBindingTargetNameHaxe(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)}(${emitParameters(declaration.parameters, context)}):${emitType(declaration.returns, context)} {`,
    ...indentSourceLines(
      declaration.async
        ? emitCompilerHaxeTaskFunctionBody(declaration, context)
        : emitStatements(declaration.body, context),
    ),
    '}',
  ];
}

function emitImports(imports: readonly IrImport[], context: EmitContext): string[] {
  const emitted = new Set<string>();
  for (const imported of imports) {
    if (imported.bindings.length === 0) continue;
    const modulePath = haxeImportModule(imported.specifier, context);
    for (const binding of imported.bindings) {
      if (binding.imported === '*' || binding.imported === 'default') {
        emissionError(context, `${binding.imported} imports require explicit Haxe mapping for ${imported.specifier}`);
      }
      const importedName =
        binding.binding.space === 'type' || binding.binding.kind === 'class' || binding.binding.kind === 'enum'
          ? safeHaxeTypeName(binding.imported)
          : safeHaxeName(binding.imported);
      const localName = getBindingTargetNameHaxe(binding.binding, context);
      emitted.add(`import ${modulePath}.${importedName}${importedName === localName ? '' : ` as ${localName}`};`);
    }
  }
  return [...emitted].sort();
}

function emitInterface(declaration: Readonly<IrInterfaceDeclaration>, context: EmitContext): string[] {
  if (declaration.extends.length > 0)
    emissionError(context, `interface ${declaration.binding.name} inheritance requires structural flattening`);
  // A shape nothing implements stays a typedef, which is what keeps ordinary structural types
  // idiomatic. A shape a class implements has to be nominal, because Haxe `implements` names one.
  if (!hasIrModuleClassImplementingHaxe(declaration, context)) {
    return [
      `typedef ${getBindingTargetNameHaxe(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)} = ${emitAnonymousType(declaration.properties, context)};`,
    ];
  }
  return [
    `interface ${getBindingTargetNameHaxe(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)} {`,
    ...declaration.properties.map((property) => `  ${emitInterfaceMemberHaxe(property, context)}`),
    '}',
  ];
}

function emitInterfaceMemberHaxe(property: Readonly<IrObjectTypeProperty>, context: EmitContext): string {
  const name = safeHaxeName(property.name);
  if (property.type.kind !== 'function') {
    return `public var ${name}:${emitType(property.type, context)};`;
  }
  const parameters = property.type.parameters
    .map(
      (parameter, index) =>
        `${safeHaxeName(parameter.name ?? `argument${String(index)}`)}:${emitType(parameter.type, context)}`,
    )
    .join(', ');
  return `public function ${name}(${parameters}):${emitType(property.type.returns, context)};`;
}

function hasIrModuleClassImplementingHaxe(
  declaration: Readonly<IrInterfaceDeclaration>,
  context: EmitContext,
): boolean {
  return context.module.declarations.some(
    (candidate) =>
      candidate.kind === 'class' &&
      candidate.implements.some(
        (implemented) =>
          implemented.kind === 'named' &&
          implemented.reference.kind === 'binding' &&
          implemented.reference.binding.id === declaration.binding.id,
      ),
  );
}

function emitIdentifierReferenceHaxe(reference: Readonly<IrIdentifierReference>, context: EmitContext): string {
  if (reference.kind === 'super') return 'super';
  if (reference.kind === 'this') return 'this';
  if (reference.kind === 'ambient') {
    if (reference.name === 'undefined') {
      emissionError(context, 'undefined expressions require Haxe nullability lowering');
    }
    const targetName = getCompilerRuntimeExternalSymbolTargetHaxe(
      reference.name,
      'value',
      context.options.runtimeModule,
    );
    if (!targetName) emissionError(context, `external value ${reference.name} has no Haxe binding`);
    return targetName;
  }
  return getBindingTargetNameHaxe(reference.binding, context);
}

function emitIrClassFieldInitializationsHaxe(
  declaration: Readonly<IrClassDeclaration>,
  initialization: ReturnType<typeof createIrClassInitializationPlan>,
  timing: 'base-constructor-body-entry' | 'derived-super-return' | 'derived-super-return-after-fields',
  context: EmitContext,
): string[] {
  return initialization.fields.flatMap((fieldInitialization) => {
    if (fieldInitialization.timing !== timing) return [];
    const field = declaration.fields[fieldInitialization.fieldIndex]!;
    const target = `this.${safeHaxeName(field.name)}`;
    if (fieldInitialization.value === 'initializer') {
      return [`${target} = ${emitExpression(field.initializer!, context)};`];
    }
    if (fieldInitialization.value === 'parameter') {
      const parameter = declaration.classConstructor!.parameters[fieldInitialization.parameterIndex]!;
      return [`${target} = ${getBindingTargetNameHaxe(parameter.binding, context)};`];
    }
    return [];
  });
}

function isIrClassErrorSubclassHaxe(declaration: Readonly<IrClassDeclaration>): boolean {
  return declaration.extends?.reference.kind === 'ambient' && declaration.extends.reference.name === 'Error';
}

function isIrExpressionSuperConstructorCallHaxe(expression: Readonly<IrExpression>): boolean {
  return (
    expression.kind === 'call' &&
    expression.callee.kind === 'identifier' &&
    expression.callee.reference.kind === 'super'
  );
}

function isIrStatementSuperConstructorCall(statement: Readonly<IrStatement>): boolean {
  return statement.kind === 'expression' && isIrExpressionSuperConstructorCallHaxe(statement.expression);
}

function emitLiteral(value: boolean | null | number | string): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  return String(value);
}

function emitModuleValue(
  declaration: Readonly<IrFunctionDeclaration | IrVariableDeclaration>,
  context: EmitContext,
): string[] {
  return declaration.kind === 'function'
    ? emitFunction(declaration, context)
    : emitVariableDeclaration(declaration, context);
}

function emitParameters(parameters: readonly IrParameter[], context: EmitContext): string {
  return parameters
    .map((parameter) => {
      const name = getBindingTargetNameHaxe(parameter.binding, context);
      const type = emitType(parameter.type, context);
      if (parameter.rest) return `...${name}:${type}`;
      if (parameter.initializer) return `${name}:${type} = ${emitExpression(parameter.initializer, context)}`;
      if (parameter.optional && hasIrTypeNullMemberHaxe(parameter.type)) {
        emissionError(context, 'optional nullable parameters require distinct Haxe null and undefined sentinels');
      }
      return `${parameter.optional ? '?' : ''}${name}:${type}`;
    })
    .join(', ');
}

function emitStatement(statement: Readonly<IrStatement>, context: EmitContext): string[] {
  switch (statement.kind) {
    case 'block':
      if (!statement.label) return ['{', ...indentSourceLines(emitStatements(statement.statements, context)), '}'];
      return emitControlFlowBoundaryHaxe(statement.label, false, context, () => [
        'do {',
        ...indentSourceLines(emitStatements(statement.statements, context)),
        '} while (false);',
      ]);
    case 'break':
      return statement.target ? emitControlFlowExitHaxe(statement.target, false, context) : ['break;'];
    case 'continue':
      return statement.target ? emitControlFlowExitHaxe(statement.target, true, context) : ['continue;'];
    case 'do':
      return emitControlFlowBoundaryHaxe(statement.label, true, context, () => [
        'do {',
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        `} while (${emitExpression(statement.condition, context)});`,
      ]);
    case 'expression':
      return [`${emitExpression(statement.expression, context)};`];
    case 'for':
      emissionError(context, 'C-style for loops require control-flow lowering before Haxe emission');
    case 'forIn':
      if ('pattern' in statement.variable)
        emissionError(context, 'binding patterns require destructuring lowering before Haxe emission');
      const forInBinding = statement.variable.binding;
      const forInKeyPlan = statement.keyPlan;
      if (forInKeyPlan?.evaluation === 'preserve') {
        const objectName = getGeneratedTargetNameHaxe('forInObjectValue', context);
        return emitControlFlowBoundaryHaxe(statement.label, true, context, () => [
          '{',
          `  final ${objectName} = ${emitExpression(statement.object, context)};`,
          `  for (${getBindingTargetNameHaxe(forInBinding, context)} in [${forInKeyPlan.keys.map((key) => JSON.stringify(key)).join(', ')}]) {`,
          ...indentSourceLines(emitStatementBody(statement.body, context), 2),
          '  }',
          '}',
        ]);
      }
      return emitControlFlowBoundaryHaxe(statement.label, true, context, () => [
        `for (${getBindingTargetNameHaxe(forInBinding, context)} in ${forInKeyPlan ? `[${forInKeyPlan.keys.map((key) => JSON.stringify(key)).join(', ')}]` : `Reflect.fields(${emitExpression(statement.object, context)})`}) {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ]);
    case 'forOf':
      if (statement.await) emissionError(context, 'async iteration requires the Haxe async-lowering pass');
      if ('pattern' in statement.variable)
        emissionError(context, 'binding patterns require destructuring lowering before Haxe emission');
      const forOfBinding = statement.variable.binding;
      return emitControlFlowBoundaryHaxe(statement.label, true, context, () => [
        `for (${getBindingTargetNameHaxe(forOfBinding, context)} in ${emitExpression(statement.iterable, context)}) {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ]);
    case 'if': {
      const lines = [
        `if (${emitExpression(statement.condition, context)}) {`,
        ...indentSourceLines(emitStatementBody(statement.consequent, context)),
        '}',
      ];
      if (statement.otherwise)
        lines.push('else {', ...indentSourceLines(emitStatementBody(statement.otherwise, context)), '}');
      return lines;
    }
    case 'return':
      return [`return${statement.expression ? ` ${emitExpression(statement.expression, context)}` : ''};`];
    case 'switch': {
      if (statement.label) {
        emissionError(context, `labeled switch ${statement.label.name} requires Haxe switch completion lowering`);
      }
      assertNoSwitchFallthrough(statement, context);
      const lines = [`switch (${emitExpression(statement.expression, context)}) {`];
      for (const clause of statement.cases) {
        lines.push(`  ${clause.expression ? `case ${emitExpression(clause.expression, context)}` : 'default'}:`);
        lines.push(
          ...indentSourceLines(
            emitStatements(
              clause.statements.filter((item) => item.kind !== 'break'),
              context,
            ),
            2,
          ),
        );
      }
      lines.push('}');
      return lines;
    }
    case 'throw':
      return [`throw ${emitExpression(statement.expression, context)};`];
    case 'try':
      if (statement.finallyBody) emissionError(context, 'finally blocks require completion-preserving Haxe lowering');
      return [
        'try {',
        ...indentSourceLines(emitStatementBody(statement.tryBody, context)),
        '}',
        ...(statement.catchClause
          ? [
              `catch (${statement.catchClause.binding ? getBindingTargetNameHaxe(statement.catchClause.binding, context) : 'error'}:Dynamic) {`,
              ...indentSourceLines(emitStatementBody(statement.catchClause.body, context)),
              '}',
            ]
          : []),
      ];
    case 'variable':
      return statement.declarations.map((variable) => emitVariable(variable, context));
    case 'while':
      return emitControlFlowBoundaryHaxe(statement.label, true, context, () => [
        `while (${emitExpression(statement.condition, context)}) {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ]);
  }
}

function emitControlFlowBoundaryHaxe(
  label: Readonly<IrControlFlowLabelIdentity> | undefined,
  continuable: boolean,
  context: EmitContext,
  emit: () => string[],
): string[] {
  context.breakableDepth += 1;
  const controlFlowLabel = label
    ? {
        continuable,
        depth: context.breakableDepth,
        identity: label,
        stateName: getGeneratedTargetNameHaxe(`${label.name}ControlFlowState`, context),
      }
    : undefined;
  if (controlFlowLabel) context.controlFlowLabels.push(controlFlowLabel);
  const lines = emit();
  if (controlFlowLabel) context.controlFlowLabels.pop();
  context.breakableDepth -= 1;
  return [
    ...(controlFlowLabel ? [`var ${controlFlowLabel.stateName}:Int = 0;`] : []),
    ...lines,
    ...emitControlFlowPropagationHaxe(context),
  ];
}

function emitControlFlowExitHaxe(
  target: Readonly<IrControlFlowLabelIdentity>,
  continuing: boolean,
  context: EmitContext,
): string[] {
  const label = [...context.controlFlowLabels].reverse().find((candidate) => candidate.identity.id === target.id);
  if (!label) emissionError(context, `control-flow target ${target.name} is not active during Haxe emission`);
  if (continuing && !label.continuable) {
    emissionError(context, `continue target ${target.name} is not a Haxe loop boundary`);
  }
  if (label.depth === context.breakableDepth) return [continuing ? 'continue;' : 'break;'];
  return [`${label.stateName} = ${continuing ? '2' : '1'};`, 'break;'];
}

function emitControlFlowPropagationHaxe(context: EmitContext): string[] {
  const lines: string[] = [];
  for (const label of [...context.controlFlowLabels].reverse()) {
    if (label.depth === context.breakableDepth) {
      lines.push(`if (${label.stateName} == 1) { ${label.stateName} = 0; break; }`);
      if (label.continuable) {
        lines.push(`if (${label.stateName} == 2) { ${label.stateName} = 0; continue; }`);
      }
      continue;
    }
    if (label.depth < context.breakableDepth) {
      lines.push(`if (${label.stateName} != 0) { break; }`);
    }
  }
  return lines;
}

function emitStatementBody(statement: Readonly<IrStatement>, context: EmitContext): string[] {
  return statement.kind === 'block' ? emitStatements(statement.statements, context) : emitStatement(statement, context);
}

function emitStatements(statements: readonly IrStatement[], context: EmitContext): string[] {
  return statements.flatMap((statement) => emitStatement(statement, context));
}

function emitType(type: Readonly<IrType>, context: EmitContext): string {
  switch (type.kind) {
    case 'array':
      return `Array<${emitType(type.element, context)}>`;
    case 'function':
      return `${type.parameters.map((parameter) => emitType(parameter.type, context)).join('->')}->${emitType(type.returns, context)}`;
    case 'indexedAccess':
    case 'keyof':
    case 'typeOf':
      return 'Dynamic';
    case 'intersection':
      return type.types.length === 1 ? emitType(type.types[0]!, context) : 'Dynamic';
    case 'literal':
      return typeof type.value === 'boolean' ? 'Bool' : typeof type.value === 'number' ? 'Float' : 'String';
    case 'named': {
      const sourceName = type.reference.kind === 'ambient' ? type.reference.name : undefined;
      if (
        (sourceName === 'Readonly' || sourceName === 'Partial' || sourceName === 'Required') &&
        type.typeArguments[0]
      ) {
        return emitType(type.typeArguments[0], context);
      }
      const arguments_ = type.typeArguments.map((argument) => emitType(argument, context));
      return `${getTypeReferenceTargetNameHaxe(type, context)}${arguments_.length > 0 ? `<${arguments_.join(', ')}>` : ''}`;
    }
    case 'never':
      return 'Dynamic';
    case 'null':
    case 'undefined':
      return 'Dynamic';
    case 'object':
      return emitAnonymousType(type.properties, context);
    case 'primitive':
      return {
        bigint: 'haxe.Int64',
        boolean: 'Bool',
        number: 'Float',
        string: 'String',
        symbol: 'Dynamic',
        void: 'Void',
      }[type.name];
    case 'tuple':
      return 'Array<Dynamic>';
    case 'union': {
      const concrete = type.types.filter((item) => item.kind !== 'null' && item.kind !== 'undefined');
      if (hasIrTypeNullMemberHaxe(type) && hasIrTypeUndefinedMemberHaxe(type)) {
        emissionError(context, 'types containing both null and undefined require distinct Haxe sentinels');
      }
      return concrete.length === 1 && concrete.length !== type.types.length
        ? `Null<${emitType(concrete[0]!, context)}>`
        : 'Dynamic';
    }
    case 'unknown':
      return 'Dynamic';
  }
}

function hasIrTypeNullMemberHaxe(type: Readonly<IrType>): boolean {
  return type.kind === 'null' || (type.kind === 'union' && type.types.some((member) => member.kind === 'null'));
}

function hasIrTypeUndefinedMemberHaxe(type: Readonly<IrType>): boolean {
  return (
    type.kind === 'undefined' || (type.kind === 'union' && type.types.some((member) => member.kind === 'undefined'))
  );
}

function emitAnonymousType(properties: readonly IrObjectTypeProperty[], context: EmitContext): string {
  return `{ ${properties
    .map(
      (property) => `${property.optional ? '?' : ''}${safeHaxeName(property.name)}:${emitType(property.type, context)}`,
    )
    .join(', ')} }`;
}

function emitTypeDeclaration(declaration: Readonly<IrDeclaration>, context: EmitContext): string[] {
  switch (declaration.kind) {
    case 'class':
      return emitClass(declaration, context);
    case 'enum':
      return emitEnum(declaration, context);
    case 'interface':
      return emitInterface(declaration, context);
    case 'typeAlias':
      return emitTypeAlias(declaration, context);
    default:
      emissionError(context, `unexpected ${declaration.kind} declaration in type emission`);
  }
}

function emitTypeAlias(declaration: Readonly<IrTypeAliasDeclaration>, context: EmitContext): string[] {
  return [
    `typedef ${getBindingTargetNameHaxe(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)} = ${emitType(declaration.type, context)};`,
  ];
}

function emitTupleSpreadExpressionHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'tupleSpread' }>>,
  context: EmitContext,
): string {
  const declarations: string[] = [];
  const elements: string[] = [];
  for (const segment of expression.segments) {
    if (segment.kind === 'element') {
      if (!segment.element.expression) {
        elements.push('null');
        continue;
      }
      const name = getGeneratedTargetNameHaxe('tupleSpreadElement', context);
      declarations.push(`final ${name} = ${emitExpression(segment.element.expression, context)};`);
      elements.push(name);
      continue;
    }
    const name = getGeneratedTargetNameHaxe('tupleSpreadValue', context);
    declarations.push(`final ${name} = ${emitExpression(segment.expression, context)};`);
    segment.type.elements.forEach((_, index) => elements.push(`${name}[${String(index)}]`));
  }
  return `(function() { ${declarations.join(' ')} return [${elements.join(', ')}]; })()`;
}

function emitTypeParameters(parameters: readonly IrTypeParameter[], context: EmitContext): string {
  if (parameters.length === 0) return '';
  return `<${parameters
    .map(
      (parameter) =>
        `${getBindingTargetNameHaxe(parameter.binding, context)}${parameter.constraint ? `:${emitType(parameter.constraint, context)}` : ''}`,
    )
    .join(', ')}>`;
}

function emitVariable(variable: Readonly<IrVariable>, context: EmitContext): string {
  if ('pattern' in variable)
    emissionError(context, 'binding patterns require destructuring lowering before Haxe emission');
  if (variable.initialValue === 'undefined') {
    return `var ${getBindingTargetNameHaxe(variable.binding, context)}:Dynamic = null;`;
  }
  const type = variable.type ? `:${emitType(variable.type, context)}` : '';
  const initializer = variable.initializer ? ` = ${emitExpression(variable.initializer, context)}` : '';
  return `${variable.mutable ? 'var' : 'final'} ${getBindingTargetNameHaxe(variable.binding, context)}${type}${initializer};`;
}

function emitVariableDeclaration(declaration: Readonly<IrVariableDeclaration>, context: EmitContext): string[] {
  if ('pattern' in declaration)
    emissionError(context, 'binding patterns require destructuring lowering before Haxe emission');
  if (!declaration.initializer)
    emissionError(context, `module variable ${declaration.binding.name} requires an initializer`);
  const access = declaration.exported ? 'public ' : 'private ';
  const storage = declaration.mutable ? 'var' : 'final';
  const type = declaration.type ? `:${emitType(declaration.type, context)}` : '';
  return [
    `${access}static ${storage} ${getBindingTargetNameHaxe(declaration.binding, context)}${type} = ${emitExpression(declaration.initializer, context)};`,
  ];
}

function getBindingTargetNameHaxe(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  context: EmitContext,
): string {
  const targetName = context.targetNames.get(binding.id);
  if (!targetName) emissionError(context, `binding ${binding.name} has no Haxe target name allocation`);
  return targetName;
}

function getGeneratedTargetNameHaxe(preferredName: string, context: EmitContext): string {
  let name = preferredName;
  for (let suffix = 2; context.generatedNames.has(name); suffix += 1) name = `${preferredName}_${String(suffix)}`;
  context.generatedNames.add(name);
  return name;
}

function getElementAccessTupleIndexHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
  context: EmitContext,
): number {
  if (
    expression.semantics.receivers.length !== 1 ||
    expression.index.kind !== 'literal' ||
    typeof expression.index.value !== 'number' ||
    !Number.isSafeInteger(expression.index.value) ||
    expression.index.value < 0
  ) {
    emissionError(context, 'tuple projection requires one statically known nonnegative integer index');
  }
  return expression.index.value;
}

function getTypeReferenceTargetNameHaxe(type: Readonly<IrTypeReference>, context: EmitContext): string {
  if (type.reference.kind === 'ambient') {
    const targetName = getCompilerRuntimeExternalSymbolTargetHaxe(
      type.reference.name,
      'type',
      context.options.runtimeModule ?? 'flighthq._internal',
    );
    if (!targetName) emissionError(context, `external type ${type.reference.name} has no Haxe binding`);
    return targetName;
  }
  return [
    getBindingTargetNameHaxe(type.reference.binding, context),
    ...type.reference.path.map((segment) => safeHaxeTypeName(segment)),
  ].join('.');
}

function emissionError(context: EmitContext, message: string): never {
  throw createBackendEmissionFailure('haxe', context.module, message);
}

function haxeImportModule(specifier: string, context: EmitContext): string {
  if (specifier.startsWith('.')) {
    const target = path.posix.normalize(
      path.posix.join(path.posix.dirname(context.module.source), specifier.replace(/\.[cm]?js$/u, '.ts')),
    );
    return `${context.packageName}.${haxeImplementationModule(target)}`;
  }
  if (specifier.startsWith('@')) {
    const packageName = /^(@[^/]+\/[^/]+)/u.exec(specifier)?.[1];
    if (!packageName) emissionError(context, `cannot identify package import ${specifier}`);
    const haxePackage = convertPackageNameToHaxePackageName(packageName, context.options.rootPackage);
    const packageModule = pascalCase(haxePackage.split('.').at(-1)!);
    return `${haxePackage}.${packageModule}`;
  }
  emissionError(context, `external import ${specifier} requires a runtime or standard-library mapping`);
}

function haxeImplementationModule(sourcePath: string): string {
  const filename = path.posix.basename(sourcePath).replace(/\.tsx?$/u, '');
  return convertSourcePathToHaxeModuleName(sourcePath) ?? `_${pascalCase(filename)}`;
}

function emitAssignmentOperatorHaxe(
  operator: IrAssignmentOperator,
  semantics: Readonly<IrAssignmentOperatorSemantics>,
  context: EmitContext,
): string {
  const emitted = haxeAssignmentOperatorEmission[operator];
  if (!emitted) emissionError(context, `operator ${operator} requires Haxe semantic lowering`);
  if (!isAssignmentOperatorDirectHaxe(operator, semantics)) {
    emissionError(
      context,
      `operator ${operator} on ${semantics.left.flow} and ${semantics.right.flow} requires Haxe type-directed lowering`,
    );
  }
  return emitted;
}

function emitBinaryOperatorHaxe(
  operator: IrBinaryOperator,
  semantics: Readonly<IrBinaryOperatorSemantics>,
  context: EmitContext,
): string {
  const emitted = haxeBinaryOperatorEmission[operator];
  if (!emitted) emissionError(context, `operator ${operator} requires Haxe semantic lowering`);
  if (!isBinaryOperatorDirectHaxe(operator, semantics)) {
    emissionError(
      context,
      `operator ${operator} on ${semantics.left.flow} and ${semantics.right.flow} requires Haxe type-directed lowering`,
    );
  }
  return emitted;
}

function emitPostfixUnaryOperatorHaxe(
  operator: IrPostfixUnaryOperator,
  semantics: Readonly<IrUnaryOperatorSemantics>,
  context: EmitContext,
): string {
  if (semantics.operand.flow !== 'number' || semantics.result !== 'number') {
    emissionError(context, `operator ${operator} on ${semantics.operand.flow} requires Haxe type-directed lowering`);
  }
  return haxePostfixUnaryOperatorEmission[operator];
}

function emitPrefixUnaryOperatorHaxe(
  operator: IrPrefixUnaryOperator,
  semantics: Readonly<IrUnaryOperatorSemantics>,
  context: EmitContext,
): string {
  const emitted = haxePrefixUnaryOperatorEmission[operator];
  if (!emitted) emissionError(context, `operator ${operator} requires Haxe semantic lowering`);
  if (!isPrefixUnaryOperatorDirectHaxe(operator, semantics)) {
    emissionError(context, `operator ${operator} on ${semantics.operand.flow} requires Haxe type-directed lowering`);
  }
  return emitted;
}

function isAssignmentOperatorDirectHaxe(
  operator: IrAssignmentOperator,
  semantics: Readonly<IrAssignmentOperatorSemantics>,
): boolean {
  if (operator === '=') return true;
  if (operator === '+=') return hasMatchingOperatorDomains(semantics, ['number', 'string']);
  if (operator === '%=' || operator === '*=' || operator === '-=' || operator === '/=') {
    return hasMatchingOperatorDomains(semantics, ['number']);
  }
  return false;
}

function isBinaryOperatorDirectHaxe(
  operator: IrBinaryOperator,
  semantics: Readonly<IrBinaryOperatorSemantics>,
): boolean {
  if (operator === '+') return hasMatchingOperatorDomains(semantics, ['number', 'string']);
  if (operator === '%' || operator === '*' || operator === '-' || operator === '/') {
    return hasMatchingOperatorDomains(semantics, ['number']);
  }
  if (operator === '<' || operator === '<=' || operator === '>' || operator === '>=') {
    return semantics.left.flow === 'number' && semantics.right.flow === 'number' && semantics.result === 'boolean';
  }
  if (operator === '&&' || operator === '||') {
    return hasMatchingOperatorDomains(semantics, ['boolean']);
  }
  if (operator === '===' || operator === '!==') {
    return (
      semantics.left.flow === semantics.right.flow &&
      semantics.result === 'boolean' &&
      (semantics.left.flow === 'boolean' || semantics.left.flow === 'number' || semantics.left.flow === 'string')
    );
  }
  return false;
}

function isPrefixUnaryOperatorDirectHaxe(
  operator: IrPrefixUnaryOperator,
  semantics: Readonly<IrUnaryOperatorSemantics>,
): boolean {
  if (operator === '!') return semantics.operand.flow === 'boolean' && semantics.result === 'boolean';
  if (operator === '+' || operator === '-' || operator === '++' || operator === '--') {
    return semantics.operand.flow === 'number' && semantics.result === 'number';
  }
  return false;
}

function hasMatchingOperatorDomains(
  semantics: Readonly<IrAssignmentOperatorSemantics | IrBinaryOperatorSemantics>,
  supported: readonly IrAssignmentOperatorSemantics['left']['flow'][],
): boolean {
  return (
    semantics.left.flow === semantics.right.flow &&
    semantics.left.flow === semantics.result &&
    supported.includes(semantics.left.flow)
  );
}

function assertNoSwitchFallthrough(statement: Extract<IrStatement, { kind: 'switch' }>, context: EmitContext): void {
  statement.cases.slice(0, -1).forEach((clause) => {
    const last = clause.statements.at(-1);
    if (!last || (last.kind !== 'break' && last.kind !== 'return' && last.kind !== 'throw')) {
      emissionError(context, 'switch fallthrough requires control-flow lowering before Haxe emission');
    }
  });
}

function assertStructuralObjectCompatibilityHaxe(
  module: Readonly<IrModule>,
  modules: readonly Readonly<IrModule>[],
  resolution: Readonly<CompilerModuleResolutionPlan> | undefined,
): void {
  const diagnostic = analyzeIrModuleStructuralObjectCompatibilityAcrossModules(
    module,
    modules,
    resolution,
  ).diagnostics.find(
    (candidate) =>
      candidate.code !== 'open-construction-target' && candidate.code !== 'unresolved-named-construction-target',
  );
  if (diagnostic) {
    throw createBackendEmissionFailure(
      'haxe',
      module,
      `structural object compatibility ${diagnostic.code} at ${JSON.stringify(diagnostic.path)}: ${diagnostic.message}`,
    );
  }
}

function replaceIrModuleBackendContext(
  modules: readonly Readonly<IrModule>[],
  replacement: Readonly<IrModule>,
): readonly Readonly<IrModule>[] {
  return modules.map((module) =>
    module.packageName === replacement.packageName &&
    module.source === replacement.source &&
    module.name === replacement.name
      ? replacement
      : module,
  );
}

function assertRuntimeExternalSymbolBindingsHaxe(module: Readonly<IrModule>): void {
  const completeness = analyzeCompilerRuntimeExternalSymbolCompleteness(
    collectIrModulesRuntimeExternalSymbolIdentities([module]),
    createCompilerRuntimeExternalSymbolBindingPlanHaxe(),
  );
  if (completeness.kind === 'complete') return;
  const problems = [
    completeness.missingExternalSymbols.length > 0
      ? `missing: ${completeness.missingExternalSymbols.map(formatRuntimeExternalSymbolIdentity).join(', ')}`
      : undefined,
    completeness.duplicateExternalSymbols.length > 0
      ? `duplicate: ${completeness.duplicateExternalSymbols.map(formatRuntimeExternalSymbolIdentity).join(', ')}`
      : undefined,
  ].filter((problem): problem is string => problem !== undefined);
  throw createBackendEmissionFailure(
    'haxe',
    module,
    `runtime external symbol binding plan is incomplete (${problems.join('; ')})`,
  );
}

function assertRuntimeExternalConstructorAbiHaxe(module: Readonly<IrModule>): void {
  const completeness = analyzeCompilerRuntimeExternalConstructorAbiCompleteness(
    collectIrModulesRuntimeExternalConstructorInvocations([module]),
    createCompilerRuntimeExternalConstructorAbiPlanHaxe(),
  );
  if (completeness.kind === 'complete') return;
  const problems = [
    completeness.missingExternalConstructors.length > 0
      ? `missing: ${completeness.missingExternalConstructors.map(formatRuntimeExternalConstructorInvocation).join(', ')}`
      : undefined,
    completeness.duplicateExternalConstructors.length > 0
      ? `duplicate: ${completeness.duplicateExternalConstructors.map(formatRuntimeExternalSymbolIdentity).join(', ')}`
      : undefined,
    completeness.invalidExternalConstructors.length > 0
      ? `invalid: ${completeness.invalidExternalConstructors.map(formatRuntimeExternalSymbolIdentity).join(', ')}`
      : undefined,
  ].filter((problem): problem is string => problem !== undefined);
  throw createBackendEmissionFailure(
    'haxe',
    module,
    `runtime external constructor ABI plan is incomplete (${problems.join('; ')})`,
  );
}

function formatRuntimeExternalConstructorInvocation(
  invocation: Readonly<{
    externalSymbol: { sourceName: string; space: string };
    providedArgumentCount: number | 'dynamic';
  }>,
): string {
  return `${formatRuntimeExternalSymbolIdentity(invocation.externalSymbol)}(${invocation.providedArgumentCount === 'dynamic' ? '...' : String(invocation.providedArgumentCount)})`;
}

function formatRuntimeExternalSymbolIdentity(identity: Readonly<{ sourceName: string; space: string }>): string {
  return `${identity.sourceName}[${identity.space}]`;
}

function pascalCase(value: string): string {
  const match = /^(?<prefix>_*)(?<name>.*)$/u.exec(value);
  const prefix = match?.groups?.prefix ?? '';
  const name = match?.groups?.name ?? value;
  return `${prefix}${name
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('')}`;
}

function safeHaxeName(name: string): string {
  return haxeKeywords.has(name) ? `${name}_` : name;
}

function safeHaxeTypeName(name: string): string {
  return safeHaxeName(pascalCase(name));
}

const haxeKeywords = new Set([
  'abstract',
  'break',
  'case',
  'cast',
  'catch',
  'class',
  'continue',
  'default',
  'do',
  'dynamic',
  'else',
  'enum',
  'extends',
  'extern',
  'false',
  'final',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'inline',
  'interface',
  'macro',
  'new',
  'null',
  'operator',
  'overload',
  'override',
  'package',
  'private',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typedef',
  'untyped',
  'using',
  'var',
  'while',
]);

const haxeAssignmentOperatorEmission = {
  '%=': '%=',
  '&&=': undefined,
  '&=': '&=',
  '**=': undefined,
  '*=': '*=',
  '+=': '+=',
  '-=': '-=',
  '/=': '/=',
  '<<=': '<<=',
  '=': '=',
  '>>=': '>>=',
  '>>>=': undefined,
  '??=': undefined,
  '^=': '^=',
  '|=': '|=',
  '||=': undefined,
} as const satisfies Readonly<Record<IrAssignmentOperator, string | undefined>>;

const haxeBinaryOperatorEmission = {
  '%': '%',
  '&': '&',
  '&&': '&&',
  '*': '*',
  '**': undefined,
  '+': '+',
  ',': undefined,
  '-': '-',
  '/': '/',
  '<': '<',
  '<<': '<<',
  '<=': '<=',
  '!=': '!=',
  '!==': '!=',
  '==': '==',
  '===': '==',
  '>': '>',
  '>=': '>=',
  '>>': '>>',
  '>>>': undefined,
  '??': undefined,
  '^': '^',
  in: undefined,
  instanceof: undefined,
  '|': '|',
  '||': '||',
} as const satisfies Readonly<Record<IrBinaryOperator, string | undefined>>;

const haxePostfixUnaryOperatorEmission = {
  '++': '++',
  '--': '--',
} as const satisfies Readonly<Record<IrPostfixUnaryOperator, string>>;

const haxePrefixUnaryOperatorEmission = {
  '!': '!',
  '+': '+',
  '++': '++',
  '-': '-',
  '--': '--',
  delete: undefined,
  typeof: undefined,
  void: undefined,
  '~': '~',
} as const satisfies Readonly<Record<IrPrefixUnaryOperator, string | undefined>>;
