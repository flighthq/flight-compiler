import path from 'node:path';

import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import {
  collectIrModuleNullableBindingIds,
  createBackendEmissionFailure,
  createCompilerGeneratedFileHeader,
  createIrModuleTargetNameAllocation,
  getIrUnionTypeStringLiteralValues,
  hasIrTypeAbsentMember,
  indentSourceLines,
  normalizeSourceTextGrouping,
  isCompilerTargetNameAllocationFailure,
} from '../../compiler-emission/src/index.js';
import { analyzeIrModuleTraversal, getIrModuleTraversalPathValue } from '../../compiler-ir-traversal/src/index.js';
import {
  createCompilerLoweringPassAwaitConditionHoisting,
  createCompilerLoweringPassBindingPattern,
  createCompilerLoweringPassCStyleFor,
  createCompilerLoweringPassExtraArgumentErasure,
  createCompilerLoweringPassFinallyAwaitHoisting,
  createCompilerLoweringPassInterfaceInheritance,
  createCompilerLoweringPassSwitchFallthrough,
  createCompilerLoweringPassSwitchSuspension,
  createCompilerLoweringPassVariableHoisting,
  createIrClassInitializationPlan,
  lowerIrModuleWithCompilerPasses,
} from '../../compiler-lowering/src/index.js';
import {
  createCompilerModuleEvaluationPlan,
  createCompilerModuleFacadePlanForEntries,
} from '../../compiler-module/src/index.js';
import {
  analyzeCompilerRuntimeExternalConstructorAbiCompleteness,
  analyzeCompilerRuntimeExternalSymbolCompleteness,
  collectIrModulesRuntimeExternalConstructorInvocations,
  collectIrModulesRuntimeExternalSymbolIdentities,
} from '../../compiler-runtime-contract/src/index.js';
import {
  analyzeIrModuleStructuralObjectCompatibilityAcrossModules,
  createIrTypeParameterSubstitutionPlan,
  createIrModuleStructuralObjectCompatibilityAnalyzer,
  resolveIrTypeStructuralSubstitution,
} from '../../compiler-structural/src/index.js';
import { analyzeIrModuleAsyncStateMachines } from '../../compiler-task/src/index.js';
import type {
  CompilerBackend,
  CompilerHaxeTaskLowering,
  CompilerHaxeTaskLoweringFunction,
  CompilerLoweringPass,
  CompilerModuleFacadePlan,
  CompilerModuleFacadeSlot,
  CompilerModuleIdentity,
  CompilerModuleLinkDependency,
  CompilerModuleResolutionPlan,
  CompilerStructuralObjectCompatibilityReport,
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
  IrExport,
  IrExpression,
  IrFunctionDeclaration,
  IrIdentifierReference,
  IrImport,
  IrInterfaceDeclaration,
  IrModule,
  IrObjectExpression,
  IrObjectTypeProperty,
  IrParameter,
  IrPostfixUnaryOperator,
  IrPrefixUnaryOperator,
  IrStatement,
  IrType,
  IrTypeAliasDeclaration,
  IrTypeBindingIdentity,
  IrTypeParameter,
  IrUnaryOperatorSemantics,
  IrVariable,
  IrVariableDeclaration,
} from '../../compiler-types/src/index.js';
import { getCompilerHaxeAmbientMemberBinding } from './haxeAmbientMemberBinding.js';
import { createCompilerLoweringPassAsyncIterationHaxe } from './haxeAsyncIterationLowering.js';
import { convertPackageNameToHaxePackageName, convertSourcePathToHaxeModuleName } from './haxeCompilerIdentity.js';
import { createHaxeExternEmissionIndex, emitIrModuleHaxeExternWithContext } from './haxeExternEmission.js';
import { createCompilerRuntimeExternalConstructorAbiPlanHaxe } from './haxeRuntimeExternalConstructorAbi.js';
import {
  canEraseCompilerAmbientUtilityHeritageHaxe,
  getCompilerAmbientUtilityHeritageTargetHaxe,
  getCompilerRuntimeExternalMemberTargetHaxe,
  createCompilerRuntimeExternalSymbolBindingPlanHaxe,
  getCompilerRuntimeExternalSymbolTargetHaxe,
} from './haxeRuntimeExternalSymbolBinding.js';
import { createCompilerRuntimeTaskCapabilityPlanHaxe } from './haxeRuntimeTaskCapability.js';
import { emitCompilerHaxeTaskLoweringFunction } from './haxeTaskEmission.js';
import { createCompilerHaxeRuntimeAbiManifest } from './haxeRuntimeAbiManifest.js';
import { isCompilerHaxeTaskLoweringFailure, lowerCompilerAsyncStateMachinesHaxe } from './haxeTaskLowering.js';
import { emitIrTypeHaxe } from './haxeTypeEmission.js';

interface EmitContext {
  ambientUtilityHeritageTargets: ReadonlyMap<string, string>;
  breakableDepth: number;
  controlFlowLabels: HaxeControlFlowLabel[];
  facadeBindingTargetNames: Map<string, string>;
  facadeTypeTargetNames: ReadonlyMap<string, string>;
  finallyCompletion: HaxeFinallyCompletion | undefined;
  generatedNames: Set<string>;
  getModuleFacade: ((module: Readonly<IrModule>) => CompilerModuleFacadePlan | undefined) | undefined;
  machineNames: Map<string, string>;
  module: Readonly<IrModule>;
  moduleFacadeSlots: readonly Readonly<CompilerModuleFacadeSlot>[];
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined;
  nullableBindingIds: ReadonlySet<string>;
  objectAccessorClasses: string[][];
  options: Readonly<HaxeCompilerBackendOptions>;
  returnsAbsent: boolean;
  dynamicBindingIds: Set<string>;
  packageName: string;
  sourceModules: readonly Readonly<IrModule>[];
  sourceModuleTargetNames: WeakMap<object, ReadonlyMap<string, string>>;
  targetNames: ReadonlyMap<string, string>;
  taskFunctions: WeakMap<object, CompilerHaxeTaskLoweringFunction>;
  taskLowering: Readonly<CompilerHaxeTaskLowering>;
}

interface HaxeFinallyCompletion {
  readonly returnSignalName: string;
  readonly returnValueName: string | undefined;
  readonly returnedName: string;
}

interface HaxeControlFlowLabel {
  readonly continuable: boolean;
  readonly depth: number;
  readonly identity: Readonly<IrControlFlowLabelIdentity>;
  readonly stateName: string;
}

export function createHaxeCompilerBackend(): CompilerBackend<HaxeCompilerBackendOptions> {
  return {
    createEmissionSession({ moduleResolution, modules, options }) {
      const getModuleFacade = createCompilerModuleFacadePlannerHaxe(modules, moduleResolution);
      const externEmissionIndex = createHaxeExternEmissionIndex(modules, moduleResolution);
      const packageContractModules = new Map(
        [...new Set(modules.map((module) => module.packageName))].map((packageName) => [
          packageName,
          getPackageContractModuleHaxe(packageName, modules, moduleResolution),
        ]),
      );
      const ambientUtilityHeritageBindingIds = new Set(
        modules.flatMap((module) => [...createAmbientUtilityHeritageTargetsHaxe(module).keys()]),
      );
      const interfaceInheritancePass = createCompilerLoweringPassInterfaceInheritance(modules, moduleResolution, {
        eraseAmbientHeritage: (reference, declaration) =>
          !declaration.exported &&
          reference.reference.kind === 'ambient' &&
          getCompilerRuntimeExternalSymbolTargetHaxe(reference.reference.name, 'type') !== undefined,
        eraseAmbientUtilityHeritage: (reference, declaration) =>
          ambientUtilityHeritageBindingIds.has(declaration.binding.id) ||
          canEraseCompilerAmbientUtilityHeritageHaxe(reference),
      });
      const analyzeStructuralObjectCompatibility = createIrModuleStructuralObjectCompatibilityAnalyzer(
        modules,
        moduleResolution,
      );
      return Object.freeze({
        emitModule(module: Readonly<IrModule>) {
          return options.emissionMode === 'extern'
            ? emitIrModuleHaxeExternWithContext(
                module,
                modules,
                moduleResolution,
                options,
                interfaceInheritancePass,
                packageContractModules.get(module.packageName),
                getModuleFacade,
                externEmissionIndex,
              )
            : [
                emitIrModuleHaxeWithContext(
                  module,
                  modules,
                  moduleResolution,
                  options,
                  getModuleFacade(module),
                  getModuleFacade,
                  interfaceInheritancePass,
                  analyzeStructuralObjectCompatibility,
                ),
              ];
        },
      });
    },
    emitModule(module, { moduleResolution, modules, options }) {
      const getModuleFacade = createCompilerModuleFacadePlannerHaxe(modules, moduleResolution);
      return options.emissionMode === 'extern'
        ? emitIrModuleHaxeExternWithContext(
            module,
            modules,
            moduleResolution,
            options,
            undefined,
            getPackageContractModuleHaxe(module.packageName, modules, moduleResolution),
            getModuleFacade,
          )
        : [
            emitIrModuleHaxeWithContext(
              module,
              modules,
              moduleResolution,
              options,
              getModuleFacade(module),
              getModuleFacade,
            ),
          ];
    },
    name: 'haxe',
    runtimeAbi: createCompilerHaxeRuntimeAbiManifest,
  };
}

function getPackageContractModuleHaxe(
  packageName: string,
  modules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
): Readonly<IrModule> | undefined {
  const candidates = modules.filter(
    (module) =>
      module.packageName === packageName && /(?:^|\/)contract\.[cm]?tsx?$/u.test(normalizePathPortable(module.source)),
  );
  if (candidates.length === 0) return undefined;
  const publicTargets = new Set(
    (moduleResolution?.edges ?? [])
      .filter((edge) => edge.specifier === `${packageName}/contract`)
      .map((edge) => `${edge.target.packageName}\0${normalizePathPortable(edge.target.source)}`),
  );
  return (
    candidates.find((candidate) =>
      publicTargets.has(`${candidate.packageName}\0${normalizePathPortable(candidate.source)}`),
    ) ?? candidates.sort((left, right) => compareTextCodeUnits(left.source, right.source))[0]
  );
}

export function emitIrModuleHaxe(
  sourceModule: Readonly<IrModule>,
  options: Readonly<HaxeCompilerBackendOptions> = {},
): EmittedFile {
  if (options.emissionMode === 'extern') {
    throw createBackendEmissionFailure(
      'haxe',
      sourceModule,
      'emitIrModuleHaxe is the single-file transpile API; use the Haxe backend session for extern emission',
    );
  }
  return emitIrModuleHaxeWithContext(sourceModule, [sourceModule], undefined, options, undefined, undefined);
}

function emitIrModuleHaxeWithContext(
  sourceModule: Readonly<IrModule>,
  sourceModules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
  options: Readonly<HaxeCompilerBackendOptions>,
  moduleFacade: Readonly<CompilerModuleFacadePlan> | undefined,
  getModuleFacade: ((module: Readonly<IrModule>) => CompilerModuleFacadePlan | undefined) | undefined,
  interfaceInheritancePass?: Readonly<CompilerLoweringPass> | undefined,
  structuralObjectCompatibilityAnalyzer?:
    | ((module: Readonly<IrModule>) => Readonly<CompilerStructuralObjectCompatibilityReport>)
    | undefined,
): EmittedFile {
  const ambientUtilityHeritageTargets = createAmbientUtilityHeritageTargetsHaxe(sourceModule);
  const module = lowerIrModuleWithCompilerPasses(sourceModule, [
    createCompilerLoweringPassExtraArgumentErasure(),
    createCompilerLoweringPassAsyncIterationHaxe(),
    createCompilerLoweringPassAwaitConditionHoisting(),
    createCompilerLoweringPassFinallyAwaitHoisting(),
    createCompilerLoweringPassBindingPattern(),
    createCompilerLoweringPassVariableHoisting(),
    createCompilerLoweringPassCStyleFor(),
    interfaceInheritancePass ??
      createCompilerLoweringPassInterfaceInheritance(sourceModules, moduleResolution, {
        eraseAmbientHeritage: (reference, declaration) =>
          !declaration.exported &&
          reference.reference.kind === 'ambient' &&
          getCompilerRuntimeExternalSymbolTargetHaxe(reference.reference.name, 'type') !== undefined,
        eraseAmbientUtilityHeritage: (reference, declaration) =>
          ambientUtilityHeritageTargets.has(declaration.binding.id) ||
          canEraseCompilerAmbientUtilityHeritageHaxe(reference),
      }),
    createCompilerLoweringPassSwitchFallthrough(),
    createCompilerLoweringPassSwitchSuspension(),
  ]);
  assertStructuralObjectCompatibilityHaxe(
    module,
    structuralObjectCompatibilityAnalyzer ? sourceModules : replaceIrModuleBackendContext(sourceModules, module),
    moduleResolution,
    structuralObjectCompatibilityAnalyzer,
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
    targetNames = createIrModuleTargetNamesHaxe(module);
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
  const sourceModuleTargetNames = new WeakMap<object, ReadonlyMap<string, string>>();
  sourceModuleTargetNames.set(module, targetNames);
  const facadeTypeTargetNames = createHaxeFacadeTypeTargetNames(module, moduleFacade, targetNames);
  const context: EmitContext = {
    ambientUtilityHeritageTargets,
    breakableDepth: 0,
    controlFlowLabels: [],
    facadeBindingTargetNames: new Map(),
    facadeTypeTargetNames,
    finallyCompletion: undefined,
    generatedNames: new Set([...targetNames.values(), ...facadeTypeTargetNames.values()]),
    getModuleFacade,
    machineNames: new Map(),
    module,
    moduleFacadeSlots:
      moduleFacade?.modules.find((candidate) => isHaxeCompilerModuleIdentityEqual(candidate.module, module))?.slots ??
      [],
    moduleResolution,
    nullableBindingIds: collectIrModuleNullableBindingIds(module),
    objectAccessorClasses: [],
    options,
    dynamicBindingIds: new Set<string>(),
    packageName,
    returnsAbsent: false,
    sourceModules,
    sourceModuleTargetNames,
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
      (declaration.kind === 'function' && !declaration.namespaceMember) || declaration.kind === 'variable',
  );
  const lines = [createCompilerGeneratedFileHeader(module, '//', options.upstreamCommit), `package ${packageName};`];
  const imports = emitImports(module.imports, context);
  if (imports.length > 0) lines.push('', ...imports);
  const reexports = emitReexportsHaxe(module.exports, context);
  if (reexports.length > 0) lines.push('', ...reexports);
  for (const declaration of typeDeclarations) lines.push('', ...emitTypeDeclaration(declaration, context));
  // Module-level statics rather than a holder class named after the file. A holder collides with a
  // source class of the same name — `class Store` in `store.ts` is ordinary code and the collision is
  // a hard error — and it is not what the source wrote either: these are module members, not members
  // of a type. `pack.Module.name` resolves to them, which is what an importing module already emits.
  valueDeclarations.forEach((declaration) => {
    lines.push('', ...emitModuleValue(declaration, context));
  });
  for (const helper of context.objectAccessorClasses) lines.push('', ...helper);
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
  let implicitDerivedBaseParameters: readonly IrParameter[] | undefined;
  if (initialization.constructor.kind === 'implicit-derived') {
    const baseClass = resolveIrBaseClassHaxe(declaration, context);
    if (!baseClass) {
      emissionError(
        context,
        `class ${declaration.binding.name} implicit derived constructor requires inherited-ABI forwarding`,
      );
    }
    implicitDerivedBaseParameters = baseClass.classConstructor?.parameters ?? [];
  }
  const directSuperCalls = declaration.classConstructor?.body.filter(isIrStatementSuperConstructorCall) ?? [];
  if (declaration.extends && declaration.classConstructor && directSuperCalls.length !== 1) {
    emissionError(
      context,
      `class ${declaration.binding.name} requires one direct super constructor call for Haxe initialization`,
    );
  }
  const inheritedFieldNames = collectIrClassInheritedFieldNamesHaxe(declaration, context);
  const lines = [
    `${declaration.exported ? '' : 'private '}${abstract}class ${getBindingTargetNameHaxe(declaration.binding, context)}${parameters}${extendsType}${implementsTypes} {`,
  ];
  if (requiresErrorNameStorage) {
    lines.push('  public var name:String;');
  }
  declaration.fields.forEach((field, index) => {
    if (!field.static && inheritedFieldNames.has(field.name)) return;
    if (index > 0 || lines.length > 1) lines.push('');
    const visibility = field.visibility === 'public' ? 'public ' : field.visibility === 'private' ? 'private ' : '';
    const storage = field.readonly && !field.declare && !field.abstract ? 'final' : 'var';
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
  if (implicitDerivedBaseParameters) {
    if (declaration.fields.length > 0 || requiresErrorNameStorage) lines.push('');
    lines.push(`  public function new(${emitParameters(implicitDerivedBaseParameters, context)}) {`);
    const body: string[] = [];
    const args = implicitDerivedBaseParameters
      .map((parameter) => getBindingTargetNameHaxe(parameter.binding, context))
      .join(', ');
    body.push(`super(${args});`);
    if (requiresErrorNameStorage) body.push('this.name = "Error";');
    body.push(...emitIrClassFieldInitializationsHaxe(declaration, initialization, 'derived-super-return', context));
    body.push(
      ...emitIrClassFieldInitializationsHaxe(declaration, initialization, 'derived-super-return-after-fields', context),
    );
    lines.push(...indentSourceLines(body, 2), '  }');
  }
  if (!declaration.classConstructor && !implicitDerivedBaseParameters) {
    if (declaration.fields.length > 0 || requiresErrorNameStorage) lines.push('');
    lines.push('  public function new() {}');
  }
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
  // Haxe has properties, so an accessor the source wrote as one stays one: the field is declared with
  // the accessor pair Haxe expects and the bodies become `get_`/`set_` methods. A read at a call site
  // then needs no rewriting, because the source already wrote a field read.
  const accessors = new Map<string, { get: boolean; set: boolean; type: Readonly<IrType> }>();
  for (const method of declaration.methods) {
    if (!method.accessor) continue;
    const type = method.accessor === 'get' ? method.returns : (method.parameters[0]?.type ?? method.returns);
    const existing = accessors.get(method.name) ?? { get: false, set: false, type };
    accessors.set(method.name, { ...existing, [method.accessor]: true, type: existing.type });
  }
  for (const [name, accessor] of accessors) {
    lines.push(
      '',
      `  public var ${safeHaxeName(name)}(${accessor.get ? 'get' : 'never'}, ${accessor.set ? 'set' : 'never'}):${emitType(accessor.type, context)};`,
    );
  }
  // Haxe requires `override` on a method that replaces an inherited one, and refuses it on one that
  // does not. The source's own `override` keyword is optional in TypeScript, so the answer comes from
  // the base class this module declares — and a base declared elsewhere cannot be asked.
  const overriddenMethodNames = getIrClassInheritedMethodNamesHaxe(declaration, context);
  declaration.methods.forEach((method) => {
    if (lines.length > 1) lines.push('');
    const methodContext: EmitContext = {
      ...context,
      finallyCompletion: undefined,
      returnsAbsent: canIrTypeReturnAbsentHaxe(method.returns, context.module),
    };
    const visibility = method.visibility === 'public' ? 'public ' : method.visibility === 'private' ? 'private ' : '';
    const static_ = method.static ? 'static ' : '';
    // A Haxe setter yields the value it was given, so the source's void setter gains the return the
    // property contract requires.
    const setterValue = method.accessor === 'set' ? method.parameters[0] : undefined;
    const name = method.accessor ? `${method.accessor}_${safeHaxeName(method.name)}` : safeHaxeName(method.name);
    const returns = setterValue ? emitType(setterValue.type, methodContext) : emitType(method.returns, methodContext);
    const signature = `  ${method.accessor ? '' : visibility}${method.abstract ? 'abstract ' : ''}${overriddenMethodNames.has(method.name) ? 'override ' : ''}${static_}function ${name}${emitTypeParameters(method.typeParameters, methodContext)}(${emitParameters(method.parameters, methodContext)}):${returns}`;
    // A method with no implementation has no body to emit: the declaration is the whole contract.
    if (method.abstract) {
      lines.push(`${signature};`);
      return;
    }
    lines.push(
      `${signature} {`,
      ...indentSourceLines(
        [
          ...(method.async
            ? emitCompilerHaxeTaskFunctionBody(method, methodContext)
            : emitStatements(method.body, methodContext)),
          ...(setterValue ? [`return ${getBindingTargetNameHaxe(setterValue.binding, methodContext)};`] : []),
        ],
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
  for (const namespaceFunction of getIrEnumNamespaceFunctionsHaxe(declaration, context)) {
    lines.push('', ...indentSourceLines(emitEnumNamespaceFunctionHaxe(namespaceFunction, context)));
  }
  lines.push('}');
  return lines;
}

function emitEnumNamespaceFunctionHaxe(declaration: Readonly<IrFunctionDeclaration>, outer: EmitContext): string[] {
  const context: EmitContext = {
    ...outer,
    finallyCompletion: undefined,
    returnsAbsent: canIrTypeReturnAbsentHaxe(declaration.returns, outer.module),
  };
  return [
    `public static function ${getBindingTargetNameHaxe(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)}(${emitParameters(declaration.parameters, context)}):${emitType(declaration.returns, context)} {`,
    ...indentSourceLines(
      declaration.async
        ? emitCompilerHaxeTaskFunctionBody(declaration, context)
        : emitStatements(declaration.body, context),
    ),
    '}',
  ];
}

function getIrEnumNamespaceFunctionsHaxe(
  declaration: Readonly<IrEnumDeclaration>,
  context: EmitContext,
): readonly Readonly<IrFunctionDeclaration>[] {
  return context.module.declarations.filter(
    (candidate): candidate is IrFunctionDeclaration =>
      candidate.kind === 'function' &&
      candidate.namespaceMember?.kind === 'binding' &&
      candidate.namespaceMember.binding.id === declaration.binding.id &&
      candidate.namespaceMember.path.length === 1,
  );
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
      return emitArrayExpressionHaxe(expression, context);
    case 'assignment': {
      const reflectiveAssignment = emitReflectiveElementAssignmentHaxe(expression, context);
      if (reflectiveAssignment) return reflectiveAssignment;
      if (
        (expression.operator === '&=' ||
          expression.operator === '|=' ||
          expression.operator === '^=' ||
          expression.operator === '<<=' ||
          expression.operator === '>>=' ||
          expression.operator === '>>>=') &&
        expression.semantics.left.flow === 'number' &&
        expression.semantics.right.flow === 'number'
      ) {
        const left = emitExpression(expression.left, context);
        const right = emitExpression(expression.right, context);
        const binaryOp = expression.operator.slice(0, -1);
        return `(${left} = Std.int(${left}) ${binaryOp} Std.int(${right}))`;
      }
      if (
        expression.operator === '**=' &&
        expression.semantics.left.flow === 'number' &&
        expression.semantics.right.flow === 'number'
      ) {
        const left = emitExpression(expression.left, context);
        const right = emitExpression(expression.right, context);
        return `(${left} = Math.pow(${left}, ${right}))`;
      }
      if (expression.operator === '||=' || expression.operator === '&&=') {
        const left = emitExpression(expression.left, context);
        const right = emitExpression(expression.right, context);
        if (expression.semantics.left.flow === 'boolean') {
          const condition = expression.operator === '||=' ? `!${left}` : left;
          return `{ if (${condition}) ${left} = ${right}; ${left}; }`;
        }
        if (expression.semantics.left.flow === 'number') {
          const condition =
            expression.operator === '||='
              ? `${left} == 0.0 || Math.isNaN(${left})`
              : `${left} != 0.0 && !Math.isNaN(${left})`;
          return `{ if (${condition}) ${left} = ${right}; ${left}; }`;
        }
        if (expression.semantics.left.flow === 'string') {
          const condition = expression.operator === '||=' ? `${left} == ""` : `${left} != ""`;
          return `{ if (${condition}) ${left} = ${right}; ${left}; }`;
        }
        const runtimeAssignment = emitJavaScriptAssignmentOperatorHaxe(expression, context);
        if (runtimeAssignment) return runtimeAssignment;
        emissionError(
          context,
          `operator ${expression.operator} on ${expression.semantics.left.flow} requires Haxe semantic lowering`,
        );
      }
      if (expression.operator === '??=') {
        return emitNullishAssignmentHaxe(expression, context);
      }
      const runtimeAssignment = emitJavaScriptAssignmentOperatorHaxe(expression, context);
      if (runtimeAssignment) return runtimeAssignment;
      const left = emitExpression(expression.left, context);
      const right = emitAssignmentRightHaxe(expression, context);
      return `(${left} ${emitAssignmentOperatorHaxe(expression.operator, expression.semantics, context)} ${right})`;
    }
    case 'await':
      emissionError(context, 'await requires the Haxe async-lowering pass');
    case 'binary': {
      if (expression.operator === ',') {
        return `(function() { ${emitExpression(expression.left, context)}; return ${emitExpression(expression.right, context)}; })()`;
      }
      if (expression.semantics.nullishComparison) {
        const evidence = expression.semantics.nullishComparison;
        const operand =
          expression.left.kind === 'identifier' && expression.left.reference.kind === 'ambient'
            ? expression.right
            : expression.left;
        if (expression.operator === '===' || expression.operator === '!==') {
          const operation = expression.operator === '===' ? 'strictEq' : 'strictNeq';
          const literal = evidence.literal === 'undefined' ? 'js.Syntax.code("undefined")' : 'null';
          return `js.Syntax.${operation}(${emitExpression(operand, context)}, ${literal})`;
        }
        // JavaScript loose equality deliberately treats null and undefined as the same absent value.
        const negated = expression.operator === '!=';
        return `(${emitExpression(operand, context)} ${negated ? '!=' : '=='} null)`;
      }
      const ambientPresenceTest = getTypeofBoundAmbientPresenceTestHaxe(expression, context);
      if (ambientPresenceTest !== undefined) return String(ambientPresenceTest);
      const typeofTest = getTypeofTypeTestHaxe(expression);
      if (typeofTest) {
        const operand = emitExpression(typeofTest.operand, context);
        const test = `Std.isOfType(${operand}, ${typeofTest.haxeType})`;
        return typeofTest.negated ? `!${test}` : test;
      }
      if (
        expression.operator === '**' &&
        expression.semantics.left.flow === 'number' &&
        expression.semantics.right.flow === 'number'
      ) {
        const left = emitExpression(expression.left, context);
        const right = emitExpression(expression.right, context);
        return `Math.pow(${left}, ${right})`;
      }
      if (
        expression.operator === '>>>' &&
        expression.semantics.left.flow === 'number' &&
        expression.semantics.right.flow === 'number'
      ) {
        const left = emitExpression(expression.left, context);
        const right = emitExpression(expression.right, context);
        return `(Std.int(${left}) >>> Std.int(${right}))`;
      }
      const runtimeOperator = emitJavaScriptBinaryOperatorHaxe(expression, context);
      if (runtimeOperator) return runtimeOperator;
      const op = emitBinaryOperatorHaxe(expression.operator, expression.semantics, context);
      const bitwise =
        expression.operator === '&' ||
        expression.operator === '|' ||
        expression.operator === '^' ||
        expression.operator === '<<' ||
        expression.operator === '>>';
      const left = emitExpression(expression.left, context);
      const right = emitExpression(expression.right, context);
      if (bitwise) return `(Std.int(${left}) ${op} Std.int(${right}))`;
      return `(${left} ${op} ${right})`;
    }
    case 'call': {
      if (expression.optional) {
        if (expression.arguments.some((argument) => argument.kind === 'spread')) {
          return emitSpreadCallHaxe(expression, context);
        }
        return emitOptionalCallHaxe(expression, context);
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.object.kind === 'identifier' &&
        expression.callee.object.reference.kind === 'ambient' &&
        expression.callee.object.reference.name === 'Math' &&
        (expression.callee.name === 'max' || expression.callee.name === 'min') &&
        expression.arguments.length > 2
      ) {
        const method = expression.callee.name;
        const values = expression.arguments.map((argument) => emitExpression(argument, context));
        return values.slice(1).reduce((left, right) => `Math.${method}(${left}, ${right})`, values[0]!);
      }
      // Haxe's `slice` takes a required position and counts in `Int`, where the source's takes
      // optional bounds and counts in its one numeric type. With no bounds at all the source means a
      // copy, which Haxe spells as `copy`.
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'array' &&
        expression.callee.member.name === 'slice'
      ) {
        const receiver = emitExpression(expression.callee.object, context);
        if (expression.arguments.length === 0) return `${receiver}.copy()`;
        const bounds = expression.arguments.map((argument) => `Std.int(${emitExpression(argument, context)})`);
        return `${receiver}.slice(${bounds.join(', ')})`;
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'array' &&
        expression.callee.member.name === 'push' &&
        expression.arguments.length > 1 &&
        expression.arguments.every((argument) => argument.kind !== 'spread')
      ) {
        const receiver = emitExpression(expression.callee.object, context);
        const values = expression.arguments.map((argument) => emitExpression(argument, context));
        return `${context.options.runtimeModule ?? 'flighthq._internal'}._ArrayTools.pushMany(${receiver}, [${values.join(', ')}])`;
      }
      // Member mapping normally emits arguments while selecting the target spelling. A spread has
      // runtime arity, so it must take the reflective-call route before that fixed-arity mapper sees
      // the residual spread expression (notably for Array.push(...values)).
      if (expression.arguments.some((argument) => argument.kind === 'spread')) {
        return emitSpreadCallHaxe(expression, context);
      }
      const ambient = expression.callee.kind === 'property' ? expression.callee.member : undefined;
      if (ambient && expression.callee.kind === 'property') {
        const binding = getCompilerHaxeAmbientMemberBinding(ambient);
        if (binding && binding.kind !== 'property') {
          const receiver = emitExpression(expression.callee.object, context);
          if (binding.kind === 'staticFold') {
            const [fold, initial] = expression.arguments;
            if (expression.arguments.length !== 2 || !fold || !initial) {
              emissionError(context, 'folding a collection takes a step and an initial value');
            }
            return `${binding.targetPath}(${receiver}, ${emitExchangedClosureHaxe(fold, context)}, ${emitExpression(initial, context)})`;
          }
          const intPositions =
            binding.kind === 'method' || binding.kind === 'runtimeCall' ? (binding.intArguments ?? []) : [];
          const values = expression.arguments.map((argument, position) => {
            const emitted = emitExpression(argument, context);
            if (intPositions.includes(position)) {
              return argument.kind === 'literal' &&
                typeof argument.value === 'number' &&
                Number.isInteger(argument.value)
                ? emitted
                : `Std.int(${emitted})`;
            }
            return emitted;
          });
          if (binding.kind === 'staticCall') return `${binding.targetPath}(${[receiver, ...values].join(', ')})`;
          if (binding.kind === 'runtimeCall') {
            return `${context.options.runtimeModule ?? 'flighthq._internal'}.${binding.targetName}(${[receiver, ...values].join(', ')})`;
          }
          return `${receiver}.${binding.targetName}(${values.join(', ')})`;
        }
      }
      if (expression.semantics.statementValue) return emitStatementValueExpressionHaxe(expression, context);
      if (
        expression.callee.kind === 'identifier' &&
        expression.callee.reference.kind === 'ambient' &&
        expression.callee.reference.name === 'String' &&
        expression.arguments.length === 1
      ) {
        return `Std.string(${emitExpression(expression.arguments[0]!, context)})`;
      }
      if (
        expression.callee.kind === 'identifier' &&
        expression.callee.reference.kind === 'ambient' &&
        expression.callee.reference.name === 'Symbol'
      ) {
        return `new ${emitExpression(expression.callee, context)}(${emitCallArgumentsHaxe(expression, context)})`;
      }
      return `${expression.callee.kind === 'function' ? `(${emitExpression(expression.callee, context)})` : emitExpression(expression.callee, context)}${expression.optional ? '?.' : ''}(${emitCallArgumentsHaxe(expression, context)})`;
    }
    case 'cast':
      return emitCastExpressionHaxe(expression, context);
    case 'conditional':
      return `(${emitExpression(expression.condition, context)} ? ${emitExpression(expression.whenTrue, context)} : ${emitExpression(expression.whenFalse, context)})`;
    case 'element':
      if (
        expression.semantics.receivers.includes('object') ||
        (expression.semantics.key === 'string' &&
          expression.semantics.receivers.every((receiver) => receiver === 'unknown'))
      ) {
        const storageName = getComputedObjectStorageNameHaxe(expression);
        if (storageName) {
          return `${emitExpression(expression.object, context)}${expression.optional ? '?.' : '.'}${storageName}`;
        }
        const object = emitExpression(expression.object, context);
        const index = emitExpression(expression.index, context);
        const runtime = `${context.options.runtimeModule ?? 'flighthq._internal'}._Js`;
        if (expression.optional) {
          const receiver = getGeneratedTargetNameHaxe('optionalObject', context);
          return `(function() { final ${receiver}:Dynamic = ${object}; return ${receiver} == null ? null : ${runtime}.getProperty(${receiver}, ${index}); })()`;
        }
        return expression.semantics.receivers.length === 1 && expression.semantics.key === 'string'
          ? `Reflect.field(${object}, ${index})`
          : `${runtime}.getProperty(${object}, ${index})`;
      }
      if (expression.semantics.receivers.includes('tuple')) {
        return `${emitExpression(expression.object, context)}[${emitArrayIndexHaxe(expression.index, context)}]`;
      }
      if (expression.optional) {
        const receiver = getGeneratedTargetNameHaxe('optionalIndexedValue', context);
        const object = emitExpression(expression.object, context);
        const index = emitExpression(expression.index, context);
        const access =
          expression.semantics.key === 'number'
            ? `${receiver}[${emitArrayIndexHaxe(expression.index, context)}]`
            : `${context.options.runtimeModule ?? 'flighthq._internal'}._Js.getProperty(${receiver}, ${index})`;
        return `(function() { final ${receiver}:Dynamic = ${object}; return ${receiver} == null ? null : ${access}; })()`;
      }
      if (expression.semantics.key !== 'number') {
        return `${context.options.runtimeModule ?? 'flighthq._internal'}._Js.getProperty(${emitExpression(expression.object, context)}, ${emitExpression(expression.index, context)})`;
      }
      // Haxe indexes arrays with `Int`, and the neutral numeric domain has only `number`, so every
      // index arrives as `Float` and `values[index]` does not compile. A literal integer is already
      // an `Int` to Haxe; anything else is narrowed here. `Std.int` truncates, which matches the
      // source for an integral index and differs for a fractional one — where the source itself
      // produces `undefined`, so such an index is a defect in either language.
      return `${emitExpression(expression.object, context)}[${emitArrayIndexHaxe(expression.index, context)}]`;
    case 'function':
      if (expression.typeParameters.length > 0)
        emissionError(context, 'generic function expressions are not valid Haxe values');
      const functionContext: EmitContext = {
        ...context,
        finallyCompletion: undefined,
        returnsAbsent: canIrTypeReturnAbsentHaxe(expression.returns, context.module),
      };
      if (expression.async) {
        return `function(${emitParameters(expression.parameters, functionContext)}) {\n${indentSourceLines(
          emitCompilerHaxeTaskFunctionBody(expression, functionContext),
        ).join('\n')}\n}`;
      }
      return expression.expression
        ? `function(${emitParameters(expression.parameters, functionContext)}) return ${emitExpression(expression.expression, functionContext)}`
        : `function(${emitParameters(expression.parameters, functionContext)}) {\n${indentSourceLines(emitStatements(expression.body, functionContext)).join('\n')}\n}`;
    case 'identifier':
      return emitIdentifierReferenceHaxe(expression.reference, context);
    case 'literal':
      return emitLiteral(expression.value);
    case 'new':
      if (
        expression.callee.kind === 'property' &&
        expression.callee.object.kind === 'identifier' &&
        expression.callee.object.reference.kind === 'ambient'
      ) {
        const target = getCompilerRuntimeExternalMemberTargetHaxe(
          expression.callee.object.reference.name,
          expression.callee.name,
          context.options.runtimeModule,
        );
        if (target) {
          return `new ${target}(${expression.arguments.map((argument) => emitExpression(argument, context)).join(', ')})`;
        }
      }
      if (expression.callee.kind !== 'identifier') {
        emissionError(context, 'qualified constructors require Haxe type-path lowering');
      }
      if (expression.callee.reference.kind === 'ambient') {
        const sourceName = expression.callee.reference.name;
        const target = getCompilerRuntimeExternalSymbolTargetHaxe(sourceName, 'value', context.options.runtimeModule);
        if (target?.startsWith('js.Syntax.code(')) {
          const arguments_ = expression.arguments.map((argument) => emitExpression(argument, context));
          const construction = `new ${sourceName}(${arguments_.map((_, index) => `{${String(index)}}`).join(', ')})`;
          return `js.Syntax.code(${JSON.stringify(construction)}${arguments_.length > 0 ? `, ${arguments_.join(', ')}` : ''})`;
        }
      }
      return `new ${emitExpression(expression.callee, context)}(${expression.arguments.map((argument) => emitExpression(argument, context)).join(', ')})`;
    case 'object':
      return emitObjectExpressionHaxe(expression, context);
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
    case 'property': {
      if (expression.object.kind === 'identifier' && expression.object.reference.kind === 'ambient') {
        const sourceName = expression.object.reference.name;
        const target = getCompilerRuntimeExternalMemberTargetHaxe(
          sourceName,
          expression.name,
          context.options.runtimeModule,
        );
        if (target) {
          if (expression.optional) {
            emissionError(context, `optional ${sourceName} member access requires null-safe Haxe lowering`);
          }
          return target;
        }
        if (sourceName === 'Number') {
          emissionError(context, `Number member ${expression.name} has no Haxe binding`);
        }
      }
      // A member of the ambient surface is spelled by the table, not by the source's name. A member
      // with no binding is refused here rather than emitted and hoped for.
      if (expression.member) {
        const binding = getCompilerHaxeAmbientMemberBinding(expression.member);
        if (!binding) {
          emissionError(context, `${expression.member.receiver} member ${expression.member.name} has no Haxe binding`);
        }
        if (binding.kind === 'property') {
          return `${emitExpression(expression.object, context)}.${binding.targetName}`;
        }
      }
      const narrowed =
        expression.object.kind === 'identifier' && expression.object.narrowedMember
          ? (getIrModuleDeclaredTypeNameHaxe(expression.object.narrowedMember, context) ??
            getHaxePrimitiveNarrowedTypeName(expression.object.narrowedMember))
          : undefined;
      const narrowedIsTypedef =
        narrowed !== undefined &&
        expression.object.kind === 'identifier' &&
        expression.object.narrowedMember !== undefined &&
        isIrNarrowedMemberTypedefHaxe(expression.object.narrowedMember, context);
      const object = narrowed
        ? narrowedIsTypedef
          ? `cast(${emitExpression(expression.object, context)})`
          : `cast(${emitExpression(expression.object, context)}, ${narrowed})`
        : emitExpression(expression.object, context);
      return `${object}${expression.optional ? '?.' : '.'}${safeHaxeName(expression.name)}`;
    }
    case 'regexp':
      return `~/${expression.pattern}/${expression.flags}`;
    case 'spread':
      // A spread of a FIXED tuple is already normalized into positional arguments by the neutral
      // pass library. What reaches here is a spread of an unbounded collection into a fixed-arity
      // callee, which neither static target can express: the arity is not known until run time.
      emissionError(context, 'spreading an unbounded collection requires reflective call lowering');
    case 'template': {
      // A template's literal parts include the empty text between two interpolations and at either
      // end. Concatenating them changes nothing, so they are dropped — unless dropping every part
      // would leave no expression at all, which is the empty template itself.
      const parts = expression.parts
        .filter((part) => typeof part !== 'string' || part.length > 0)
        .map((part) => (typeof part === 'string' ? emitLiteral(part) : `Std.string(${emitExpression(part, context)})`));
      return parts.length > 0 ? parts.join(' + ') : emitLiteral('');
    }
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
      const runtimeUpdate = emitJavaScriptUpdateOperatorHaxe(expression, context);
      if (runtimeUpdate) return runtimeUpdate;
      const operand = emitExpression(expression.operand, context);
      if (!expression.postfix) {
        const runtimeOperator = emitJavaScriptPrefixUnaryOperatorHaxe(expression, operand, context);
        if (runtimeOperator) return runtimeOperator;
      }
      const operator = expression.postfix
        ? emitPostfixUnaryOperatorHaxe(expression.operator, expression.semantics, context)
        : emitPrefixUnaryOperatorHaxe(expression.operator, expression.semantics, context);
      if (expression.operator === '~') return `${operator} Std.int(${operand})`;
      return expression.postfix ? `${operand}${operator}` : `${operator} ${operand}`;
    }
    case 'undefinedValue':
      return 'js.Syntax.code("undefined")';
    case 'undefinedDefault':
      return `(${emitExpression(expression.value, context)} ?? ${emitExpression(expression.fallback, context)})`;
  }
}

function emitJavaScriptUpdateOperatorHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'unary' }>>,
  context: EmitContext,
): string | undefined {
  if (
    (expression.operator !== '++' && expression.operator !== '--') ||
    (expression.semantics.operand.flow === 'number' && expression.semantics.result === 'number')
  ) {
    return undefined;
  }
  const runtime = `${context.options.runtimeModule ?? 'flighthq._internal'}._Js`;
  const oldValue = getGeneratedTargetNameHaxe('updateOldValue', context);
  const result = getGeneratedTargetNameHaxe('updateResult', context);
  const updated = `${oldValue} ${expression.operator === '++' ? '+' : '-'} 1.0`;
  const completion = expression.postfix ? oldValue : result;
  const body = (setup: string, read: string, write: (value: string) => string): string =>
    `(function() { ${setup} final ${oldValue}:Float = ${runtime}.toNumber(${read}); final ${result}:Float = ${updated}; ${write(result)}; return ${completion}; })()`;

  if (expression.operand.kind === 'identifier') {
    const target = emitExpression(expression.operand, context);
    return body('', target, (value) => `${target} = ${value}`);
  }
  if (expression.operand.kind === 'property') {
    const receiver = getGeneratedTargetNameHaxe('updateReceiver', context);
    const target = `${receiver}.${safeHaxeName(expression.operand.name)}`;
    return body(
      `final ${receiver}:Dynamic = ${emitExpression(expression.operand.object, context)};`,
      target,
      (value) => `${target} = ${value}`,
    );
  }
  if (expression.operand.kind === 'element') {
    const receiver = getGeneratedTargetNameHaxe('updateReceiver', context);
    const key = getGeneratedTargetNameHaxe('updateKey', context);
    const setup = `final ${receiver}:Dynamic = ${emitExpression(expression.operand.object, context)}; final ${key}:Dynamic = ${emitExpression(expression.operand.index, context)};`;
    if (
      !getComputedObjectStorageNameHaxe(expression.operand) &&
      (expression.operand.semantics.receivers.includes('object') ||
        expression.operand.semantics.receivers.includes('unknown'))
    ) {
      return body(
        setup,
        `${runtime}.getProperty(${receiver}, ${key})`,
        (value) => `${runtime}.setProperty(${receiver}, ${key}, ${value})`,
      );
    }
    const target = `${receiver}[${key}]`;
    return body(setup, target, (value) => `${target} = ${value}`);
  }
  emissionError(context, `operator ${expression.operator} requires an assignable Haxe update target`);
}

function emitArrayExpressionHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'array' }>>,
  context: EmitContext,
): string {
  if (!expression.elements.some((element) => element?.kind === 'spread')) {
    return `[${expression.elements.map((element) => (element ? emitExpression(element, context) : 'null')).join(', ')}]`;
  }
  const groups: Array<{ kind: 'fixed' | 'spread'; value: string }> = [];
  let fixed: string[] = [];
  for (const element of expression.elements) {
    if (element?.kind === 'spread') {
      if (fixed.length > 0) groups.push({ kind: 'fixed', value: `[${fixed.join(', ')}]` });
      fixed = [];
      groups.push({ kind: 'spread', value: emitExpression(element.expression, context) });
      continue;
    }
    fixed.push(element ? emitExpression(element, context) : 'null');
  }
  if (fixed.length > 0) groups.push({ kind: 'fixed', value: `[${fixed.join(', ')}]` });
  const [first, ...rest] = groups;
  if (!first) return '[]';
  const initial = first.kind === 'spread' ? `${first.value}.copy()` : first.value;
  return `${initial}${rest.map((group) => `.concat(${group.value})`).join('')}`;
}

function emitJavaScriptAssignmentOperatorHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'assignment' }>>,
  context: EmitContext,
): string | undefined {
  if (isAssignmentOperatorDirectHaxe(expression.operator, expression.semantics)) return undefined;
  const right = emitExpression(expression.right, context);
  const runtime = `${context.options.runtimeModule ?? 'flighthq._internal'}._Js`;
  if (expression.left.kind === 'identifier') {
    const left = emitExpression(expression.left, context);
    return emitJavaScriptAssignmentToTargetHaxe(expression.operator, left, right, runtime);
  }
  if (expression.left.kind !== 'property') return undefined;
  const receiver = getGeneratedTargetNameHaxe('assignmentReceiver', context);
  const target = `${receiver}.${safeHaxeName(expression.left.name)}`;
  const assignment = emitJavaScriptAssignmentToTargetHaxe(expression.operator, target, right, runtime);
  if (!assignment) return undefined;
  return `(function() { final ${receiver}:Dynamic = ${emitExpression(expression.left.object, context)}; ${assignment}; return ${target}; })()`;
}

function emitNullishAssignmentHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'assignment' }>>,
  context: EmitContext,
): string {
  const right = emitExpression(expression.right, context);
  if (expression.left.kind === 'identifier') {
    const target = emitExpression(expression.left, context);
    return `(function() { if (${target} == null) ${target} = ${right}; return ${target}; })()`;
  }
  if (expression.left.kind !== 'property') {
    return emissionError(context, 'operator ??= requires an assignable Haxe target');
  }
  const receiver = getGeneratedTargetNameHaxe('assignmentReceiver', context);
  const target = `${receiver}.${safeHaxeName(expression.left.name)}`;
  return `(function() { final ${receiver}:Dynamic = ${emitExpression(expression.left.object, context)}; if (${target} == null) ${target} = ${right}; return ${target}; })()`;
}

function emitReflectiveElementAssignmentHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'assignment' }>>,
  context: EmitContext,
): string | undefined {
  const left = expression.left;
  if (left.kind !== 'element') return undefined;
  const storageName = getComputedObjectStorageNameHaxe(left);
  const reflective =
    !storageName && (left.semantics.receivers.includes('object') || left.semantics.receivers.includes('unknown'));
  if (!reflective && isAssignmentOperatorDirectHaxe(expression.operator, expression.semantics)) return undefined;
  const runtime = `${context.options.runtimeModule ?? 'flighthq._internal'}._Js`;
  const receiver = getGeneratedTargetNameHaxe('assignmentReceiver', context);
  const key = getGeneratedTargetNameHaxe('assignmentKey', context);
  const value = getGeneratedTargetNameHaxe('assignmentValue', context);
  const setup = `final ${receiver}:Dynamic = ${emitExpression(left.object, context)}; final ${key}:Dynamic = ${emitExpression(left.index, context)};`;
  const right = emitAssignmentRightHaxe(expression, context);
  if (expression.operator === '=') {
    return `(function() { ${setup} final ${value}:Dynamic = ${right}; ${runtime}.setProperty(${receiver}, ${key}, ${value}); return ${value}; })()`;
  }
  const directTarget = storageName ? `${receiver}.${safeHaxeName(storageName)}` : `${receiver}[Std.int(${key})]`;
  const current = reflective ? `${runtime}.getProperty(${receiver}, ${key})` : directTarget;
  const write = (result: string): string =>
    reflective ? `${runtime}.setProperty(${receiver}, ${key}, ${result})` : `${directTarget} = ${result}`;
  if (expression.operator === '&&=' || expression.operator === '||=' || expression.operator === '??=') {
    const condition =
      expression.operator === '??='
        ? `${value} == null`
        : expression.operator === '&&='
          ? `${runtime}.truthy(${value})`
          : `!${runtime}.truthy(${value})`;
    return `(function() { ${setup} var ${value}:Dynamic = ${current}; if (${condition}) { ${value} = ${right}; ${write(value)}; } return ${value}; })()`;
  }
  const updated = emitJavaScriptBinaryRuntimeCallHaxe(
    expression.operator.slice(0, -1) as IrBinaryOperator,
    value,
    right,
    runtime,
  );
  if (!updated) return undefined;
  const result = getGeneratedTargetNameHaxe('assignmentResult', context);
  return `(function() { ${setup} final ${value}:Dynamic = ${current}; final ${result}:Dynamic = ${updated}; ${write(result)}; return ${result}; })()`;
}

function emitJavaScriptAssignmentToTargetHaxe(
  operator: IrAssignmentOperator,
  target: string,
  right: string,
  runtime: string,
): string | undefined {
  if (operator === '&&=' || operator === '||=') {
    const condition = `${runtime}.truthy(${target})`;
    const assignWhenTrue = operator === '&&=';
    return `{ if (${assignWhenTrue ? condition : `!${condition}`}) ${target} = ${right}; ${target}; }`;
  }
  const value = emitJavaScriptBinaryRuntimeCallHaxe(operator.slice(0, -1) as IrBinaryOperator, target, right, runtime);
  return value ? `${target} = ${value}` : undefined;
}

function emitJavaScriptBinaryOperatorHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  context: EmitContext,
): string | undefined {
  if (isBinaryOperatorDirectHaxe(expression.operator, expression.semantics)) return undefined;
  const runtime = `${context.options.runtimeModule ?? 'flighthq._internal'}._Js`;
  const left = emitExpression(expression.left, context);
  const right = emitExpression(expression.right, context);
  if (expression.operator === '&&' || expression.operator === '||') {
    const value = getGeneratedTargetNameHaxe('logicalLeftValue', context);
    const whenTruthy = expression.operator === '&&' ? right : value;
    const whenFalsy = expression.operator === '&&' ? value : right;
    return `(function() { final ${value}:Dynamic = ${left}; return ${runtime}.truthy(${value}) ? ${whenTruthy} : ${whenFalsy}; })()`;
  }
  return emitJavaScriptBinaryRuntimeCallHaxe(expression.operator, left, right, runtime);
}

function emitJavaScriptBinaryRuntimeCallHaxe(
  operator: IrBinaryOperator,
  left: string,
  right: string,
  runtime: string,
): string | undefined {
  const method: Partial<Record<IrBinaryOperator, string>> = {
    '!=': 'looseEqual',
    '!==': 'strictEqual',
    '%': 'remainder',
    '&': 'bitwiseAnd',
    '*': 'multiply',
    '**': 'power',
    '+': 'add',
    '-': 'subtract',
    '/': 'divide',
    '<': 'lessThan',
    '<<': 'shiftLeft',
    '<=': 'lessThanOrEqual',
    '==': 'looseEqual',
    '===': 'strictEqual',
    '>': 'greaterThan',
    '>=': 'greaterThanOrEqual',
    '>>': 'shiftRight',
    '>>>': 'shiftRightUnsigned',
    '^': 'bitwiseXor',
    in: 'inOperator',
    instanceof: 'instanceOf',
    '|': 'bitwiseOr',
  };
  const target = method[operator];
  if (!target) return undefined;
  const call = `${runtime}.${target}(${left}, ${right})`;
  return operator === '!=' || operator === '!==' ? `!${call}` : call;
}

function emitJavaScriptPrefixUnaryOperatorHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'unary'; postfix: false }>>,
  operand: string,
  context: EmitContext,
): string | undefined {
  if (isPrefixUnaryOperatorDirectHaxe(expression.operator, expression.semantics)) return undefined;
  const runtime = `${context.options.runtimeModule ?? 'flighthq._internal'}._Js`;
  if (expression.operator === '!') return `!${runtime}.truthy(${operand})`;
  if (expression.operator === '+') return `${runtime}.toNumber(${operand})`;
  if (expression.operator === '-') return `-${runtime}.toNumber(${operand})`;
  if (expression.operator === '~') return `${runtime}.bitwiseNot(${operand})`;
  if (expression.operator === 'typeof') return `${runtime}.typeOf(${operand})`;
  if (expression.operator === 'void') return `(function() { ${operand}; return null; })()`;
  if (expression.operator === 'delete') {
    if (expression.operand.kind === 'property') {
      return `Reflect.deleteField(${emitExpression(expression.operand.object, context)}, ${JSON.stringify(safeHaxeName(expression.operand.name))})`;
    }
    if (expression.operand.kind === 'element') {
      const storageName = getComputedObjectStorageNameHaxe(expression.operand);
      if (storageName) {
        return `Reflect.deleteField(${emitExpression(expression.operand.object, context)}, ${JSON.stringify(storageName)})`;
      }
      return `${runtime}.deleteProperty(${emitExpression(expression.operand.object, context)}, ${emitExpression(expression.operand.index, context)})`;
    }
  }
  return undefined;
}

function emitAssignmentRightHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'assignment' }>>,
  context: EmitContext,
): string {
  if (
    expression.operator === '=' &&
    expression.semantics.left.flow === 'unknown' &&
    expression.right.kind === 'identifier' &&
    expression.right.reference.kind === 'ambient' &&
    expression.right.reference.name === 'undefined'
  ) {
    // A source assignment to an unknown/any slot is valid precisely because that slot admits every
    // value. Preserve JavaScript's observable distinction between undefined and null on the JS target.
    return 'js.Syntax.code("undefined")';
  }
  return emitExpression(expression.right, context);
}

function getComputedObjectStorageNameHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'element' }>>,
): string | undefined {
  const index = expression.index;
  return expression.semantics.key === 'symbol' && index.kind === 'identifier' && index.reference.kind === 'binding'
    ? safeHaxeName(index.reference.binding.name)
    : undefined;
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

function emitObjectExpressionHaxe(expression: Readonly<IrObjectExpression>, context: EmitContext): string {
  if (expression.members.some((member) => member.kind === 'getAccessor')) {
    return emitObjectAccessorExpressionHaxe(expression, context);
  }
  if (expression.members.every((member) => member.kind === 'property')) {
    return `{ ${expression.members
      .map((member) => `${safeHaxeName(member.name)}: ${emitExpression(member.value, context)}`)
      .join(', ')} }`;
  }
  const target = getGeneratedTargetNameHaxe('objectSpreadValue', context);
  const lines = [`final ${target}:Dynamic = {};`];
  for (const member of expression.members) {
    if (member.kind === 'property') {
      lines.push(
        `Reflect.setField(${target}, ${JSON.stringify(safeHaxeName(member.name))}, ${emitExpression(member.value, context)});`,
      );
      continue;
    }
    if (member.kind === 'computedProperty') {
      const storageName = getComputedObjectPropertyStorageNameHaxe(member.key, context);
      lines.push(
        storageName
          ? `Reflect.setField(${target}, ${JSON.stringify(storageName)}, ${emitExpression(member.value, context)});`
          : `${context.options.runtimeModule ?? 'flighthq._internal'}._Js.setProperty(${target}, ${emitExpression(member.key, context)}, ${emitExpression(member.value, context)});`,
      );
      continue;
    }
    if (member.kind === 'spread') {
      const source = getGeneratedTargetNameHaxe('objectSpreadSource', context);
      const key = getGeneratedTargetNameHaxe('objectSpreadKey', context);
      lines.push(
        `final ${source}:Dynamic = ${emitExpression(member.expression, context)};`,
        `if (${source} != null) for (${key} in Reflect.fields(${source})) Reflect.setField(${target}, ${key}, Reflect.field(${source}, ${key}));`,
      );
      continue;
    }
    emissionError(context, 'object getter escaped accessor-specific Haxe lowering');
  }
  lines.push(`return ${target};`);
  return `(function() {\n${indentSourceLines(lines).join('\n')}\n})()`;
}

function emitObjectAccessorExpressionHaxe(expression: Readonly<IrObjectExpression>, context: EmitContext): string {
  if (expression.members.some((member) => member.kind === 'computedProperty' || member.kind === 'spread')) {
    emissionError(context, 'object accessors mixed with computed properties or spreads require ordered lowering');
  }
  const className = getGeneratedTargetNameHaxe('ObjectAccessor', context);
  const constructorParameters = expression.members.map((member, index) =>
    member.kind === 'getAccessor' ? `_getter_${String(index)}:()->Dynamic` : `_value_${String(index)}:Dynamic`,
  );
  const constructorAssignments = expression.members.map((member, index) => {
    if (member.kind === 'getAccessor') return `this._getter_${String(index)} = _getter_${String(index)};`;
    if (member.kind === 'property') return `this.${safeHaxeName(member.name)} = _value_${String(index)};`;
    return emissionError(context, 'object accessor member escaped named-member validation');
  });
  const fields = expression.members.flatMap((member, index): string[] =>
    member.kind === 'getAccessor'
      ? [
          `  public var ${safeHaxeName(member.name)}(get, never):Dynamic;`,
          `  private final _getter_${String(index)}:()->Dynamic;`,
          `  private function get_${safeHaxeName(member.name)}():Dynamic return this._getter_${String(index)}();`,
        ]
      : member.kind === 'property'
        ? [`  public var ${safeHaxeName(member.name)}:Dynamic;`]
        : emissionError(context, 'object accessor member escaped named-member validation'),
  );
  context.objectAccessorClasses.push([
    `private class ${className} {`,
    ...fields,
    '',
    `  public function new(${constructorParameters.join(', ')}) {`,
    ...constructorAssignments.map((assignment) => `    ${assignment}`),
    '  }',
    '}',
  ]);
  const arguments_ = expression.members.map((member) =>
    member.kind === 'property' || member.kind === 'getAccessor'
      ? emitExpression(member.value, context)
      : emissionError(context, 'object accessor member escaped named-member validation'),
  );
  return `new ${className}(${arguments_.join(', ')})`;
}

function getComputedObjectPropertyStorageNameHaxe(
  key: Readonly<IrExpression>,
  context: EmitContext,
): string | undefined {
  if (key.kind !== 'identifier' || key.reference.kind !== 'binding') return undefined;
  const bindingId = key.reference.binding.id;
  for (const module of context.sourceModules) {
    for (const declaration of module.declarations) {
      const properties =
        declaration.kind === 'interface'
          ? declaration.properties
          : declaration.kind === 'typeAlias' && declaration.type.kind === 'object'
            ? declaration.type.properties
            : [];
      const property = properties.find(
        (candidate) => candidate.computedKey?.kind === 'binding' && candidate.computedKey.binding.id === bindingId,
      );
      if (property) return safeHaxeName(property.name);
    }
  }
  return undefined;
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

function emitFunction(declaration: Readonly<IrFunctionDeclaration>, outer: EmitContext): string[] {
  if (declaration.namespaceMember) {
    emissionError(outer, `value namespace function ${declaration.binding.name} requires Haxe namespace lowering`);
  }
  // A module-level static carries no access or `static` keyword: it is already a member of the
  // module rather than of a type, and Haxe rejects both there.
  const access = '';
  const context: EmitContext = {
    ...outer,
    finallyCompletion: undefined,
    returnsAbsent: canIrTypeReturnAbsentHaxe(declaration.returns, outer.module),
  };
  return [
    `${access}function ${getBindingTargetNameHaxe(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)}(${emitParameters(declaration.parameters, context)}):${emitType(declaration.returns, context)} {`,
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
    for (const binding of imported.bindings) {
      if (binding.imported === '*' || binding.imported === 'default') {
        emissionError(context, `${binding.imported} imports require explicit Haxe mapping for ${imported.specifier}`);
      }
      const importedName = getImportedTargetNameHaxe(imported, binding, context);
      const localName = getBindingTargetNameHaxe(binding.binding, context);
      const modulePath = haxeImportModule(imported.specifier, context, binding.imported);
      emitted.add(`import ${modulePath}.${importedName}${importedName === localName ? '' : ` as ${localName}`};`);
    }
  }
  return [...emitted].sort();
}

function getImportedTargetNameHaxe(
  imported: Readonly<IrImport>,
  binding: Readonly<IrImport['bindings'][number]>,
  context: EmitContext,
): string {
  const typeLane = binding.binding.space === 'type';
  const fallback = typeLane ? safeHaxeTypeName(binding.imported) : safeHaxeName(binding.imported);
  const sourceModule = getHaxeResolvedImportModule(imported.specifier, context, binding.imported);
  if (!sourceModule) return fallback;
  const direct = sourceModule.declarations.find(
    (declaration) =>
      'binding' in declaration &&
      declaration.binding.name === binding.imported &&
      (typeLane
        ? declaration.kind === 'class' ||
          declaration.kind === 'enum' ||
          declaration.kind === 'interface' ||
          declaration.kind === 'typeAlias'
        : declaration.kind === 'class' ||
          declaration.kind === 'enum' ||
          declaration.kind === 'function' ||
          declaration.kind === 'variable'),
  );
  if (direct && 'binding' in direct) return getSourceBindingTargetNameHaxe(sourceModule, direct.binding, context);
  const facade = context.getModuleFacade?.(sourceModule);
  const slot = facade?.modules
    .find((module) => isHaxeCompilerModuleIdentityEqual(module.module, sourceModule))
    ?.slots.find((candidate) => candidate.exportName === binding.imported && candidate.lane === binding.binding.space);
  if (
    !slot ||
    (slot.source.kind !== 'module-all' && slot.source.kind !== 'module-binding') ||
    slot.route.kind !== 'binding' ||
    (!typeLane && slot.route.binding.kind !== 'class' && slot.route.binding.kind !== 'enum')
  ) {
    return fallback;
  }
  return (
    createHaxeFacadeTypeTargetNames(sourceModule, facade, createIrModuleTargetNamesHaxe(sourceModule)).get(
      binding.imported,
    ) ?? fallback
  );
}

// Haxe re-exports types with aliases and values with forwarding module fields. Mutable bindings are
// exposed through a read-only property: every access calls through to the source module, preserving
// JavaScript's live re-export semantics without allowing assignment through the exported binding.
// The source's own closure with its first two parameters exchanged. Wrapping it in another closure
// would work too, and would put a call where the source wrote none; exchanging the names leaves the
// body exactly as written.
function emitExchangedClosureHaxe(expression: Readonly<IrExpression>, context: EmitContext): string {
  if (expression.kind !== 'function' || expression.parameters.length < 2) {
    return emissionError(context, 'folding a collection requires a step written where it is passed');
  }
  const [accumulated, item, ...rest] = expression.parameters;
  const exchanged = [item!, accumulated!, ...rest]
    .map((parameter) => `${getBindingTargetNameHaxe(parameter.binding, context)}:${emitType(parameter.type, context)}`)
    .join(', ');
  return expression.expression
    ? `function(${exchanged}) return ${emitExpression(expression.expression, context)}`
    : `function(${exchanged}) {\n${indentSourceLines(emitStatements(expression.body, context)).join('\n')}\n}`;
}

function emitReexportsHaxe(exports: readonly IrExport[], context: EmitContext): string[] {
  const typeLines = new Set<string>();
  const valueLines: string[] = [];
  let hasStarReexport = false;
  for (const exported of exports) {
    if (exported.kind === 'local') continue;
    if (exported.kind === 'all') {
      hasStarReexport = true;
      continue;
    }
    if (exported.kind !== 'reexport') {
      emissionError(context, `${exported.kind} exports require Haxe module-facade lowering`);
    }
    const modulePath = haxeImportModule(exported.specifier, context);
    if (!exported.typeOnly) {
      valueLines.push(...emitValueReexportForwardingHaxe(exported, modulePath, context));
      continue;
    }
    const targetName =
      context.facadeTypeTargetNames.get(exported.exported) ??
      getGeneratedTargetNameHaxe(
        safeHaxeTypeName(`${haxeImplementationModule(context.module.source)}_${exported.exported}`),
        context,
      );
    const slot = context.moduleFacadeSlots.find(
      (candidate) =>
        candidate.exportName === exported.exported &&
        candidate.lane === 'type' &&
        candidate.source.kind === 'module-binding' &&
        candidate.route.kind === 'binding',
    );
    const target = slot ? getModuleFacadeBindingTargetHaxe(slot, context) : undefined;
    const targetModulePath = target ? getHaxeModulePath(target.module, context.options) : modulePath;
    const sourceName = target
      ? getSourceBindingTargetNameHaxe(target.module, target.binding, context)
      : safeHaxeTypeName(exported.imported);
    typeLines.add(`typedef ${targetName} = ${targetModulePath}.${sourceName};`);
  }
  if (hasStarReexport) {
    const facadeLines = emitStarReexportFacadeHaxe(context);
    facadeLines.typeLines.forEach((line) => typeLines.add(line));
    valueLines.push(...facadeLines.valueLines);
  }
  return [...[...typeLines].sort(), ...valueLines];
}

function emitStarReexportFacadeHaxe(
  context: EmitContext,
): Readonly<{ typeLines: readonly string[]; valueLines: readonly string[] }> {
  const slots = context.moduleFacadeSlots.filter((slot) => slot.source.kind === 'module-all');
  if (slots.length === 0) emissionError(context, 'all exports require Haxe module-facade lowering');
  const byName = new Map<string, CompilerModuleFacadeSlot[]>();
  for (const slot of slots) {
    const existing = byName.get(slot.exportName) ?? [];
    existing.push(slot);
    byName.set(slot.exportName, existing);
  }
  const exports_ = [...byName]
    .sort(([left], [right]) => compareTextCodeUnits(left, right))
    .map(([exportName, namedSlots]) => {
      const typeSlot = namedSlots.find((slot) => slot.lane === 'type');
      const valueSlot = namedSlots.find((slot) => slot.lane === 'value');
      const typeTarget = typeSlot ? getModuleFacadeBindingTargetHaxe(typeSlot, context) : undefined;
      const valueTarget = valueSlot ? getModuleFacadeBindingTargetHaxe(valueSlot, context) : undefined;
      const sharedNominal =
        typeTarget !== undefined &&
        valueTarget !== undefined &&
        typeTarget.binding.id === valueTarget.binding.id &&
        (valueTarget.binding.kind === 'class' || valueTarget.binding.kind === 'enum');
      const valueName =
        valueTarget && !sharedNominal ? getGeneratedTargetNameHaxe(safeHaxeName(exportName), context) : undefined;
      const typeName = typeTarget ? context.facadeTypeTargetNames.get(exportName) : undefined;
      if (typeTarget && typeName) context.facadeBindingTargetNames.set(typeTarget.binding.id, typeName);
      if (sharedNominal && valueTarget && typeName) {
        context.facadeBindingTargetNames.set(valueTarget.binding.id, typeName);
      }
      return { exportName, sharedNominal, typeName, typeTarget, valueName, valueTarget };
    });
  const typeLines: string[] = [];
  const valueLines: string[] = [];
  for (const { exportName, sharedNominal, typeName, typeTarget, valueName, valueTarget } of exports_) {
    if (typeTarget && typeName) {
      typeLines.push(
        `typedef ${typeName} = ${getHaxeModulePath(typeTarget.module, context.options)}.${getSourceBindingTargetNameHaxe(typeTarget.module, typeTarget.binding, context)};`,
      );
    }
    if (!valueTarget || sharedNominal || !valueName) continue;
    const modulePath = getHaxeModulePath(valueTarget.module, context.options);
    const sourceName = getSourceBindingTargetNameHaxe(valueTarget.module, valueTarget.binding, context);
    if (valueTarget.declaration.kind === 'function') {
      valueLines.push(
        ...emitFunctionReexportForwardingHaxe(valueName, sourceName, valueTarget.declaration, modulePath, context),
      );
      continue;
    }
    if (valueTarget.declaration.kind === 'variable') {
      const type = valueTarget.declaration.type ? emitType(valueTarget.declaration.type, context) : 'Dynamic';
      if (valueTarget.declaration.mutable) {
        valueLines.push(...emitMutableValueReexportForwardingHaxe(valueName, sourceName, type, modulePath, context));
        continue;
      }
      valueLines.push(`final ${valueName}:${type} = ${modulePath}.${sourceName};`);
      continue;
    }
    emissionError(context, `re-exporting value ${exportName} requires Haxe module-facade lowering`);
  }
  return { typeLines, valueLines };
}

function getModuleFacadeBindingTargetHaxe(
  slot: Readonly<CompilerModuleFacadeSlot>,
  context: EmitContext,
): Readonly<{
  binding: IrBindingIdentity | IrTypeBindingIdentity;
  declaration: Readonly<IrDeclaration>;
  module: Readonly<IrModule>;
}> {
  const route = slot.route;
  if (route.kind !== 'binding') {
    return emissionError(context, `re-exporting ${slot.exportName} requires a bound Haxe module-facade route`);
  }
  const module = context.sourceModules.find((candidate) => isHaxeCompilerModuleIdentityEqual(candidate, route.module));
  if (!module) emissionError(context, `re-exporting ${slot.exportName} requires its source Haxe module`);
  const declaration = module.declarations.find(
    (candidate) => 'binding' in candidate && candidate.binding.id === route.binding.id,
  );
  if (!declaration) emissionError(context, `re-exporting ${slot.exportName} requires its source declaration`);
  return { binding: route.binding, declaration, module };
}

function emitValueReexportForwardingHaxe(
  exported: Readonly<{ exported: string; imported: string; specifier: string }>,
  modulePath: string,
  context: EmitContext,
): string[] {
  const facadeSlot = context.moduleFacadeSlots.find(
    (slot) =>
      slot.lane === 'value' &&
      slot.exportName === exported.exported &&
      slot.source.kind === 'module-binding' &&
      slot.source.specifier === exported.specifier &&
      slot.source.imported === exported.imported,
  );
  if (facadeSlot) {
    const target = getModuleFacadeBindingTargetHaxe(facadeSlot, context);
    return emitValueReexportTargetHaxe(exported.exported, target, context);
  }
  const sourceModule = getHaxeResolvedImportModule(exported.specifier, context, exported.imported);
  if (!sourceModule) {
    emissionError(
      context,
      `re-exporting the value ${exported.exported} requires the re-exported signature to forward to`,
    );
  }
  const declaration = sourceModule.declarations.find(
    (candidate): candidate is Readonly<IrDeclaration & { binding: IrBindingIdentity | IrTypeBindingIdentity }> =>
      'binding' in candidate && candidate.binding.name === exported.imported,
  );
  if (!declaration) {
    emissionError(
      context,
      `re-exporting the value ${exported.exported} requires the re-exported signature to forward to`,
    );
  }
  return emitValueReexportTargetHaxe(
    exported.exported,
    { binding: declaration.binding, declaration, module: sourceModule },
    context,
  );
}

function emitValueReexportTargetHaxe(
  exportName: string,
  target: Readonly<{
    binding: IrBindingIdentity | IrTypeBindingIdentity;
    declaration: Readonly<IrDeclaration>;
    module: Readonly<IrModule>;
  }>,
  context: EmitContext,
): string[] {
  const modulePath = getHaxeModulePath(target.module, context.options);
  const sourceName = getSourceBindingTargetNameHaxe(target.module, target.binding, context);
  if (target.declaration.kind === 'function') {
    return emitFunctionReexportForwardingHaxe(
      safeHaxeName(exportName),
      sourceName,
      target.declaration,
      modulePath,
      context,
    );
  }
  if (target.declaration.kind === 'variable') {
    const type = target.declaration.type ? emitType(target.declaration.type, context) : 'Dynamic';
    if (target.declaration.mutable) {
      return emitMutableValueReexportForwardingHaxe(safeHaxeName(exportName), sourceName, type, modulePath, context);
    }
    return [`final ${safeHaxeName(exportName)}:${type} = ${modulePath}.${sourceName};`];
  }
  if (target.declaration.kind === 'class' || target.declaration.kind === 'enum') {
    const targetName =
      context.facadeTypeTargetNames.get(exportName) ??
      getGeneratedTargetNameHaxe(
        safeHaxeTypeName(`${haxeImplementationModule(context.module.source)}_${exportName}`),
        context,
      );
    return [`typedef ${targetName} = ${modulePath}.${sourceName};`];
  }
  emissionError(context, `re-exporting value ${exportName} requires Haxe module-facade lowering`);
}

function emitMutableValueReexportForwardingHaxe(
  targetName: string,
  sourceName: string,
  type: string,
  modulePath: string,
  context: EmitContext,
): string[] {
  const getterName = `get_${targetName}`;
  if (context.generatedNames.has(getterName)) {
    emissionError(context, `mutable value re-export ${targetName} conflicts with Haxe accessor ${getterName}`);
  }
  context.generatedNames.add(getterName);
  return [
    `var ${targetName}(get, never):${type};`,
    `inline function ${getterName}():${type} return ${modulePath}.${sourceName};`,
  ];
}

function emitFunctionReexportForwardingHaxe(
  targetName: string,
  sourceName: string,
  declaration: Readonly<IrFunctionDeclaration>,
  modulePath: string,
  context: EmitContext,
): string[] {
  const params = declaration.parameters
    .map((p) => {
      const name = safeHaxeName(p.binding.name);
      const type = p.dependentCallablePack ? 'Dynamic' : emitType(p.type, context);
      if (p.rest) {
        const elementType = p.type.kind === 'array' ? emitType(p.type.element, context) : type;
        return `...${name}:${elementType}`;
      }
      if (p.initializer) return `${name}:${type} = ${emitExpression(p.initializer, context)}`;
      return `${p.optional ? '?' : ''}${name}:${type}`;
    })
    .join(', ');
  const args = declaration.parameters
    .map((parameter) => `${parameter.rest ? '...' : ''}${safeHaxeName(parameter.binding.name)}`)
    .join(', ');
  const returnType = emitType(declaration.returns, context);
  return [
    `function ${targetName}${emitTypeParameters(declaration.typeParameters, context)}(${params}):${returnType} {`,
    `  return ${modulePath}.${sourceName}(${args});`,
    '}',
  ];
}

// A data shape as a class rather than an anonymous structure. Haxe's `@:structInit` keeps the
// source's own construction syntax working — an object literal still builds it — while the fields
// become real class fields, which is what the static targets can address by offset. The class is
// `final` because the source declared a shape, not a base to extend.
function emitStructInitRecordHaxe(
  targetName: string,
  typeParameters: readonly IrTypeParameter[],
  properties: readonly IrObjectTypeProperty[],
  context: EmitContext,
): string[] {
  return [
    '@:structInit',
    `final class ${targetName}${emitTypeParameters(typeParameters, context)} {`,
    ...properties.map((property) => {
      const type = emitType(property.type, context);
      // An optional member has to be defaulted, because `@:structInit` reads a field's default as
      // permission to leave it out of the literal.
      return property.optional
        ? `  public var ${safeHaxeName(property.name)}:${hasIrTypeNullMemberHaxe(property.type) ? type : `Null<${type}>`} = null;`
        : `  public var ${safeHaxeName(property.name)}:${type};`;
    }),
    '}',
  ];
}

function emitInterface(declaration: Readonly<IrInterfaceDeclaration>, context: EmitContext): string[] {
  const ambientTarget = context.ambientUtilityHeritageTargets.get(declaration.binding.id);
  if (ambientTarget) {
    return [
      `typedef ${getBindingTargetNameHaxe(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)} = ${ambientTarget};`,
    ];
  }
  if (context.options.structuralRecords === 'structInit' && !hasIrModuleClassImplementingHaxe(declaration, context)) {
    return emitStructInitRecordHaxe(
      getBindingTargetNameHaxe(declaration.binding, context),
      declaration.typeParameters,
      declaration.properties,
      context,
    );
  }
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

function createAmbientUtilityHeritageTargetsHaxe(module: Readonly<IrModule>): ReadonlyMap<string, string> {
  return new Map(
    module.declarations.flatMap((declaration) => {
      if (declaration.kind !== 'interface') return [];
      const target = getCompilerAmbientUtilityHeritageTargetHaxe(declaration, module);
      return target ? [[declaration.binding.id, target] as const] : [];
    }),
  );
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

function emitCastExpressionHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'cast' }>>,
  context: EmitContext,
): string {
  const inner = emitExpression(expression.expression, context);
  if (isIrCastTargetUntypedHaxe(expression.type, context)) return `cast(${inner})`;
  return `cast(${inner}, ${emitType(expression.type, context)})`;
}

function isIrCastTargetTypedefHaxe(type: Readonly<IrType>, context: EmitContext): boolean {
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return false;
  const bindingId = type.reference.binding.id;
  const declaration = context.module.declarations.find(
    (candidate) => candidate.kind === 'interface' && candidate.binding.id === bindingId,
  );
  if (!declaration || declaration.kind !== 'interface') return false;
  return !hasIrModuleClassImplementingHaxe(declaration, context);
}

function isIrCastTargetUntypedHaxe(type: Readonly<IrType>, context: EmitContext): boolean {
  if (type.kind === 'array' || type.kind === 'tuple') return true;
  return isIrCastTargetTypedefHaxe(type, context);
}

function isIrNarrowedMemberTypedefHaxe(name: string, context: EmitContext): boolean {
  const declaration = context.module.declarations.find(
    (candidate) => candidate.kind === 'interface' && candidate.binding.name === name,
  );
  if (!declaration || declaration.kind !== 'interface') return false;
  return !hasIrModuleClassImplementingHaxe(declaration, context);
}

function emitIdentifierReferenceHaxe(reference: Readonly<IrIdentifierReference>, context: EmitContext): string {
  if (reference.kind === 'super') return 'super';
  if (reference.kind === 'this') return 'this';
  if (reference.kind === 'ambient') {
    if (reference.name === 'undefined') {
      return 'js.Syntax.code("undefined")';
    }
    if (reference.name === 'Number') {
      return `${context.options.runtimeModule ?? 'flighthq._internal'}._Js.toNumber`;
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

function hasIrTypeAbsentMemberHaxe(
  type: Readonly<IrType>,
  module: Readonly<IrModule>,
  activeAliases: ReadonlySet<string> = new Set(),
): boolean {
  if (hasIrTypeAbsentMember(type)) return true;
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.path.length > 0 ||
    activeAliases.has(type.reference.binding.id)
  ) {
    return false;
  }
  const bindingId = type.reference.binding.id;
  const declaration = module.declarations.find(
    (candidate): candidate is IrTypeAliasDeclaration =>
      candidate.kind === 'typeAlias' && candidate.binding.id === bindingId,
  );
  if (!declaration) return false;
  try {
    const substituted = resolveIrTypeStructuralSubstitution(
      declaration.type,
      createIrTypeParameterSubstitutionPlan(declaration.typeParameters, type.typeArguments),
    );
    return hasIrTypeAbsentMemberHaxe(substituted, module, new Set(activeAliases).add(type.reference.binding.id));
  } catch {
    return false;
  }
}

function canIrTypeReturnAbsentHaxe(type: Readonly<IrType>, module: Readonly<IrModule>): boolean {
  return (
    type.kind === 'unknown' ||
    (type.kind === 'named' &&
      type.reference.kind === 'ambient' &&
      getCompilerRuntimeExternalSymbolTargetHaxe(type.reference.name, 'type') === 'Dynamic') ||
    hasIrTypeAbsentMemberHaxe(type, module)
  );
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
  return (
    declaration.extends?.reference.kind === 'ambient' &&
    (declaration.extends.reference.name === 'Error' ||
      declaration.extends.reference.name === 'RangeError' ||
      declaration.extends.reference.name === 'TypeError')
  );
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
      // Haxe represents a rest pack as one element type. A dependent TypeScript `Parameters<T>`
      // cannot name that element until T is instantiated, so keep the pack dynamically represented;
      // its semantic evidence still preserves the callable relationship for targets that specialize it.
      const type = parameter.dependentCallablePack ? 'Dynamic' : emitType(parameter.type, context);
      if (type === 'Array<Dynamic>') context.dynamicBindingIds.add(parameter.binding.id);
      if (parameter.rest) {
        const elementType = parameter.type.kind === 'array' ? emitType(parameter.type.element, context) : type;
        return `...${name}:${elementType}`;
      }
      if (parameter.initializer) return `${name}:${type} = ${emitExpression(parameter.initializer, context)}`;
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
        `if (${normalizeSourceTextGrouping(emitExpression(statement.condition, context))}) {`,
        ...indentSourceLines(emitStatementBody(statement.consequent, context)),
        '}',
      ];
      if (statement.otherwise)
        lines.push('else {', ...indentSourceLines(emitStatementBody(statement.otherwise, context)), '}');
      return lines;
    }
    case 'return':
      // Comparing against an absent value is not narrowing it. Returning a binding that can be absent
      // from a function that cannot return one is source the target rejects, so it refuses here — and
      // a reference narrowing proved present is emitted directly, because `Null<T>` exists precisely
      // to unify with `T`, and the proof guarantees the runtime check it may insert will pass.
      if (
        !context.returnsAbsent &&
        statement.expression?.kind === 'identifier' &&
        statement.expression.reference.kind === 'binding' &&
        statement.expression.presence !== 'narrowedPresent' &&
        context.nullableBindingIds.has(statement.expression.reference.binding.id)
      ) {
        emissionError(
          context,
          `returning nullable binding ${statement.expression.reference.binding.name} requires Haxe narrowing evidence`,
        );
      }
      if (context.finallyCompletion) {
        const completion = context.finallyCompletion;
        return [
          ...(statement.expression && completion.returnValueName
            ? [
                `${completion.returnValueName} = ${normalizeSourceTextGrouping(emitExpression(statement.expression, context))};`,
              ]
            : []),
          `${completion.returnedName} = true;`,
          `throw ${completion.returnSignalName};`,
        ];
      }
      return [
        `return${statement.expression ? ` ${normalizeSourceTextGrouping(emitExpression(statement.expression, context))}` : ''};`,
      ];
    case 'switch': {
      if (statement.label) {
        emissionError(context, `labeled switch ${statement.label.name} requires Haxe switch completion lowering`);
      }
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
      return statement.finallyBody
        ? emitTryFinallyHaxe(statement as typeof statement & { finallyBody: IrStatement }, context)
        : emitTryCatchHaxe(statement, context);
    case 'variable':
      return statement.declarations.map((variable) => emitVariable(variable, context));
    case 'while':
      return emitControlFlowBoundaryHaxe(statement.label, true, context, () => [
        `while (${normalizeSourceTextGrouping(emitExpression(statement.condition, context))}) {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ]);
  }
}

function emitTryCatchHaxe(statement: Readonly<Extract<IrStatement, { kind: 'try' }>>, context: EmitContext): string[] {
  const lines = ['try {', ...indentSourceLines(emitStatementBody(statement.tryBody, context)), '}'];
  if (!statement.catchClause) return lines;
  const errorName = statement.catchClause.binding
    ? getBindingTargetNameHaxe(statement.catchClause.binding, context)
    : getGeneratedTargetNameHaxe('error', context);
  lines.push(`catch (${errorName}:Dynamic) {`);
  if (context.finallyCompletion) {
    lines.push(
      ...indentSourceLines([`if (${errorName} == ${context.finallyCompletion.returnSignalName}) throw ${errorName};`]),
    );
  }
  lines.push(...indentSourceLines(emitStatementBody(statement.catchClause.body, context)), '}');
  return lines;
}

function emitTryFinallyHaxe(
  statement: Readonly<Extract<IrStatement, { kind: 'try' }>> & { finallyBody: IrStatement },
  context: EmitContext,
): string[] {
  const hasReturn =
    containsReturnStatementHaxe(statement.tryBody) ||
    (statement.catchClause ? containsReturnStatementHaxe(statement.catchClause.body) : false);
  const hasValueReturn =
    containsValueReturnStatementHaxe(statement.tryBody) ||
    (statement.catchClause ? containsValueReturnStatementHaxe(statement.catchClause.body) : false);
  const returnSignalName = getGeneratedTargetNameHaxe('finallyReturnSignal', context);
  const returnedName = getGeneratedTargetNameHaxe('finallyReturned', context);
  const returnValueName = hasValueReturn ? getGeneratedTargetNameHaxe('finallyReturnValue', context) : undefined;
  const failedName = getGeneratedTargetNameHaxe('finallyFailed', context);
  const failureName = getGeneratedTargetNameHaxe('finallyFailure', context);
  const errorName = getGeneratedTargetNameHaxe('finallyError', context);
  const completion: HaxeFinallyCompletion = { returnSignalName, returnValueName, returnedName };
  const innerContext: EmitContext = hasReturn ? { ...context, finallyCompletion: completion } : context;
  const lines = [
    ...(hasReturn
      ? [
          `final ${returnSignalName}:Dynamic = {};`,
          `var ${returnedName}:Bool = false;`,
          ...(returnValueName ? [`var ${returnValueName}:Dynamic = null;`] : []),
        ]
      : []),
    `var ${failedName}:Bool = false;`,
    `var ${failureName}:Dynamic = null;`,
    'try {',
    ...indentSourceLines(
      statement.catchClause
        ? emitTryCatchHaxe(statement, innerContext)
        : emitStatementBody(statement.tryBody, innerContext),
    ),
    `} catch (${errorName}:Dynamic) {`,
    ...indentSourceLines([
      ...(hasReturn ? [`if (${errorName} != ${returnSignalName}) {`] : []),
      `${hasReturn ? '  ' : ''}${failedName} = true;`,
      `${hasReturn ? '  ' : ''}${failureName} = ${errorName};`,
      ...(hasReturn ? ['}'] : []),
    ]),
    '}',
    ...emitStatementBody(statement.finallyBody, context),
    `if (${failedName}) throw ${failureName};`,
  ];
  if (!hasReturn) return lines;
  if (context.finallyCompletion) {
    const outer = context.finallyCompletion;
    lines.push(`if (${returnedName}) {`);
    if (outer.returnValueName) {
      lines.push(`  ${outer.returnValueName} = ${returnValueName ?? 'null'};`);
    }
    lines.push(`  ${outer.returnedName} = true;`, `  throw ${outer.returnSignalName};`, '}');
  } else {
    lines.push(`if (${returnedName}) return${returnValueName ? ` cast(${returnValueName})` : ''};`);
  }
  return lines;
}

function containsReturnStatementHaxe(statement: Readonly<IrStatement>): boolean {
  return containsReturnStatementMatchingHaxe(statement, () => true);
}

function containsValueReturnStatementHaxe(statement: Readonly<IrStatement>): boolean {
  return containsReturnStatementMatchingHaxe(statement, (candidate) => candidate.expression !== undefined);
}

function containsReturnStatementMatchingHaxe(
  statement: Readonly<IrStatement>,
  matches: (statement: Readonly<Extract<IrStatement, { kind: 'return' }>>) => boolean,
): boolean {
  switch (statement.kind) {
    case 'return':
      return matches(statement);
    case 'block':
      return statement.statements.some((child) => containsReturnStatementMatchingHaxe(child, matches));
    case 'do':
    case 'while':
      return containsReturnStatementMatchingHaxe(statement.body, matches);
    case 'for':
    case 'forIn':
    case 'forOf':
      return containsReturnStatementMatchingHaxe(statement.body, matches);
    case 'if':
      return (
        containsReturnStatementMatchingHaxe(statement.consequent, matches) ||
        (statement.otherwise ? containsReturnStatementMatchingHaxe(statement.otherwise, matches) : false)
      );
    case 'switch':
      return statement.cases.some((clause) =>
        clause.statements.some((child) => containsReturnStatementMatchingHaxe(child, matches)),
      );
    case 'try':
      return (
        containsReturnStatementMatchingHaxe(statement.tryBody, matches) ||
        (statement.catchClause ? containsReturnStatementMatchingHaxe(statement.catchClause.body, matches) : false) ||
        (statement.finallyBody ? containsReturnStatementMatchingHaxe(statement.finallyBody, matches) : false)
      );
    case 'break':
    case 'continue':
    case 'expression':
    case 'throw':
    case 'variable':
      return false;
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
  return emitIrTypeHaxe(type, {
    fail: (message) => emissionError(context, message),
    getBindingName: (binding) => getBindingTargetNameHaxe(binding, context),
    getExternalTypeName: (name) =>
      getCompilerRuntimeExternalSymbolTargetHaxe(name, 'type', context.options.runtimeModule),
    getMemberName: safeHaxeName,
    getTypeName: safeHaxeTypeName,
  });
}

function hasIrTypeNullMemberHaxe(type: Readonly<IrType>): boolean {
  return type.kind === 'null' || (type.kind === 'union' && type.types.some((member) => member.kind === 'null'));
}

function emitArrayIndexHaxe(index: Readonly<IrExpression>, context: EmitContext): string {
  const emitted = emitExpression(index, context);
  return index.kind === 'literal' && typeof index.value === 'number' && Number.isInteger(index.value)
    ? emitted
    : `Std.int(${emitted})`;
}

// A spread of an unbounded collection has no arity until run time, so the call itself becomes a
// reflective one: Haxe's `Reflect.callMethod` takes the arguments as an array, which is exactly the
// shape a spread already has. Fixed arguments around the spread are concatenated in source order.
function emitSpreadCallHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string {
  if (expression.optional) {
    emissionError(context, 'an optional spread call requires Haxe null-safe reflective lowering');
  }
  const groups: string[] = [];
  let fixed: string[] = [];
  for (const argument of expression.arguments) {
    if (argument.kind === 'spread') {
      if (fixed.length > 0) groups.push(`[${fixed.join(', ')}]`);
      fixed = [];
      groups.push(emitExpression(argument.expression, context));
      continue;
    }
    fixed.push(emitExpression(argument, context));
  }
  if (fixed.length > 0) groups.push(`[${fixed.join(', ')}]`);
  const args =
    groups.length === 1
      ? groups[0]!
      : `${groups[0]!}${groups
          .slice(1)
          .map((group) => `.concat(${group})`)
          .join('')}`;
  const receiver = expression.callee.kind === 'property' ? emitExpression(expression.callee.object, context) : 'null';
  return `Reflect.callMethod(${receiver}, ${emitExpression(expression.callee, context)}, ${args})`;
}

function emitAnonymousType(properties: readonly IrObjectTypeProperty[], context: EmitContext): string {
  return emitType({ kind: 'object', properties }, context);
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

// A union of string literals is how the source language spells a closed set of names, and it is what
// Haxe's `enum abstract` over `String` is for. `from String to String` keeps the comparisons the
// source already wrote working, so nothing at the use site has to change.
function emitStringLiteralUnionHaxe(
  declaration: Readonly<IrTypeAliasDeclaration>,
  values: readonly string[],
  context: EmitContext,
): string[] {
  const members = values.map((value) => ({ name: getStringLiteralEnumMemberNameHaxe(value), value }));
  if (new Set(members.map(({ name }) => name)).size !== members.length) {
    emissionError(context, `string literal union ${declaration.binding.name} has colliding Haxe member names`);
  }
  return [
    `enum abstract ${getBindingTargetNameHaxe(declaration.binding, context)}(String) from String to String {`,
    ...members.map(({ name, value }) => `  var ${name} = ${JSON.stringify(value)};`),
    '}',
  ];
}

function getStringLiteralEnumMemberNameHaxe(value: string): string {
  const operators: Readonly<Record<string, string>> = {
    '!=': 'NotEqual',
    '<': 'LessThan',
    '<=': 'LessThanOrEqual',
    '==': 'Equal',
    '>': 'GreaterThan',
    '>=': 'GreaterThanOrEqual',
  };
  const operator = operators[value];
  if (operator) return operator;
  if (value.length === 0) return 'Empty';
  const words = value
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
  const identifier = words || `Value${[...value].map((character) => character.codePointAt(0)!.toString(16)).join('_')}`;
  return safeHaxeName(/^[0-9]/u.test(identifier) ? `Value${identifier}` : identifier);
}

function emitTypeAlias(declaration: Readonly<IrTypeAliasDeclaration>, context: EmitContext): string[] {
  const literals = getIrUnionTypeStringLiteralValues(declaration.type);
  if (literals) return emitStringLiteralUnionHaxe(declaration, literals, context);
  if (context.options.structuralRecords === 'structInit' && declaration.type.kind === 'object') {
    return emitStructInitRecordHaxe(
      getBindingTargetNameHaxe(declaration.binding, context),
      declaration.typeParameters,
      declaration.type.properties,
      context,
    );
  }
  // Haxe has no union of records. The alternatives share their common fields and differ in the rest,
  // which a single anonymous structure says exactly: shared fields required, the others optional.
  // Every field is then typed, where `Dynamic` typed none of them.
  const flattened =
    declaration.type.kind === 'union' ? getIrUnionTypeFlattenedPropertiesHaxe(declaration.type, context) : undefined;
  return [
    `typedef ${getBindingTargetNameHaxe(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context)} = ${
      flattened ? emitAnonymousType(flattened, context) : emitType(declaration.type, context)
    };`,
  ];
}

// Whether this value was read out of something Haxe holds as `Array<Dynamic>` — a mixed tuple has no
// other Haxe type. Every read from one is `Dynamic` however much the source knew, so the declared
// type is reached by a cast rather than by assignment. A collection Haxe can type is read directly. A coalesce is looked through, since the default does not change where the value came
// from.
function isIrExpressionDynamicReadHaxe(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  // A default does not change where the value came from, so the read under it is what decides.
  if (expression.kind === 'undefinedDefault') return isIrExpressionDynamicReadHaxe(expression.value, context);
  if (expression.kind === 'binary' && expression.operator === '??') {
    return isIrExpressionDynamicReadHaxe(expression.left, context);
  }
  const object =
    expression.kind === 'element' || expression.kind === 'tupleRest' || expression.kind === 'tupleSuffix'
      ? expression.object
      : undefined;
  return (
    object?.kind === 'identifier' &&
    object.reference.kind === 'binding' &&
    context.dynamicBindingIds.has(object.reference.binding.id)
  );
}

function collectIrClassInheritedFieldNamesHaxe(
  declaration: Readonly<IrClassDeclaration>,
  context: EmitContext,
): ReadonlySet<string> {
  const names = new Set<string>();
  let base = resolveIrBaseClassHaxe(declaration, context);
  while (base) {
    for (const field of base.fields) {
      if (!field.static) names.add(field.name);
    }
    base = resolveIrBaseClassHaxe(base, context);
  }
  return names;
}

function resolveIrBaseClassHaxe(
  declaration: Readonly<IrClassDeclaration>,
  context: EmitContext,
): Readonly<IrClassDeclaration> | undefined {
  if (!declaration.extends || declaration.extends.reference.kind !== 'binding') return undefined;
  const baseId = declaration.extends.reference.binding.id;
  return context.module.declarations.find(
    (candidate): candidate is IrClassDeclaration => candidate.kind === 'class' && candidate.binding.id === baseId,
  );
}

function getIrClassInheritedMethodNamesHaxe(
  declaration: Readonly<IrClassDeclaration>,
  context: EmitContext,
): ReadonlySet<string> {
  const names = new Set<string>();
  let base = declaration.extends;
  const visited = new Set<string>();
  while (
    base &&
    base.kind === 'named' &&
    base.reference.kind === 'binding' &&
    !visited.has(base.reference.binding.id)
  ) {
    visited.add(base.reference.binding.id);
    const reference = base.reference;
    const target = context.module.declarations.find(
      (candidate) => candidate.kind === 'class' && candidate.binding.id === reference.binding.id,
    );
    if (target?.kind !== 'class') break;
    // An abstract method provides no implementation, so a subclass implements rather than overrides
    // it, and Haxe rejects `override` on exactly that case.
    for (const method of target.methods) {
      if (!method.abstract) names.add(method.name);
    }
    base = target.extends;
  }
  return names;
}

function getHaxePrimitiveNarrowedTypeName(name: string): string | undefined {
  const map: Record<string, string> = { boolean: 'Bool', number: 'Float', string: 'String' };
  return map[name];
}

function getTypeofTypeTestHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
): { haxeType: string; negated: boolean; operand: Readonly<IrExpression> } | undefined {
  if (
    expression.operator !== '===' &&
    expression.operator !== '==' &&
    expression.operator !== '!==' &&
    expression.operator !== '!='
  ) {
    return undefined;
  }
  const typeofSide =
    expression.left.kind === 'unary' && !expression.left.postfix && expression.left.operator === 'typeof'
      ? expression.left
      : expression.right.kind === 'unary' && !expression.right.postfix && expression.right.operator === 'typeof'
        ? expression.right
        : undefined;
  const literalSide = typeofSide === expression.left ? expression.right : expression.left;
  if (!typeofSide || literalSide.kind !== 'literal' || typeof literalSide.value !== 'string') return undefined;
  const haxeTypeMap: Record<string, string> = { boolean: 'Bool', number: 'Float', string: 'String' };
  const haxeType = haxeTypeMap[literalSide.value];
  if (!haxeType) return undefined;
  return {
    haxeType,
    negated: expression.operator === '!==' || expression.operator === '!=',
    operand: typeofSide.operand,
  };
}

function getTypeofBoundAmbientPresenceTestHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  context: EmitContext,
): boolean | undefined {
  if (!['===', '==', '!==', '!='].includes(expression.operator)) return undefined;
  const typeofSide =
    expression.left.kind === 'unary' && !expression.left.postfix && expression.left.operator === 'typeof'
      ? expression.left
      : expression.right.kind === 'unary' && !expression.right.postfix && expression.right.operator === 'typeof'
        ? expression.right
        : undefined;
  const literalSide = typeofSide === expression.left ? expression.right : expression.left;
  if (
    !typeofSide ||
    literalSide.kind !== 'literal' ||
    literalSide.value !== 'undefined' ||
    typeofSide.operand.kind !== 'identifier' ||
    typeofSide.operand.reference.kind !== 'ambient' ||
    !getCompilerRuntimeExternalSymbolTargetHaxe(
      typeofSide.operand.reference.name,
      'value',
      context.options.runtimeModule,
    )
  ) {
    return undefined;
  }
  // A value elected into the runtime binding contract is present by definition. This preserves
  // source feature tests without emitting Haxe's nonexistent JavaScript `typeof` operator.
  return expression.operator === '!==' || expression.operator === '!=';
}

function getIrModuleDeclaredTypeNameHaxe(name: string, context: EmitContext): string | undefined {
  const declaration = context.module.declarations.find(
    (candidate) =>
      (candidate.kind === 'interface' || candidate.kind === 'typeAlias') && candidate.binding.name === name,
  );
  return declaration && (declaration.kind === 'interface' || declaration.kind === 'typeAlias')
    ? getBindingTargetNameHaxe(declaration.binding, context)
    : undefined;
}

function getIrUnionTypeFlattenedPropertiesHaxe(
  type: Readonly<Extract<IrType, { kind: 'union' }>>,
  context: EmitContext,
): readonly IrObjectTypeProperty[] | undefined {
  const members: Array<readonly IrObjectTypeProperty[]> = [];
  for (const member of type.types) {
    if (member.kind !== 'named' || member.reference.kind !== 'binding') return undefined;
    const declaration = context.module.declarations.find(
      (candidate) =>
        (candidate.kind === 'interface' || candidate.kind === 'typeAlias') &&
        candidate.binding.name ===
          (member.kind === 'named' && member.reference.kind === 'binding' ? member.reference.binding.name : ''),
    );
    const properties =
      declaration?.kind === 'interface'
        ? declaration.properties
        : declaration?.kind === 'typeAlias' && declaration.type.kind === 'object'
          ? declaration.type.properties
          : undefined;
    if (!properties) return undefined;
    members.push(properties);
  }
  if (members.length < 2) return undefined;
  const flattened: IrObjectTypeProperty[] = [];
  for (const properties of members) {
    for (const property of properties) {
      const existing = flattened.find((candidate) => candidate.name === property.name);
      // Two alternatives spelling one field differently have no single Haxe type, so the union keeps
      // its untyped form rather than picking one of them.
      if (existing && emitType(existing.type, context) !== emitType(property.type, context)) return undefined;
      if (!existing) {
        flattened.push({
          ...property,
          optional: !members.every((candidate) => candidate.some((entry) => entry.name === property.name)),
        });
      }
    }
  }
  return flattened;
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
        `${getBindingTargetNameHaxe(parameter.binding, context)}${parameter.constraint && parameter.constraint.kind !== 'function' ? `:${emitType(parameter.constraint, context)}` : ''}${parameter.default ? ` = ${emitType(parameter.default, context)}` : ''}`,
    )
    .join(', ')}>`;
}

function emitOptionalCallHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string {
  const callable = getGeneratedTargetNameHaxe('optionalCall', context);
  const args = expression.arguments.map((argument) => emitExpression(argument, context));
  if (expression.callee.kind === 'property') {
    const receiver = getGeneratedTargetNameHaxe('optionalCallReceiver', context);
    return `(function() { final ${receiver}:Dynamic = ${emitExpression(expression.callee.object, context)}; final ${callable}:Dynamic = ${receiver}.${safeHaxeName(expression.callee.name)}; return ${callable} == null ? null : Reflect.callMethod(${receiver}, ${callable}, [${args.join(', ')}]); })()`;
  }
  return `(function() { final ${callable}:Dynamic = ${emitExpression(expression.callee, context)}; return ${callable} == null ? null : Reflect.callMethod(null, ${callable}, [${args.join(', ')}]); })()`;
}

function emitVariable(variable: Readonly<IrVariable>, context: EmitContext): string {
  if ('pattern' in variable)
    emissionError(context, 'binding patterns require destructuring lowering before Haxe emission');
  if (
    variable.initialValue === 'undefined' ||
    (variable.initializer === undefined && variable.type && hasIrTypeAbsentMemberHaxe(variable.type, context.module))
  ) {
    const type = variable.type ? `:${emitType(variable.type, context)}` : ':Dynamic';
    return `var ${getBindingTargetNameHaxe(variable.binding, context)}${type} = js.Syntax.code("undefined");`;
  }
  const type = variable.type ? `:${emitType(variable.type, context)}` : '';
  // A rest taken from a mixed tuple is an `Array<Dynamic>`, because that is the only Haxe type the
  // tuple has. The source knows the rest's own element type, and the cast is how that knowledge
  // crosses: Haxe will not narrow `Array<Dynamic>` on its own.
  const declared = variable.type ? emitType(variable.type, context) : undefined;
  if (declared === 'Array<Dynamic>') context.dynamicBindingIds.add(variable.binding.id);
  const restCast =
    declared !== undefined &&
    declared !== 'Array<Dynamic>' &&
    declared !== 'Dynamic' &&
    variable.initializer !== undefined &&
    isIrExpressionDynamicReadHaxe(variable.initializer, context);
  const initializer = variable.initializer
    ? ` = ${restCast ? (isIrCastTargetUntypedHaxe(variable.type!, context) ? `cast(${emitExpression(variable.initializer, context)})` : `cast(${emitExpression(variable.initializer, context)}, ${emitType(variable.type!, context)})`) : normalizeSourceTextGrouping(emitExpression(variable.initializer, context))}`
    : '';
  return `${variable.mutable ? 'var' : 'final'} ${getBindingTargetNameHaxe(variable.binding, context)}${type}${initializer};`;
}

function emitVariableDeclaration(declaration: Readonly<IrVariableDeclaration>, context: EmitContext): string[] {
  if ('pattern' in declaration)
    emissionError(context, 'binding patterns require destructuring lowering before Haxe emission');
  if (!declaration.initializer)
    emissionError(context, `module variable ${declaration.binding.name} requires an initializer`);
  const storage = declaration.mutable ? 'var' : 'final';
  const type = declaration.type ? `:${emitType(declaration.type, context)}` : '';
  return [
    `${storage} ${getBindingTargetNameHaxe(declaration.binding, context)}${type} = ${emitExpression(declaration.initializer, context)};`,
  ];
}

function getBindingTargetNameHaxe(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  context: EmitContext,
): string {
  const facade = context.facadeBindingTargetNames.get(binding.id);
  if (facade) return facade;
  const remembered = context.machineNames.get(binding.id);
  if (remembered) return remembered;
  const targetName = context.targetNames.get(binding.id);
  // A binding the task machine introduced is not in the module the allocator walked, so it is named
  // on first use and remembered, which keeps every later reference to it spelled the same way.
  if (!targetName) {
    const generated = getGeneratedTargetNameHaxe(binding.name, context);
    context.machineNames.set(binding.id, generated);
    return generated;
  }
  return targetName;
}

function createIrModuleTargetNamesHaxe(module: Readonly<IrModule>): Map<string, string> {
  return new Map(
    createIrModuleTargetNameAllocation(module, (binding) => ({
      namespace: 'identifier',
      preferredName:
        binding.space === 'type' || binding.kind === 'class' || binding.kind === 'enum'
          ? safeHaxeTypeName(binding.name)
          : safeHaxeName(binding.name),
    })).map((allocation) => [allocation.identity, allocation.name]),
  );
}

function createHaxeFacadeTypeTargetNames(
  module: Readonly<IrModule>,
  facade: Readonly<CompilerModuleFacadePlan> | undefined,
  targetNames: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const slots = facade?.modules.find((candidate) => isHaxeCompilerModuleIdentityEqual(candidate.module, module))?.slots;
  if (!slots) return new Map();
  const reexportSlots = slots.filter(
    (slot) => slot.source.kind === 'module-all' || slot.source.kind === 'module-binding',
  );
  const occupied = new Set(targetNames.values());
  for (const slot of reexportSlots) {
    if (slot.lane === 'value') occupied.add(safeHaxeName(slot.exportName));
  }
  const names = new Map<string, string>();
  const moduleName = haxeImplementationModule(module.source);
  for (const exportName of [
    ...new Set(reexportSlots.filter((slot) => slot.lane === 'type').map((slot) => slot.exportName)),
  ].sort(compareTextCodeUnits)) {
    const preferredName = safeHaxeTypeName(`${moduleName}_${exportName}`);
    let targetName = preferredName;
    for (let suffix = 2; occupied.has(targetName); suffix += 1) {
      targetName = `${preferredName}_${String(suffix)}`;
    }
    occupied.add(targetName);
    names.set(exportName, targetName);
  }
  return names;
}

function getSourceBindingTargetNameHaxe(
  module: Readonly<IrModule>,
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  context: EmitContext,
): string {
  let targetNames = context.sourceModuleTargetNames.get(module);
  if (!targetNames) {
    targetNames = createIrModuleTargetNamesHaxe(module);
    context.sourceModuleTargetNames.set(module, targetNames);
  }
  return (
    targetNames.get(binding.id) ??
    (binding.space === 'type' || binding.kind === 'class' || binding.kind === 'enum'
      ? safeHaxeTypeName(binding.name)
      : safeHaxeName(binding.name))
  );
}

function getGeneratedTargetNameHaxe(preferredName: string, context: EmitContext): string {
  let name = preferredName;
  for (let suffix = 2; context.generatedNames.has(name); suffix += 1) name = `${preferredName}_${String(suffix)}`;
  context.generatedNames.add(name);
  return name;
}

function emissionError(context: EmitContext, message: string): never {
  throw createBackendEmissionFailure('haxe', context.module, message);
}

function createCompilerModuleFacadePlannerHaxe(
  modules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
): (entryModule: Readonly<IrModule>) => CompilerModuleFacadePlan | undefined {
  const facadeModules = modules.map((module) => ({
    ...module,
    exports: [...new Map(module.exports.map((exported) => [JSON.stringify(exported), exported])).values()],
  }));
  const dependencies: CompilerModuleLinkDependency[] = [];
  const invalidModuleKeys = new Set<string>();
  const requiredTargetsByModule = new Map<string, Set<string>>();
  for (const module of facadeModules) {
    const exportedImportBindingIds = new Set(
      module.exports.flatMap((exported) =>
        exported.kind === 'local' && exported.binding.kind === 'import' ? [exported.binding.id] : [],
      ),
    );
    const requests: { importedName?: string; namedRoute: boolean; required: boolean; specifier: string }[] = [
      ...module.imports.flatMap((imported) =>
        imported.bindings
          .filter((binding) => exportedImportBindingIds.has(binding.binding.id))
          .map((binding) => ({
            ...(binding.imported === '*' || binding.imported === 'default' ? {} : { importedName: binding.imported }),
            namedRoute: binding.imported !== '*' && binding.imported !== 'default',
            required: true,
            specifier: imported.specifier,
          })),
      ),
      ...module.exports.flatMap((exported) =>
        'specifier' in exported
          ? [
              {
                ...(exported.kind === 'reexport' ? { importedName: exported.imported } : {}),
                namedRoute: false,
                required: true,
                specifier: exported.specifier,
              },
            ]
          : [],
      ),
    ];
    const seen = new Set<string>();
    for (const request of requests) {
      const target = getHaxeResolvedImportModuleFrom(
        module,
        request.specifier,
        facadeModules,
        moduleResolution,
        request.importedName,
      );
      if (!target) {
        if (request.required) invalidModuleKeys.add(getHaxeCompilerModuleKey(module));
        continue;
      }
      if (request.required) {
        const targets = requiredTargetsByModule.get(getHaxeCompilerModuleKey(module));
        if (targets) targets.add(getHaxeCompilerModuleKey(target));
        else requiredTargetsByModule.set(getHaxeCompilerModuleKey(module), new Set([getHaxeCompilerModuleKey(target)]));
      }
      const key = `${request.specifier}\0${request.namedRoute ? (request.importedName ?? '*') : '*'}\0${target.packageName}\0${target.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dependencies.push({
        ...(request.namedRoute && request.importedName ? { importedNames: [request.importedName] } : {}),
        importer: { name: module.name, packageName: module.packageName, source: module.source },
        specifier: request.specifier,
        target: { name: target.name, packageName: target.packageName, source: target.source },
      });
    }
  }
  let invalidCount = -1;
  while (invalidCount !== invalidModuleKeys.size) {
    invalidCount = invalidModuleKeys.size;
    for (const [moduleKey, targetKeys] of requiredTargetsByModule) {
      if ([...targetKeys].some((targetKey) => invalidModuleKeys.has(targetKey))) invalidModuleKeys.add(moduleKey);
    }
  }
  const validDependencies = dependencies.filter(
    (dependency) =>
      !invalidModuleKeys.has(getHaxeCompilerModuleKey(dependency.importer)) &&
      !invalidModuleKeys.has(getHaxeCompilerModuleKey(dependency.target)),
  );
  const dependenciesByImporter = new Map<string, CompilerModuleLinkDependency[]>();
  for (const dependency of validDependencies) {
    const key = getHaxeCompilerModuleKey(dependency.importer);
    const current = dependenciesByImporter.get(key);
    if (current) current.push(dependency);
    else dependenciesByImporter.set(key, [dependency]);
  }
  const plans = new Map<string, CompilerModuleFacadePlan | undefined>();
  return (entryModule) => {
    const entryKey = getHaxeCompilerModuleKey(entryModule);
    if (plans.has(entryKey)) return plans.get(entryKey);
    const facadeModule = facadeModules.find((module) => getHaxeCompilerModuleKey(module) === entryKey);
    const hasFacadeRequest = facadeModule?.exports.some(
      (exported) => 'specifier' in exported || (exported.kind === 'local' && exported.binding.kind === 'import'),
    );
    if (!hasFacadeRequest || invalidModuleKeys.has(entryKey)) {
      plans.set(entryKey, undefined);
      return undefined;
    }
    try {
      const reachableModuleKeys = new Set([entryKey]);
      const pendingModuleKeys = [entryKey];
      for (let index = 0; index < pendingModuleKeys.length; index += 1) {
        for (const dependency of dependenciesByImporter.get(pendingModuleKeys[index]!) ?? []) {
          const targetKey = getHaxeCompilerModuleKey(dependency.target);
          if (!reachableModuleKeys.has(targetKey)) {
            reachableModuleKeys.add(targetKey);
            pendingModuleKeys.push(targetKey);
          }
        }
      }
      const plannedDependencies = validDependencies.filter(
        (dependency) =>
          reachableModuleKeys.has(getHaxeCompilerModuleKey(dependency.importer)) &&
          reachableModuleKeys.has(getHaxeCompilerModuleKey(dependency.target)),
      );
      const linkedRequests = new Map<string, Map<string, { all: boolean; importedNames: Set<string> }>>();
      for (const dependency of plannedDependencies) {
        const key = `${dependency.importer.packageName}\0${dependency.importer.source}`;
        const requests = linkedRequests.get(key) ?? new Map();
        const request = requests.get(dependency.specifier) ?? { all: false, importedNames: new Set<string>() };
        if (dependency.importedNames) dependency.importedNames.forEach((name) => request.importedNames.add(name));
        else request.all = true;
        requests.set(dependency.specifier, request);
        linkedRequests.set(key, requests);
      }
      const plannedModules = facadeModules
        .filter((module) => reachableModuleKeys.has(getHaxeCompilerModuleKey(module)))
        .map((module) => {
          const key = `${module.packageName}\0${module.source}`;
          const requests = linkedRequests.get(key) ?? new Map();
          return {
            ...module,
            imports: module.imports.flatMap((imported) => {
              const request = requests.get(imported.specifier);
              if (!request) return [];
              if (request.all) return [imported];
              const bindings = imported.bindings.filter((binding) => request.importedNames.has(binding.imported));
              return bindings.length > 0 ? [{ ...imported, bindings }] : [];
            }),
          };
        });
      const evaluation = createCompilerModuleEvaluationPlan({
        dependencies: plannedDependencies,
        entries: [{ name: entryModule.name, packageName: entryModule.packageName, source: entryModule.source }],
        modules: plannedModules,
      });
      const plan = createCompilerModuleFacadePlanForEntries({ evaluation, modules: plannedModules }, [entryModule]);
      plans.set(entryKey, plan);
      return plan;
    } catch {
      plans.set(entryKey, undefined);
      return undefined;
    }
  };
}

function getHaxeCompilerModuleKey(module: Readonly<CompilerModuleIdentity>): string {
  return `${module.packageName}\0${module.source}\0${module.name}`;
}

function haxeImportModule(specifier: string, context: EmitContext, importedName?: string): string {
  const resolvedModule = getHaxeResolvedImportModule(specifier, context, importedName);
  if (resolvedModule) return getHaxeModulePath(resolvedModule, context.options);
  if (specifier.startsWith('.')) {
    const unresolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(context.module.source), specifier.replace(/\.[cm]?js$/u, '.ts')),
    );
    const extension = path.posix.extname(unresolved);
    if (extension.length > 0 && extension !== '.ts' && extension !== '.tsx') {
      emissionError(context, `non-TypeScript import ${specifier} requires resource materialization`);
    }
    const target = /\.tsx?$/u.test(unresolved) ? unresolved : `${unresolved}.ts`;
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

function getHaxeModulePath(module: Readonly<IrModule>, options: Readonly<HaxeCompilerBackendOptions>): string {
  return `${convertPackageNameToHaxePackageName(module.packageName, options.rootPackage)}.${haxeImplementationModule(module.source)}`;
}

function getHaxeResolvedImportModule(
  specifier: string,
  context: EmitContext,
  importedName?: string,
): Readonly<IrModule> | undefined {
  return getHaxeResolvedImportModuleFrom(
    context.module,
    specifier,
    context.sourceModules,
    context.moduleResolution,
    importedName,
  );
}

function getHaxeResolvedImportModuleFrom(
  importer: Readonly<IrModule>,
  specifier: string,
  modules: readonly Readonly<IrModule>[],
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined,
  importedName?: string,
): Readonly<IrModule> | undefined {
  const matching = moduleResolution?.edges.filter((edge) => edge.specifier === specifier) ?? [];
  const exact = matching.filter((edge) => edge.importer && isHaxeCompilerModuleIdentityEqual(edge.importer, importer));
  const scoped = exact.length > 0 ? exact : matching.filter((edge) => !edge.importer);
  const targets = scoped.filter(
    (edge) =>
      edge.importedNames === undefined || (importedName !== undefined && edge.importedNames.includes(importedName)),
  );
  if (targets.length === 1) {
    const target = targets[0]!.target;
    return modules.find(
      (module) =>
        module.packageName === target.packageName &&
        path.posix.normalize(module.source) === path.posix.normalize(target.source),
    );
  }
  if (!specifier.startsWith('.')) return undefined;
  const source = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer.source), specifier.replace(/\.[cm]?js$/u, '.ts')),
  );
  const candidates = new Set([source, `${source}.ts`, `${source}/index.ts`]);
  return modules.find(
    (module) => module.packageName === importer.packageName && candidates.has(path.posix.normalize(module.source)),
  );
}

function isHaxeCompilerModuleIdentityEqual(
  left: Readonly<CompilerModuleIdentity>,
  right: Readonly<CompilerModuleIdentity>,
): boolean {
  return (
    left.packageName === right.packageName &&
    path.posix.normalize(left.source) === path.posix.normalize(right.source) &&
    left.name === right.name
  );
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
  // `??` selects between its operands rather than combining them, so no coercion can differ between
  // the two languages. Haxe's own `??` has the same short-circuit and the same null result.
  if (operator === '??') return true;
  // Haxe has one absent value, so `x == null` covers exactly the source's meaning where the operand
  // admits only one of null and undefined. Where it admits both, the two comparisons differ and Haxe
  // cannot tell them apart, so the difference has to be lowered rather than emitted.
  if (semantics.nullishComparison) {
    return !(semantics.nullishComparison.admitsNull && semantics.nullishComparison.admitsUndefined);
  }
  if (operator === '===' || operator === '!==') {
    return (
      semantics.left.flow === semantics.right.flow &&
      semantics.result === 'boolean' &&
      (semantics.left.flow === 'boolean' ||
        semantics.left.flow === 'number' ||
        semantics.left.flow === 'object' ||
        semantics.left.flow === 'string')
    );
  }
  if (operator === '&' || operator === '|' || operator === '^' || operator === '<<' || operator === '>>') {
    return hasMatchingOperatorDomains(semantics, ['number']);
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
  if (operator === '~') return semantics.operand.flow === 'number' && semantics.result === 'number';
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

function assertStructuralObjectCompatibilityHaxe(
  module: Readonly<IrModule>,
  modules: readonly Readonly<IrModule>[],
  resolution: Readonly<CompilerModuleResolutionPlan> | undefined,
  analyzer?: ((module: Readonly<IrModule>) => Readonly<CompilerStructuralObjectCompatibilityReport>) | undefined,
): void {
  const diagnostic = (
    analyzer ? analyzer(module) : analyzeIrModuleStructuralObjectCompatibilityAcrossModules(module, modules, resolution)
  ).diagnostics.find(
    (candidate) =>
      candidate.code !== 'open-construction-target' &&
      candidate.code !== 'computed-property-indeterminate' &&
      candidate.code !== 'spread-membership-indeterminate' &&
      candidate.code !== 'unresolved-named-construction-target',
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
  const stripped = name.startsWith('#') ? name.slice(1) : name;
  const escaped = [...stripped]
    .map((character, index) =>
      (index === 0 ? /[A-Za-z_]/u : /[A-Za-z0-9_]/u).test(character)
        ? character
        : `_u${character.codePointAt(0)!.toString(16).padStart(4, '0')}_`,
    )
    .join('');
  const identifier = escaped || '_';
  return haxeKeywords.has(identifier) ? `${identifier}_` : identifier;
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
  '??': '??',
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
