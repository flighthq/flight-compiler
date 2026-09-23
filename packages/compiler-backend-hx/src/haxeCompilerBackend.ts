import path from 'node:path';

import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import { getIrStatementListCompletionSet } from '../../compiler-completion/src/index.js';
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
import {
  analyzeIrExpressionSubtreeTraversal,
  analyzeIrModuleTraversal,
  analyzeIrStatementSubtreeTraversal,
  getIrModuleTraversalPathValue,
} from '../../compiler-ir-traversal/src/index.js';
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
import { createCompilerHaxeRuntimeAbiManifest } from './haxeRuntimeAbiManifest.js';
import { createCompilerRuntimeExternalConstructorAbiPlanHaxe } from './haxeRuntimeExternalConstructorAbi.js';
import {
  getCompilerAmbientUtilityHeritageTargetHaxe,
  getCompilerRuntimeExternalMemberTargetHaxe,
  createCompilerRuntimeExternalSymbolBindingPlanHaxe,
  getCompilerRuntimeExternalSymbolTargetHaxe,
  isCompilerAmbientUtilityHeritageErasableHaxe,
} from './haxeRuntimeExternalSymbolBinding.js';
import { createCompilerRuntimeTaskCapabilityPlanHaxe } from './haxeRuntimeTaskCapability.js';
import { emitCompilerHaxeTaskLoweringFunction } from './haxeTaskEmission.js';
import { isCompilerHaxeTaskLoweringFailure, lowerCompilerAsyncStateMachinesHaxe } from './haxeTaskLowering.js';
import { emitIrTypeHaxe } from './haxeTypeEmission.js';

interface EmitContext {
  ambientUtilityHeritageTargets: ReadonlyMap<string, string>;
  bindingTypes: ReadonlyMap<string, IrType>;
  breakableDepth: number;
  controlFlowLabels: HaxeControlFlowLabel[];
  facadeBindingTargetNames: Map<string, string>;
  facadeTypeTargetNames: ReadonlyMap<string, string>;
  finallyCompletion: HaxeFinallyCompletion | undefined;
  forwardDeclaredBindingIds: ReadonlySet<string>;
  functionValueNames: ReadonlySet<string>;
  foreignNamedTypeLocalTargetNames: Map<string, string | null>;
  generatedNames: Set<string>;
  haxeReflectName: string;
  getModuleFacade: ((module: Readonly<IrModule>) => CompilerModuleFacadePlan | undefined) | undefined;
  machineNames: Map<string, string>;
  module: Readonly<IrModule>;
  moduleFacadeSlots: readonly Readonly<CompilerModuleFacadeSlot>[];
  moduleResolution: Readonly<CompilerModuleResolutionPlan> | undefined;
  namedDeclarationTargets: Map<string, HaxeNamedDeclarationTarget | null>;
  nullableBindingIds: ReadonlySet<string>;
  objectAccessorClasses: string[][];
  options: Readonly<HaxeCompilerBackendOptions>;
  importedTypeTargetNames: Map<string, string>;
  returnType: Readonly<IrType> | undefined;
  returnsAbsent: boolean;
  dynamicBindingIds: Set<string>;
  dynamicThis: boolean;
  packageName: string;
  sourceModules: readonly Readonly<IrModule>[];
  sourceModuleFacadeTypeTargetNames: Map<string, ReadonlyMap<string, string>>;
  sourceModuleTargetNames: Map<string, ReadonlyMap<string, string>>;
  targetNames: ReadonlyMap<string, string>;
  taskFunctions: WeakMap<object, CompilerHaxeTaskLoweringFunction>;
  taskLowering: Readonly<CompilerHaxeTaskLowering>;
  typeAliasesByName: ReadonlyMap<string, readonly Readonly<IrType>[]>;
}

const haxeFunctionValueNamesBySourceModules = new WeakMap<readonly Readonly<IrModule>[], ReadonlySet<string>>();
const haxeTypeAliasesBySourceModules = new WeakMap<
  readonly Readonly<IrModule>[],
  ReadonlyMap<string, readonly Readonly<IrType>[]>
>();

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

type HaxeNamedDeclarationTarget = Readonly<{
  binding: IrBindingIdentity | IrTypeBindingIdentity;
  declaration: Readonly<IrDeclaration>;
  module: Readonly<IrModule>;
}>;

export function createHaxeCompilerBackend(): CompilerBackend<HaxeCompilerBackendOptions> {
  return {
    createEmissionSession({ moduleResolution, modules, options }) {
      const getModuleFacade = createCompilerModuleFacadePlannerHaxe(modules, moduleResolution);
      const externEmissionIndex = createHaxeExternEmissionIndex(modules, moduleResolution);
      const sourceModuleTargetNames =
        options.emissionMode === 'extern' ? undefined : createHaxeSourceModuleTargetNameIndex(modules);
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
          isCompilerAmbientUtilityHeritageErasableHaxe(reference),
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
                  sourceModuleTargetNames,
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
              undefined,
              undefined,
              createHaxeSourceModuleTargetNameIndex(modules),
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
  sessionSourceModuleTargetNames?: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined,
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
          isCompilerAmbientUtilityHeritageErasableHaxe(reference),
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
      throw createBackendEmissionFailure('haxe', module, error.message, `haxe-task-lowering-${error.code}`, {
        classification: 'target-runtime',
      });
    }
    throw error;
  }
  const packageName = convertPackageNameToHaxePackageName(module.packageName, options.rootPackage);
  let targetNames: Map<string, string>;
  try {
    targetNames = createIrModuleTargetNamesHaxe(module);
    const sessionTargetNames = sessionSourceModuleTargetNames?.get(getHaxeCompilerModuleKey(module));
    if (sessionTargetNames) {
      for (const [bindingId, targetName] of sessionTargetNames) {
        if (targetNames.has(bindingId)) targetNames.set(bindingId, targetName);
      }
    }
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
  const sourceModuleTargetNames = new Map(sessionSourceModuleTargetNames);
  sourceModuleTargetNames.set(getHaxeCompilerModuleKey(module), targetNames);
  const facadeTypeTargetNames = createHaxeFacadeTypeTargetNames(module, moduleFacade, targetNames);
  const bindingTypes = collectIrModuleBindingTypesHaxe(module);
  const generatedNames = new Set([...targetNames.values(), ...facadeTypeTargetNames.values()]);
  let haxeReflectName = 'HaxeReflect';
  for (let suffix = 2; generatedNames.has(haxeReflectName); suffix += 1) {
    haxeReflectName = `HaxeReflect_${String(suffix)}`;
  }
  generatedNames.add(haxeReflectName);
  const context: EmitContext = {
    ambientUtilityHeritageTargets,
    bindingTypes,
    breakableDepth: 0,
    controlFlowLabels: [],
    facadeBindingTargetNames: new Map(),
    facadeTypeTargetNames,
    finallyCompletion: undefined,
    forwardDeclaredBindingIds: new Set(),
    functionValueNames: getHaxeFunctionValueNames(sourceModules),
    foreignNamedTypeLocalTargetNames: new Map(),
    generatedNames,
    haxeReflectName,
    getModuleFacade,
    machineNames: new Map(),
    module,
    moduleFacadeSlots:
      moduleFacade?.modules.find((candidate) => isHaxeCompilerModuleIdentityEqual(candidate.module, module))?.slots ??
      [],
    moduleResolution,
    namedDeclarationTargets: new Map(),
    nullableBindingIds: collectIrModuleNullableBindingIds(module),
    objectAccessorClasses: [],
    options,
    importedTypeTargetNames: new Map(),
    dynamicBindingIds: new Set<string>(),
    dynamicThis: false,
    packageName,
    returnType: undefined,
    returnsAbsent: false,
    sourceModules,
    sourceModuleFacadeTypeTargetNames: new Map([[getHaxeCompilerModuleKey(module), facadeTypeTargetNames]]),
    sourceModuleTargetNames,
    targetNames,
    taskFunctions: new WeakMap(),
    taskLowering,
    typeAliasesByName: getHaxeTypeAliasesByName(sourceModules),
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
      `  ${visibility}${static_}${storage} ${safeHaxeName(field.name)}:${emitStructureFieldTypeHaxe(field.type, context)}${initializer};`,
    );
  });
  if (implicitDerivedBaseParameters) {
    if (declaration.fields.length > 0 || requiresErrorNameStorage) lines.push('');
    const emittedParameters = emitParametersWithInitializersHaxe(implicitDerivedBaseParameters, context);
    lines.push(`  public function new(${emittedParameters.signature}) {`);
    const body: string[] = [...emittedParameters.initializers];
    const args = implicitDerivedBaseParameters
      .map((parameter) => getBindingTargetNameHaxe(parameter.binding, emittedParameters.context))
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
    const emittedParameters = emitParametersWithInitializersHaxe(declaration.classConstructor.parameters, context);
    const constructorContext = emittedParameters.context;
    lines.push(`  public function new(${emittedParameters.signature}) {`);
    const body: string[] = [...emittedParameters.initializers];
    body.push(
      ...emitIrClassFieldInitializationsHaxe(
        declaration,
        initialization,
        'base-constructor-body-entry',
        constructorContext,
      ),
    );
    for (const statement of declaration.classConstructor.body) {
      body.push(...emitStatements([statement], constructorContext));
      if (isIrStatementSuperConstructorCall(statement)) {
        if (requiresErrorNameStorage) body.push('this.name = "Error";');
        body.push(
          ...emitIrClassFieldInitializationsHaxe(
            declaration,
            initialization,
            'derived-super-return',
            constructorContext,
          ),
        );
        body.push(
          ...emitIrClassFieldInitializationsHaxe(
            declaration,
            initialization,
            'derived-super-return-after-fields',
            constructorContext,
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
      `  public var ${safeHaxeName(name)}(${accessor.get ? 'get' : 'never'}, ${accessor.set ? 'set' : 'never'}):${emitStructureFieldTypeHaxe(accessor.type, context)};`,
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
      returnType: method.accessor === 'set' ? undefined : method.returns,
      returnsAbsent: canIrTypeReturnAbsentHaxe(method.returns, context.module),
    };
    const visibility = method.visibility === 'public' ? 'public ' : method.visibility === 'private' ? 'private ' : '';
    const static_ = method.static ? 'static ' : '';
    // A Haxe setter yields the value it was given, so the source's void setter gains the return the
    // property contract requires.
    const setterValue = method.accessor === 'set' ? method.parameters[0] : undefined;
    const name = method.accessor ? `${method.accessor}_${safeHaxeName(method.name)}` : safeHaxeName(method.name);
    const returns = setterValue ? emitType(setterValue.type, methodContext) : emitType(method.returns, methodContext);
    const emittedParameters = method.abstract
      ? {
          context: methodContext,
          initializers: [] as string[],
          signature: emitParameters(method.parameters, methodContext),
        }
      : emitParametersWithInitializersHaxe(method.parameters, methodContext);
    const signature = `  ${method.accessor ? '' : visibility}${method.abstract ? 'abstract ' : ''}${overriddenMethodNames.has(method.name) ? 'override ' : ''}${static_}function ${name}${emitTypeParameters(method.typeParameters, methodContext, false)}(${emittedParameters.signature}):${returns}`;
    // A method with no implementation has no body to emit: the declaration is the whole contract.
    if (method.abstract) {
      lines.push(`${signature};`);
      return;
    }
    lines.push(
      `${signature} {`,
      ...indentSourceLines(
        [
          ...emittedParameters.initializers,
          ...(method.async
            ? emitCompilerHaxeTaskFunctionBody(method, emittedParameters.context)
            : emitFunctionStatementsHaxe(method.body, emittedParameters.context)),
          ...(setterValue
            ? [`return ${getBindingTargetNameHaxe(setterValue.binding, emittedParameters.context)};`]
            : []),
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
    const value = typeof member.value === 'string' ? emitHaxeStringLiteral(member.value) : String(member.value);
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
    returnType: declaration.returns,
    returnsAbsent: canIrTypeReturnAbsentHaxe(declaration.returns, outer.module),
  };
  const emittedParameters = emitParametersWithInitializersHaxe(declaration.parameters, context);
  return [
    `public static function ${getBindingTargetNameHaxe(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context, false)}(${emittedParameters.signature}):${emitType(declaration.returns, context)} {`,
    ...indentSourceLines([
      ...emittedParameters.initializers,
      ...(declaration.async
        ? emitCompilerHaxeTaskFunctionBody(declaration, emittedParameters.context)
        : emitFunctionStatementsHaxe(declaration.body, emittedParameters.context)),
    ]),
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
    emitCondition: (expression) => emitConditionHaxe(expression, context),
    emitExpression: (expression) => emitExpression(expression, context),
    emitStatement: (statement) => emitStatement(statement, context),
    fail: (message) => emissionError(context, message),
    getBindingName: (binding) => getBindingTargetNameHaxe(binding, context),
    getBindingType: (binding) => {
      const type = context.bindingTypes.get(binding.id);
      return type ? emitType(type, context) : undefined;
    },
    getGeneratedName: (preferredName) => getGeneratedTargetNameHaxe(preferredName, context),
  });
}

function emitExpression(expression: Readonly<IrExpression>, context: EmitContext): string {
  switch (expression.kind) {
    case 'array':
      return emitArrayExpressionHaxe(expression, context);
    case 'assignment': {
      const arrayLengthAssignment = emitArrayLengthAssignmentHaxe(expression, context);
      if (arrayLengthAssignment) return arrayLengthAssignment;
      const nativePropertyAssignment = emitHaxeNativeSyntaxPropertyAssignment(expression, context);
      if (nativePropertyAssignment) return nativePropertyAssignment;
      const dynamicPropertyAssignment = emitDynamicAccessPropertyAssignmentHaxe(expression, context);
      if (dynamicPropertyAssignment) return dynamicPropertyAssignment;
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
        (expression.operator === '<' ||
          expression.operator === '<=' ||
          expression.operator === '>' ||
          expression.operator === '>=') &&
        expression.semantics.left.flow === 'number' &&
        expression.semantics.right.flow === 'number' &&
        (getIrExpressionTypeHaxe(expression.left, context)?.kind === 'named' ||
          getIrExpressionTypeHaxe(expression.right, context)?.kind === 'named')
      ) {
        return `((cast ${emitExpression(expression.left, context)}) ${expression.operator} (cast ${emitExpression(expression.right, context)}))`;
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
      if (expression.operator === '??') {
        const branchTypes = new Set([
          ...getIrConditionalBranchTypesHaxe(expression.left, context),
          ...getIrConditionalBranchTypesHaxe(expression.right, context),
        ]);
        if (branchTypes.size > 1) {
          return `((cast ${emitExpression(expression.left, context)} : Dynamic) ?? (cast ${emitExpression(expression.right, context)} : Dynamic))`;
        }
      }
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
      if (isHaxeMapIteratorNextCallHaxe(expression, context)) {
        return `${emitExpression(expression.callee.object, context)}.next()`;
      }
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
        expression.callee.object.reference.name === 'String' &&
        expression.callee.name === 'fromCodePoint'
      ) {
        const arguments_ = expression.arguments.map((argument) => emitExpression(argument, context));
        const source = `String.fromCodePoint(${arguments_.map((_, index) => `{${String(index)}}`).join(', ')})`;
        return `js.Syntax.code(${emitHaxeStringLiteral(source)}${arguments_.length > 0 ? `, ${arguments_.join(', ')}` : ''})`;
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.object.kind === 'identifier' &&
        expression.callee.object.reference.kind === 'ambient' &&
        expression.callee.object.reference.name === 'String' &&
        expression.callee.name === 'fromCharCode'
      ) {
        const arguments_ = expression.arguments.map((argument) => emitExpression(argument, context));
        if (arguments_.length === 1) return `String.fromCharCode(Std.int(${arguments_[0]}))`;
        const source = `String.fromCharCode(${arguments_.map((_, index) => `{${String(index)}}`).join(', ')})`;
        return `js.Syntax.code(${emitHaxeStringLiteral(source)}${arguments_.length > 0 ? `, ${arguments_.join(', ')}` : ''})`;
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.object.kind === 'identifier' &&
        expression.callee.object.reference.kind === 'ambient' &&
        expression.callee.object.reference.name === 'Object' &&
        expression.callee.name === 'assign'
      ) {
        const target = getCompilerRuntimeExternalMemberTargetHaxe('Object', 'assign', context.options.runtimeModule);
        if (!target) emissionError(context, 'Object.assign has no Haxe runtime binding');
        return `${target}(${expression.arguments.map((argument) => `cast(${emitExpression(argument, context)})`).join(', ')})`;
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.name === 'call' &&
        isIrTypeFunctionShapedHaxe(
          getIrExpressionTypeHaxe(expression.callee.object, context) ?? { kind: 'unknown', source: 'unknown' },
          context,
        ) &&
        expression.arguments[0]
      ) {
        const [receiver, ...arguments_] = expression.arguments;
        return `${context.haxeReflectName}.callMethod(${emitExpression(receiver!, context)}, cast(${emitExpression(expression.callee.object, context)}), [${arguments_.map((argument) => emitExpression(argument, context)).join(', ')}])`;
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.object.kind === 'identifier' &&
        expression.callee.object.reference.kind === 'ambient' &&
        expression.callee.object.reference.name === 'Reflect' &&
        expression.callee.name === 'callMethod' &&
        expression.arguments.length === 3
      ) {
        const [receiver, callable, arguments_] = expression.arguments;
        return `${context.haxeReflectName}.callMethod(${emitExpression(receiver!, context)}, cast(${emitExpression(callable!, context)}), ${emitExpression(arguments_!, context)})`;
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.object.kind === 'identifier' &&
        expression.callee.object.reference.kind === 'ambient' &&
        expression.callee.object.reference.name === 'Math' &&
        (expression.callee.name === 'cbrt' || expression.callee.name === 'hypot' || expression.callee.name === 'imul')
      ) {
        const arguments_ = expression.arguments.map((argument) => emitExpression(argument, context));
        const source = `Math.${expression.callee.name}(${arguments_.map((_, index) => `{${String(index)}}`).join(', ')})`;
        return `js.Syntax.code(${emitHaxeStringLiteral(source)}${arguments_.length > 0 ? `, ${arguments_.join(', ')}` : ''})`;
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
        expression.callee.name === 'reverse' &&
        (expression.callee.member?.receiver === 'array' ||
          isIrArrayExpressionHaxe(expression.callee.object, context)) &&
        expression.arguments.length === 0
      ) {
        const target = getGeneratedTargetNameHaxe('reversedArray', context);
        return `(function() { final ${target} = ${emitExpression(expression.callee.object, context)}; ${target}.reverse(); return ${target}; })()`;
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'array' &&
        expression.callee.member.name === 'concat' &&
        expression.arguments.length > 1 &&
        expression.arguments.every((argument) => argument.kind !== 'spread')
      ) {
        const receiver = emitExpression(expression.callee.object, context);
        return expression.arguments.reduce(
          (result, argument) => `${result}.concat(${emitExpression(argument, context)})`,
          receiver,
        );
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'array' &&
        expression.callee.member.name === 'splice' &&
        expression.arguments.length === 1
      ) {
        const receiver = getGeneratedTargetNameHaxe('spliceReceiver', context);
        const position = getGeneratedTargetNameHaxe('splicePosition', context);
        return `(function() { final ${receiver} = ${emitExpression(expression.callee.object, context)}; final ${position} = Std.int(${emitExpression(expression.arguments[0]!, context)}); return ${receiver}.splice(${position}, ${receiver}.length); })()`;
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'array' &&
        expression.callee.member.name === 'splice' &&
        expression.arguments.length > 2 &&
        expression.arguments.every((argument) => argument.kind !== 'spread')
      ) {
        return emitArraySpliceInsertionHaxe(expression, context);
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'array' &&
        expression.callee.member.name === 'push' &&
        expression.arguments.length > 1 &&
        expression.arguments.every((argument) => argument.kind !== 'spread')
      ) {
        const receiver = emitExpression(expression.callee.object, context);
        const receiverType = getIrExpressionTypeHaxe(expression.callee.object, context);
        const values = expression.arguments.map((argument) =>
          emitExpressionAsExpectedTypeHaxe(
            argument,
            receiverType?.kind === 'array' ? receiverType.element : undefined,
            context,
          ),
        );
        const valueArray =
          receiverType?.kind === 'array' && emitType(receiverType.element, context) === 'Float'
            ? `(cast [${values.join(', ')}] : Array<Float>)`
            : `[${values.join(', ')}]`;
        return `${context.options.runtimeModule ?? 'flighthq._internal'}._ArrayTools.pushMany(${receiver}, ${valueArray})`;
      }
      // Member mapping normally emits arguments while selecting the target spelling. A spread has
      // runtime arity, so it must take the reflective-call route before that fixed-arity mapper sees
      // the residual spread expression (notably for Array.push(...values)).
      if (expression.arguments.some((argument) => argument.kind === 'spread')) {
        return emitSpreadCallHaxe(expression, context);
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.member?.receiver === 'abortSignal' &&
        expression.callee.member.name === 'throwIfAborted'
      ) {
        if (expression.arguments.length !== 0) {
          emissionError(context, 'AbortSignal.throwIfAborted takes no arguments');
        }
        return `js.Syntax.code("{0}.throwIfAborted()", ${emitExpression(expression.callee.object, context)})`;
      }
      if (
        expression.callee.kind === 'property' &&
        expression.callee.name === 'arrayBuffer' &&
        expression.arguments.length === 0 &&
        getIrExpressionAmbientTypeNameHaxe(expression.callee.object, context) === 'Blob'
      ) {
        return `js.Syntax.code("{0}.arrayBuffer()", ${emitExpression(expression.callee.object, context)})`;
      }
      if (expression.callee.kind === 'property') {
        const nativeSyntaxCall = emitHaxeNativeSyntaxMethodCall(expression, context);
        if (nativeSyntaxCall) return nativeSyntaxCall;
      }
      if (expression.callee.kind === 'property') {
        const owner = getHaxeNativeOwnerName(expression.callee.object, context);
        const intArguments = owner
          ? haxeNativeMethodIntArgumentPositions.get(`${owner}.${expression.callee.name}`)
          : undefined;
        if (intArguments) {
          const receiver = emitExpression(expression.callee.object, context);
          const arguments_ = expression.arguments.map((argument, index) => {
            const emitted = emitHaxeCallArgument(argument, context);
            return intArguments.includes(index) ? emitHaxeIntegerArgument(argument, emitted, context) : emitted;
          });
          return `${receiver}.${safeHaxeName(expression.callee.name)}(${arguments_.join(', ')})`;
        }
      }
      if (
        expression.callee.kind === 'property' &&
        getWebGlNativeOwnerForExpressionHaxe(expression.callee.object, context)
      ) {
        const intArguments = haxeWebGlIntArgumentPositions.get(expression.callee.name) ?? [];
        const intArrayArguments = haxeWebGlIntArrayArgumentPositions.get(expression.callee.name) ?? [];
        const arguments_ = expression.arguments.map((argument, position) => {
          const emitted = emitHaxeCallArgument(argument, context);
          if (intArrayArguments.includes(position)) return `cast(${emitted})`;
          if (!intArguments.includes(position)) return emitted;
          const type = getIrExpressionTypeHaxe(argument, context);
          const conditionalTypes =
            argument.kind === 'conditional'
              ? [
                  getIrExpressionTypeHaxe(argument.whenTrue, context),
                  getIrExpressionTypeHaxe(argument.whenFalse, context),
                ]
              : [];
          if (
            (type?.kind === 'primitive' && type.name === 'boolean') ||
            (type?.kind === 'literal' && typeof type.value === 'boolean')
          ) {
            return `(${emitConditionHaxe(argument, context)} ? 1 : 0)`;
          }
          if (argument.kind === 'literal' && typeof argument.value === 'number' && Number.isInteger(argument.value)) {
            return emitted;
          }
          if (
            conditionalTypes.length > 0 &&
            conditionalTypes.every(
              (candidate) =>
                candidate !== undefined &&
                !(candidate.kind === 'primitive' && (candidate.name === 'number' || candidate.name === 'boolean')),
            )
          ) {
            return emitted;
          }
          // The native signature itself is authoritative when source evidence is unavailable. A
          // known non-number selects another overload and must remain untouched; an unresolved
          // numeric field still needs the JavaScript-number to Haxe-Int boundary conversion.
          return !type || (type.kind === 'primitive' && type.name === 'number') ? `Std.int(${emitted})` : emitted;
        });
        return `${emitExpression(expression.callee.object, context)}.${safeHaxeName(expression.callee.name)}(${arguments_.join(', ')})`;
      }
      const inferredArrayMember =
        expression.callee.kind === 'property' &&
        isIrArrayExpressionHaxe(expression.callee.object, context) &&
        getCompilerHaxeAmbientMemberBinding({ name: expression.callee.name, receiver: 'array' })
          ? { name: expression.callee.name, receiver: 'array' as const }
          : undefined;
      const ambient =
        expression.callee.kind === 'property'
          ? (expression.callee.member ??
            inferredArrayMember ??
            (isIrExpressionStringBackedHaxe(expression.callee.object, context) &&
            getCompilerHaxeAmbientMemberBinding({ name: expression.callee.name, receiver: 'string' })
              ? { name: expression.callee.name, receiver: 'string' as const }
              : undefined))
          : undefined;
      if (ambient && expression.callee.kind === 'property') {
        const binding = getCompilerHaxeAmbientMemberBinding(ambient);
        if (binding && binding.kind !== 'property') {
          const directReceiver = emitExpression(expression.callee.object, context);
          const receiverType = getIrExpressionTypeHaxe(expression.callee.object, context);
          const receiver =
            ambient.receiver === 'string' &&
            !(
              (receiverType?.kind === 'primitive' && receiverType.name === 'string') ||
              (receiverType?.kind === 'literal' && typeof receiverType.value === 'string')
            )
              ? `(cast ${directReceiver} : String)`
              : directReceiver;
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
            const emitted = emitHaxeCallArgument(argument, context);
            if (
              ambient.receiver === 'map' &&
              position === 0 &&
              receiverType?.kind === 'named' &&
              receiverType.reference.kind === 'ambient' &&
              receiverType.reference.name === 'WeakMap'
            ) {
              return `cast(${emitted})`;
            }
            if (
              ambient.receiver === 'array' &&
              (ambient.name === 'push' || ambient.name === 'unshift') &&
              receiverType?.kind === 'array'
            ) {
              return emitExpressionAsExpectedTypeHaxe(argument, receiverType.element, context, emitted);
            }
            if (
              ambient.receiver === 'array' &&
              ambient.name === 'fill' &&
              position === 0 &&
              receiverType?.kind === 'array' &&
              emitType(receiverType.element, context) === 'Float'
            ) {
              return `(cast ${emitted} : Float)`;
            }
            if (
              ambient.receiver === 'typedArray' &&
              ambient.name === 'fill' &&
              position === 0 &&
              isIrIntegerTypedArrayHaxe(receiverType)
            ) {
              return `cast(${emitted})`;
            }
            if (
              ambient.receiver === 'typedArray' &&
              ambient.name === 'set' &&
              position === 0 &&
              expression.semantics.typedArraySet?.receivers.every((receiver) =>
                haxeIntegerTypedArrayReceivers.has(receiver),
              )
            ) {
              // Haxe integer typed-array adapters expose integer input lanes, while the neutral
              // source collection is Array<Float>. The underlying typed array performs the source
              // language's integer coercion, so erase only this call-site mismatch.
              return `cast(${emitted})`;
            }
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
            const call = `${context.options.runtimeModule ?? 'flighthq._internal'}.${binding.targetName}(${[receiver, ...values].join(', ')})`;
            return ambient.receiver === 'array' &&
              ambient.name === 'flatMap' &&
              expression.semantics.resultType.kind === 'array'
              ? `(cast ${call} : ${emitType(expression.semantics.resultType, context)})`
              : call;
          }
          return `${receiver}.${binding.targetName}(${values.join(', ')})`;
        }
      }
      if (expression.semantics.statementValue) return emitStatementValueExpressionHaxe(expression, context);
      if (
        expression.callee.kind === 'property' &&
        expression.callee.object.kind === 'identifier' &&
        expression.callee.object.reference.kind === 'ambient' &&
        expression.callee.object.reference.name === 'Promise' &&
        expression.callee.name === 'resolve' &&
        expression.arguments.length === 0
      ) {
        return `${emitExpression(expression.callee, context)}(js.Syntax.code("undefined"))`;
      }
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
      if (
        expression.callee.kind === 'identifier' &&
        expression.callee.reference.kind === 'ambient' &&
        expression.callee.reference.name === 'Object' &&
        expression.arguments.length === 1
      ) {
        return `js.Syntax.code("Object({0})", ${emitExpression(expression.arguments[0]!, context)})`;
      }
      if (expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'ambient') {
        const intArguments = haxeGlobalFunctionIntArgumentPositions.get(expression.callee.reference.name);
        if (intArguments) {
          const values = expression.arguments.map((argument, index) => {
            const emitted = emitHaxeCallArgument(argument, context);
            return intArguments.includes(index) ? emitHaxeIntegerArgument(argument, emitted, context) : emitted;
          });
          return `${emitExpression(expression.callee, context)}(${values.join(', ')})`;
        }
      }
      if (expression.callee.kind === 'identifier') {
        const calleeType = getIrExpressionTypeHaxe(expression.callee, context);
        if (calleeType && hasIrTypeAbsentMember(calleeType) && isIrTypeFunctionShapedHaxe(calleeType, context)) {
          const concrete = getIrSingleConcreteTypeHaxe(calleeType);
          return `(cast ${emitExpression(expression.callee, context)} : ${emitType(concrete, context)})(${emitCallArgumentsHaxe(expression, context)})`;
        }
      }
      return `${expression.callee.kind === 'function' ? `(${emitExpression(expression.callee, context)})` : emitExpression(expression.callee, context)}${expression.optional ? '?.' : ''}(${emitCallArgumentsHaxe(expression, context)})`;
    }
    case 'cast':
      return emitCastExpressionHaxe(expression, context);
    case 'conditional':
      return emitConditionalExpressionHaxe(expression, context);
    case 'element':
      if (
        expression.semantics.receivers.includes('object') ||
        (expression.semantics.key === 'string' &&
          expression.semantics.receivers.every((receiver) => receiver === 'unknown'))
      ) {
        const object = emitExpression(expression.object, context);
        const index = emitExpression(expression.index, context);
        const runtime = `${context.options.runtimeModule ?? 'flighthq._internal'}._Js`;
        if (expression.optional) {
          const receiver = getGeneratedTargetNameHaxe('optionalObject', context);
          return `(function() { final ${receiver}:Dynamic = ${object}; return ${receiver} == null ? null : ${runtime}.getProperty(${receiver}, ${index}); })()`;
        }
        return expression.semantics.receivers.length === 1 && expression.semantics.key === 'string'
          ? `${context.haxeReflectName}.field(${object}, ${index})`
          : `${runtime}.getProperty(${object}, ${index})`;
      }
      if (expression.semantics.receivers.includes('tuple')) {
        return `${emitExpression(expression.object, context)}[${emitArrayIndexHaxe(expression.index, context)}]`;
      }
      if (expression.semantics.receivers.includes('string')) {
        const object = emitExpression(expression.object, context);
        const index = emitExpression(expression.index, context);
        const runtime = `${context.options.runtimeModule ?? 'flighthq._internal'}._Js`;
        if (expression.optional) {
          const receiver = getGeneratedTargetNameHaxe('optionalIndexedValue', context);
          return `(function() { final ${receiver}:Dynamic = ${object}; return ${receiver} == null ? null : ${runtime}.getProperty(${receiver}, ${index}); })()`;
        }
        return `${runtime}.getProperty(${object}, ${index})`;
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
      const expressionReturns: Readonly<IrType> =
        expression.returns.kind === 'unknown' && !hasIrFunctionValueReturnHaxe(expression.body)
          ? { kind: 'primitive', name: 'void' }
          : expression.returns;
      const functionContext: EmitContext = {
        ...context,
        dynamicThis: expression.thisMode === 'dynamic' || (expression.thisMode === 'lexical' && context.dynamicThis),
        finallyCompletion: undefined,
        returnType: expressionReturns,
        returnsAbsent: canIrTypeReturnAbsentHaxe(expressionReturns, context.module),
      };
      const emittedParameters = emitParametersWithInitializersHaxe(expression.parameters, functionContext);
      const emittedReturn = emitType(expressionReturns, emittedParameters.context);
      const returnAnnotation =
        expression.expression || emittedReturn === 'Dynamic' || emittedReturn === 'Void' ? '' : `:${emittedReturn}`;
      if (expression.async) {
        return `function(${emittedParameters.signature})${returnAnnotation} {\n${indentSourceLines([
          ...emittedParameters.initializers,
          ...emitCompilerHaxeTaskFunctionBody(expression, emittedParameters.context),
        ]).join('\n')}\n}`;
      }
      if (expression.expression && emittedParameters.initializers.length === 0) {
        return `function(${emittedParameters.signature}) return ${emitExpression(expression.expression, emittedParameters.context)}`;
      }
      const body = expression.expression
        ? [
            ...emittedParameters.initializers,
            `return ${emitExpression(expression.expression, emittedParameters.context)};`,
          ]
        : [
            ...emittedParameters.initializers,
            ...emitFunctionStatementsHaxe(expression.body, emittedParameters.context),
          ];
      return `function(${emittedParameters.signature})${returnAnnotation} {\n${indentSourceLines(body).join('\n')}\n}`;
    case 'identifier':
      return emitIdentifierReferenceHaxe(expression.reference, context);
    case 'literal':
      return emitLiteral(expression.value);
    case 'new':
      if (
        expression.semantics.construction === 'factory' ||
        (expression.callee.kind === 'identifier' &&
          expression.callee.reference.kind === 'binding' &&
          (expression.callee.reference.binding.kind === 'parameter' ||
            expression.callee.reference.binding.kind === 'variable'))
      ) {
        return `Type.createInstance(cast ${emitExpression(expression.callee, context)}, [${expression.arguments
          .map((argument) => emitExpression(argument, context))
          .join(', ')}])`;
      }
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
          return `js.Syntax.code(${emitHaxeStringLiteral(construction)}${arguments_.length > 0 ? `, ${arguments_.join(', ')}` : ''})`;
        }
      }
      return `new ${emitExpression(expression.callee, context)}(${emitNewArgumentsHaxe(expression, context).join(', ')})`;
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
            `${context.haxeReflectName}.deleteField(${name}, ${key.kind === 'named' ? emitHaxeStringLiteral(key.name) : emitExpression(key.expression, context)});`,
        )
        .join(' ');
      return `(function() { final ${name} = ${context.haxeReflectName}.copy(${emitExpression(expression.object, context)}); ${exclusions} return ${name}; })()`;
    }
    case 'property': {
      if (expression.name === 'value' && isHaxeMapIteratorResultValueHaxe(expression, context)) {
        return emitExpression(expression.object, context);
      }
      const webGlConstantOwner = getWebGlStaticConstantOwnerHaxe(expression, context);
      if (webGlConstantOwner) return `${webGlConstantOwner}.${safeHaxeName(expression.name)}`;
      const nativeSyntaxProperty = emitHaxeNativeSyntaxProperty(expression, context);
      if (nativeSyntaxProperty) return nativeSyntaxProperty;
      if (
        expression.name === 'colorSpace' &&
        getIrExpressionAmbientTypeNameHaxe(expression.object, context) === 'ImageData'
      ) {
        return `js.Syntax.code("{0}.colorSpace", ${emitExpression(expression.object, context)})`;
      }
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
      if (isReflectiveHaxePropertyReceiver(expression.object, context)) {
        const object = emitExpression(expression.object, context);
        const name = emitHaxeStringLiteral(expression.name);
        if (expression.optional) {
          const receiver = getGeneratedTargetNameHaxe('optionalObject', context);
          return `(function() { final ${receiver}:Dynamic = ${object}; return ${receiver} == null ? null : ${context.haxeReflectName}.field(${receiver}, ${name}); })()`;
        }
        return `${context.haxeReflectName}.field(${object}, ${name})`;
      }
      if (expression.structuralAccess === 'narrowed') {
        const object = emitExpression(expression.object, context);
        const name = emitHaxeStringLiteral(expression.name);
        if (expression.optional) {
          const receiver = getGeneratedTargetNameHaxe('optionalObject', context);
          return `(function() { final ${receiver}:Dynamic = ${object}; return ${receiver} == null ? null : ${context.haxeReflectName}.field(${receiver}, ${name}); })()`;
        }
        return `${context.haxeReflectName}.field(${object}, ${name})`;
      }
      const narrowedType =
        expression.object.kind === 'identifier' && expression.object.narrowedMember
          ? getIrNarrowedMemberTypeHaxe(
              getIrExpressionTypeHaxe(expression.object, context),
              expression.object.narrowedMember,
              context,
            )
          : undefined;
      const narrowed =
        expression.object.kind === 'identifier' && expression.object.narrowedMember
          ? narrowedType
            ? emitType(narrowedType, context)
            : (getIrModuleDeclaredTypeNameHaxe(expression.object.narrowedMember, context) ??
              getIrImportedTypeNameByNameHaxe(expression.object.narrowedMember, context) ??
              getHaxePrimitiveNarrowedTypeName(expression.object.narrowedMember))
          : undefined;
      const object = narrowed
        ? `(cast ${emitExpression(expression.object, context)} : ${narrowed})`
        : emitExpression(expression.object, context);
      return `${object}${expression.optional ? '?.' : '.'}${safeHaxeName(expression.name)}`;
    }
    case 'regexp':
      return `new ${context.options.runtimeModule ?? 'flighthq._internal'}._RegExp(${emitHaxeStringLiteral(expression.pattern)}, ${emitHaxeStringLiteral(expression.flags)})`;
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
    case 'tuple': {
      // TypeScript's sole numeric domain maps to Float. As with ordinary array literals, Haxe
      // otherwise infers an all-integral tuple branch such as `[1, 0]` as Array<Int> before a
      // surrounding conditional can constrain it to the source `[number, number]` type.
      const numericElements = expression.elements.flatMap((element) => {
        if (!element.expression) return [];
        const type = getIrExpressionTypeHaxe(element.expression, context);
        return type?.kind === 'primitive' && type.name === 'number' ? [element.expression] : [];
      });
      const floatWitness =
        numericElements.length > 0 &&
        numericElements.length === expression.elements.filter((element) => element.expression !== undefined).length
          ? numericElements[0]
          : undefined;
      const elements = expression.elements.map((element) => {
        if (!element.expression) return 'null';
        const emitted = emitExpression(element.expression, context);
        return element.expression === floatWitness ? `(cast ${emitted} : Float)` : emitted;
      });
      const elementTypes = new Set(
        expression.elements.flatMap((element) => {
          if (!element.expression) return [];
          const type = getIrExpressionTypeHaxe(element.expression, context);
          return type ? [emitType(getIrSingleConcreteTypeHaxe(type), context)] : [];
        }),
      );
      const literal = `[${elements.join(', ')}]`;
      return elementTypes.size > 1 ? `(${literal} : Array<Dynamic>)` : literal;
    }
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

function getWebGlStaticConstantOwnerHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): string | undefined {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(expression.name) || expression.optional) return undefined;
  return getWebGlNativeOwnerForExpressionHaxe(expression.object, context);
}

function getIrExpressionAmbientTypeNameHaxe(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): string | undefined {
  let type = getIrExpressionTypeHaxe(expression, context);
  if (type) type = getIrSingleConcreteTypeHaxe(type);
  while (
    type?.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    ['Partial', 'Readonly', 'Required'].includes(type.reference.name) &&
    type.typeArguments[0]
  ) {
    type = getIrSingleConcreteTypeHaxe(type.typeArguments[0]);
  }
  return type?.kind === 'named' && type.reference.kind === 'ambient' ? type.reference.name : undefined;
}

function getHaxeNativeSyntaxMemberKey(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): string | undefined {
  const owner = getHaxeNativeOwnerName(expression.object, context);
  return owner ? `${owner}.${expression.name}` : undefined;
}

function getHaxeNativeOwnerName(expression: Readonly<IrExpression>, context: EmitContext): string | undefined {
  if (expression.kind === 'identifier' && expression.reference.kind === 'ambient') {
    return haxeNativeValueOwnerNames.get(expression.reference.name) ?? expression.reference.name;
  }
  const ambient = getIrExpressionAmbientTypeNameHaxe(expression, context);
  if (ambient) return ambient;
  const type = getIrExpressionTypeHaxe(expression, context);
  return type ? haxeNativeTargetOwnerNames.get(emitType(getIrSingleConcreteTypeHaxe(type), context)) : undefined;
}

function emitHaxeNativeSyntaxMethodCall(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string | undefined {
  if (expression.callee.kind !== 'property') return undefined;
  const key = getHaxeNativeSyntaxMemberKey(expression.callee, context);
  const canvasCreatedByDocument =
    expression.callee.name === 'getContext' &&
    expression.callee.object.kind === 'call' &&
    expression.callee.object.callee.kind === 'property' &&
    expression.callee.object.callee.name === 'createElement' &&
    expression.callee.object.arguments[0]?.kind === 'literal' &&
    expression.callee.object.arguments[0].value === 'canvas';
  if ((!key || !haxeNativeSyntaxMethods.has(key)) && !canvasCreatedByDocument) return undefined;
  const receiver = emitExpression(expression.callee.object, context);
  const arguments_ = expression.arguments.map((argument) => emitHaxeCallArgument(argument, context));
  const invocation = `{0}.${expression.callee.name}(${arguments_
    .map((_, index) => `{${String(index + 1)}}`)
    .join(', ')})`;
  return `js.Syntax.code(${emitHaxeStringLiteral(invocation)}, ${[receiver, ...arguments_].join(', ')})`;
}

function emitHaxeNativeSyntaxProperty(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): string | undefined {
  const key = getHaxeNativeSyntaxMemberKey(expression, context);
  if (!key) return undefined;
  const constant = haxeNativeSyntaxConstantExpressions.get(key);
  if (constant) return constant;
  if (!haxeNativeSyntaxProperties.has(key)) return undefined;
  return `js.Syntax.code("{0}.${expression.name}", ${emitExpression(expression.object, context)})`;
}

function emitHaxeNativeSyntaxPropertyAssignment(
  expression: Readonly<Extract<IrExpression, { kind: 'assignment' }>>,
  context: EmitContext,
): string | undefined {
  if (expression.operator !== '=' || expression.left.kind !== 'property') return undefined;
  const key = getHaxeNativeSyntaxMemberKey(expression.left, context);
  if (!key || !haxeNativeSyntaxWritableProperties.has(key)) return undefined;
  const assignment = `{0}.${expression.left.name} = {1}`;
  return `js.Syntax.code(${emitHaxeStringLiteral(assignment)}, ${emitExpression(expression.left.object, context)}, ${emitExpression(expression.right, context)})`;
}

function getWebGlNativeOwnerForExpressionHaxe(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): string | undefined {
  let type = getIrExpressionTypeHaxe(expression, context);
  if (type?.kind === 'union') {
    const inhabited = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
    if (inhabited.length === 1) type = inhabited[0];
  }
  while (
    type?.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    ['Partial', 'Readonly', 'Required'].includes(type.reference.name) &&
    type.typeArguments[0]
  ) {
    type = type.typeArguments[0];
  }
  if (!type || type.kind !== 'named') return undefined;
  const reference = type.reference;
  if (reference.kind === 'ambient') {
    const owner = getCompilerRuntimeExternalSymbolTargetHaxe(reference.name, 'type', context.options.runtimeModule);
    return owner?.startsWith('js.html.webgl.') ? owner : undefined;
  }
  const target = getIrNamedDeclarationTargetHaxe(type, context);
  if (!target || target.declaration.kind !== 'interface') return undefined;
  const owner = getCompilerAmbientUtilityHeritageTargetHaxe(target.declaration, target.module);
  return owner?.startsWith('js.html.webgl.') ? owner : undefined;
}

// Haxe's WebGL extern follows the platform's integer ABI, while the portable source surface uses
// its single `number` type. Only the integer positions are narrowed; uniforms and other genuine
// floating-point lanes remain Float. Overloaded methods list every position that is integer in any
// numeric overload, and type evidence keeps buffer/source arguments out of the conversion.
const haxeWebGlIntArgumentPositions = new Map<string, readonly number[]>([
  ['activeTexture', [0]],
  ['bindAttribLocation', [1]],
  ['bindBuffer', [0]],
  ['bindFramebuffer', [0]],
  ['bindRenderbuffer', [0]],
  ['bindTexture', [0]],
  ['blendEquation', [0]],
  ['blendEquationSeparate', [0, 1]],
  ['blendFunc', [0, 1]],
  ['blendFuncSeparate', [0, 1, 2, 3]],
  ['blitFramebuffer', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ['bufferData', [0, 1, 2, 3, 4]],
  ['bufferSubData', [0, 1, 3, 4]],
  ['checkFramebufferStatus', [0]],
  ['clear', [0]],
  ['clearBufferfi', [0, 1, 3]],
  ['clearBufferfv', [0, 1, 3]],
  ['compressedTexImage2D', [0, 1, 2, 3, 4, 5, 7, 8]],
  ['compressedTexSubImage3D', [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11]],
  ['createShader', [0]],
  ['cullFace', [0]],
  ['depthFunc', [0]],
  ['disable', [0]],
  ['disableVertexAttribArray', [0]],
  ['drawArrays', [0, 1, 2]],
  ['drawArraysInstanced', [0, 1, 2, 3]],
  ['drawElements', [0, 1, 2, 3]],
  ['drawElementsInstanced', [0, 1, 2, 3, 4]],
  ['enable', [0]],
  ['enableVertexAttribArray', [0]],
  ['framebufferRenderbuffer', [0, 1, 2]],
  ['framebufferTexture2D', [0, 1, 2, 4]],
  ['frontFace', [0]],
  ['generateMipmap', [0]],
  ['getActiveUniform', [1]],
  ['getParameter', [0]],
  ['getProgramParameter', [1]],
  ['getShaderParameter', [1]],
  ['isEnabled', [0]],
  ['pixelStorei', [0, 1]],
  ['readBuffer', [0]],
  ['readPixels', [0, 1, 2, 3, 4, 5, 7]],
  ['renderbufferStorage', [0, 1, 2, 3]],
  ['renderbufferStorageMultisample', [0, 1, 2, 3, 4]],
  ['scissor', [0, 1, 2, 3]],
  ['stencilFunc', [0, 1, 2]],
  ['stencilFuncSeparate', [0, 1, 2, 3]],
  ['stencilMask', [0]],
  ['stencilMaskSeparate', [0, 1]],
  ['stencilOp', [0, 1, 2]],
  ['stencilOpSeparate', [0, 1, 2, 3]],
  ['texImage2D', [0, 1, 2, 3, 4, 5, 6, 7, 9]],
  ['texImage3D', [0, 1, 2, 3, 4, 5, 6, 7, 8, 10]],
  ['texParameterf', [0, 1]],
  ['texParameteri', [0, 1, 2]],
  ['texStorage3D', [0, 1, 2, 3, 4, 5]],
  ['texSubImage2D', [0, 1, 2, 3, 4, 5, 6, 7, 9]],
  ['uniform1i', [1]],
  ['vertexAttrib4f', [0]],
  ['vertexAttribDivisor', [0, 1]],
  ['vertexAttribPointer', [0, 1, 2, 4, 5]],
  ['viewport', [0, 1, 2, 3]],
]);

const haxeWebGlIntArrayArgumentPositions = new Map<string, readonly number[]>([['drawBuffers', [0]]]);

function emitJavaScriptUpdateOperatorHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'unary' }>>,
  context: EmitContext,
): string | undefined {
  const reflectiveProperty =
    expression.operand.kind === 'property' &&
    (expression.operand.structuralAccess === 'narrowed' ||
      isReflectiveHaxePropertyReceiver(expression.operand.object, context));
  if (
    (expression.operator !== '++' && expression.operator !== '--') ||
    (expression.semantics.operand.flow === 'number' && expression.semantics.result === 'number' && !reflectiveProperty)
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
    if (reflectiveProperty) {
      const name = emitHaxeStringLiteral(expression.operand.name);
      return body(
        `final ${receiver}:Dynamic = ${emitExpression(expression.operand.object, context)};`,
        `${context.haxeReflectName}.field(${receiver}, ${name})`,
        (value) => `${context.haxeReflectName}.setField(${receiver}, ${name}, ${value})`,
      );
    }
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
      expression.operand.semantics.receivers.includes('object') ||
      expression.operand.semantics.receivers.includes('unknown')
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
  if (expression.elements.length === 0 && expression.type) {
    return `(cast [] : ${emitType(expression.type, context)})`;
  }
  if (!expression.elements.some((element) => element?.kind === 'spread')) {
    // Source `number` is represented by Float. A literal containing only integral spellings would
    // otherwise be inferred by Haxe as Array<Int> before its surrounding Array<Float> annotation
    // can constrain it (notably `[0, 1, 2].filter(...)`). Give the first numeric element a Float
    // witness while leaving heterogeneous/Dynamic arrays alone.
    const numericElements = expression.elements.filter((element): element is IrExpression => {
      if (!element) return false;
      const type = getIrExpressionTypeHaxe(element, context);
      return type?.kind === 'primitive' && type.name === 'number';
    });
    const floatWitness =
      numericElements.length > 0 && numericElements.length === expression.elements.filter(Boolean).length
        ? numericElements[0]
        : undefined;
    const literal = `[${expression.elements
      .map((element) => {
        if (!element) return 'null';
        const emitted = emitExpression(element, context);
        if (element === floatWitness) return `(cast ${emitted} : Float)`;
        const expectedElement = expression.type?.kind === 'array' ? expression.type.element : undefined;
        return emitExpressionAsExpectedTypeHaxe(element, expectedElement, context, emitted);
      })
      .join(', ')}]`;
    const elementTypes = new Set(
      expression.elements.flatMap((element) => {
        if (!element) return [];
        const type = getIrExpressionTypeHaxe(element, context);
        return type && !(type.kind === 'primitive' && type.name === 'void')
          ? [emitType(getIrSingleConcreteTypeHaxe(type), context)]
          : [];
      }),
    );
    if (expression.type) return `(${literal} : ${emitType(expression.type, context)})`;
    const dynamicallyTypedArray = expression.type && emitType(expression.type, context) === 'Array<Dynamic>';
    return elementTypes.size > 1 || dynamicallyTypedArray ? `(${literal} : Array<Dynamic>)` : literal;
  }
  const groups: Array<{ copy: boolean; kind: 'fixed' | 'spread'; value: string }> = [];
  let fixed: string[] = [];
  for (const element of expression.elements) {
    if (element?.kind === 'spread') {
      if (fixed.length > 0) groups.push({ copy: false, kind: 'fixed', value: `[${fixed.join(', ')}]` });
      fixed = [];
      const spreadType = getIrExpressionTypeHaxe(element.expression, context);
      const arraySpread = spreadType?.kind === 'array' || spreadType?.kind === 'tuple';
      const value = emitExpression(element.expression, context);
      groups.push({
        copy: arraySpread,
        kind: 'spread',
        value: arraySpread ? value : `${context.options.runtimeModule ?? 'flighthq._internal'}._Array.from(${value})`,
      });
      continue;
    }
    if (!element) {
      fixed.push('null');
      continue;
    }
    const emitted = emitExpression(element, context);
    const elementType = getIrExpressionTypeHaxe(element, context);
    fixed.push(
      elementType?.kind === 'primitive' && elementType.name === 'number' ? `(cast ${emitted} : Float)` : emitted,
    );
  }
  if (fixed.length > 0) groups.push({ copy: false, kind: 'fixed', value: `[${fixed.join(', ')}]` });
  const [first, ...rest] = groups;
  if (!first) return '[]';
  const initial = first.kind === 'spread' && first.copy ? `${first.value}.copy()` : first.value;
  const result = `${initial}${rest.map((group) => `.concat(${group.value})`).join('')}`;
  return expression.type ? `(cast ${result} : ${emitType(expression.type, context)})` : result;
}

function hasIrFunctionValueReturnHaxe(statements: readonly Readonly<IrStatement>[]): boolean {
  return statements.some(hasIrStatementValueReturnHaxe);
}

function hasIrStatementValueReturnHaxe(statement: Readonly<IrStatement>): boolean {
  switch (statement.kind) {
    case 'return':
      return statement.expression !== undefined;
    case 'block':
      return hasIrFunctionValueReturnHaxe(statement.statements);
    case 'do':
    case 'for':
    case 'forIn':
    case 'forOf':
    case 'while':
      return hasIrStatementValueReturnHaxe(statement.body);
    case 'if':
      return (
        hasIrStatementValueReturnHaxe(statement.consequent) ||
        (statement.otherwise !== undefined && hasIrStatementValueReturnHaxe(statement.otherwise))
      );
    case 'switch':
      return statement.cases.some((case_) => hasIrFunctionValueReturnHaxe(case_.statements));
    case 'try':
      return (
        hasIrStatementValueReturnHaxe(statement.tryBody) ||
        (statement.catchClause !== undefined && hasIrStatementValueReturnHaxe(statement.catchClause.body)) ||
        (statement.finallyBody !== undefined && hasIrStatementValueReturnHaxe(statement.finallyBody))
      );
    case 'break':
    case 'continue':
    case 'expression':
    case 'throw':
    case 'variable':
      return false;
  }
}

function emitArrayLengthAssignmentHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'assignment' }>>,
  context: EmitContext,
): string | undefined {
  const left = expression.left;
  if (
    left.kind !== 'property' ||
    left.name !== 'length' ||
    (left.member?.receiver !== 'array' && left.member?.receiver !== 'tuple') ||
    (expression.operator !== '=' && expression.operator !== '+=' && expression.operator !== '-=')
  ) {
    return undefined;
  }
  const receiver = getGeneratedTargetNameHaxe('arrayLengthReceiver', context);
  const value = getGeneratedTargetNameHaxe('arrayLengthValue', context);
  const right = emitExpression(expression.right, context);
  const updated =
    expression.operator === '=' ? right : `${receiver}.length ${expression.operator === '+=' ? '+' : '-'} ${right}`;
  return `(function() { final ${receiver} = ${emitExpression(left.object, context)}; final ${value}:Float = ${updated}; ${receiver}.resize(Std.int(${value})); return ${value}; })()`;
}

function emitDynamicAccessPropertyAssignmentHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'assignment' }>>,
  context: EmitContext,
): string | undefined {
  const left = expression.left;
  if (
    left.kind !== 'property' ||
    left.member !== undefined ||
    (left.structuralAccess !== 'narrowed' && !isReflectiveHaxePropertyReceiver(left.object, context))
  ) {
    return undefined;
  }
  const receiver = getGeneratedTargetNameHaxe('dynamicAccessReceiver', context);
  const value = getGeneratedTargetNameHaxe('dynamicAccessValue', context);
  const right = emitExpression(expression.right, context);
  const current = `${context.haxeReflectName}.field(${receiver}, ${emitHaxeStringLiteral(left.name)})`;
  const updated =
    expression.operator === '='
      ? right
      : expression.semantics.left.flow === 'number' && expression.semantics.right.flow === 'number'
        ? (
            {
              '+=': `${current} + ${right}`,
              '-=': `${current} - ${right}`,
              '*=': `${current} * ${right}`,
              '/=': `${current} / ${right}`,
              '%=': `${current} % ${right}`,
              '**=': `Math.pow(${current}, ${right})`,
            } as Partial<Record<IrAssignmentOperator, string>>
          )[expression.operator]
        : undefined;
  if (!updated) return undefined;
  return `(function() { final ${receiver} = ${emitExpression(left.object, context)}; final ${value}:Dynamic = ${updated}; ${context.haxeReflectName}.setField(${receiver}, ${emitHaxeStringLiteral(left.name)}, ${value}); return ${value}; })()`;
}

function isReflectiveHaxePropertyReceiver(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  const type = getIrExpressionTypeHaxe(expression, context);
  if (!type) return false;
  return isIrTypeReflectiveHaxe(type, context) || hasIrTypeParameterReferenceHaxe(type);
}

function isIrTypeReflectiveHaxe(
  type: Readonly<IrType>,
  context: EmitContext,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const concrete = getIrSingleConcreteTypeHaxe(type);
  const targetType = emitType(concrete, context);
  if (targetType.startsWith('haxe.DynamicAccess<') || concrete.kind === 'unknown') return true;
  if (concrete.kind === 'named' && concrete.reference.kind === 'ambient' && targetType === 'Dynamic') return true;
  if (concrete.kind !== 'named' || concrete.reference.kind !== 'binding') return false;
  const target = getIrNamedDeclarationTargetHaxe(concrete, context);
  if (!target || target.declaration.kind !== 'typeAlias' || seen.has(target.binding.id)) return false;
  const substituted = resolveIrTypeStructuralSubstitution(
    target.declaration.type,
    createIrTypeParameterSubstitutionPlan(target.declaration.typeParameters, concrete.typeArguments),
  );
  return isIrTypeReflectiveHaxe(substituted, context, new Set(seen).add(target.binding.id));
}

function hasIrTypeParameterReferenceHaxe(type: Readonly<IrType>): boolean {
  switch (type.kind) {
    case 'array':
      return hasIrTypeParameterReferenceHaxe(type.element);
    case 'conditionalFacet':
      return hasIrTypeParameterReferenceHaxe(type.check) || hasIrTypeParameterReferenceHaxe(type.facet);
    case 'function':
      return (
        type.parameters.some((parameter) => hasIrTypeParameterReferenceHaxe(parameter.type)) ||
        hasIrTypeParameterReferenceHaxe(type.returns) ||
        type.typeParameters.some(
          (parameter) =>
            (parameter.constraint !== undefined && hasIrTypeParameterReferenceHaxe(parameter.constraint)) ||
            (parameter.default !== undefined && hasIrTypeParameterReferenceHaxe(parameter.default)),
        )
      );
    case 'indexedAccess':
      return hasIrTypeParameterReferenceHaxe(type.object) || hasIrTypeParameterReferenceHaxe(type.index);
    case 'intersection':
    case 'union':
      return type.types.some(hasIrTypeParameterReferenceHaxe);
    case 'keyof':
      return hasIrTypeParameterReferenceHaxe(type.type);
    case 'named':
      return (
        (type.reference.kind === 'binding' && type.reference.binding.kind === 'typeParameter') ||
        type.typeArguments.some(hasIrTypeParameterReferenceHaxe)
      );
    case 'object':
      return type.properties.some((property) => hasIrTypeParameterReferenceHaxe(property.type));
    case 'tuple':
      return type.elements.some((element) => hasIrTypeParameterReferenceHaxe(element.type));
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
    case 'typeOf':
    case 'undefined':
    case 'unknown':
      return false;
  }
}

function hasIrDependentCallablePackHaxe(type: Readonly<IrType>): boolean {
  switch (type.kind) {
    case 'array':
      return hasIrDependentCallablePackHaxe(type.element);
    case 'conditionalFacet':
      return hasIrDependentCallablePackHaxe(type.check) || hasIrDependentCallablePackHaxe(type.facet);
    case 'function':
      return (
        type.parameters.some(
          (parameter) =>
            (parameter.rest && hasIrTypeParameterReferenceHaxe(parameter.type)) ||
            hasIrDependentCallablePackHaxe(parameter.type),
        ) || hasIrDependentCallablePackHaxe(type.returns)
      );
    case 'indexedAccess':
      return hasIrDependentCallablePackHaxe(type.object) || hasIrDependentCallablePackHaxe(type.index);
    case 'intersection':
    case 'union':
      return type.types.some(hasIrDependentCallablePackHaxe);
    case 'keyof':
      return hasIrDependentCallablePackHaxe(type.type);
    case 'named':
      return type.typeArguments.some(hasIrDependentCallablePackHaxe);
    case 'object':
      return type.properties.some((property) => hasIrDependentCallablePackHaxe(property.type));
    case 'tuple':
      return type.elements.some((element) => hasIrDependentCallablePackHaxe(element.type));
    case 'literal':
    case 'never':
    case 'null':
    case 'primitive':
    case 'typeOf':
    case 'undefined':
    case 'unknown':
      return false;
  }
}

function emitArraySpliceInsertionHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string {
  if (expression.callee.kind !== 'property') {
    return emissionError(context, 'array splice insertion requires a property call');
  }
  const receiver = getGeneratedTargetNameHaxe('spliceReceiver', context);
  const position = getGeneratedTargetNameHaxe('splicePosition', context);
  const removed = getGeneratedTargetNameHaxe('spliceRemoved', context);
  const [start, count, ...inserted] = expression.arguments;
  if (!start || !count) return emissionError(context, 'array splice insertion requires start and count');
  const insertions = inserted
    .map(
      (item, index) =>
        `${receiver}.insert(${index === 0 ? position : `${position} + ${String(index)}`}, ${emitExpression(item, context)});`,
    )
    .join(' ');
  return `(function() { final ${receiver} = ${emitExpression(expression.callee.object, context)}; final ${position}:Int = Std.int(${emitExpression(start, context)}); final ${removed} = ${receiver}.splice(${position}, Std.int(${emitExpression(count, context)})); ${insertions} return ${removed}; })()`;
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
  const reflective =
    left.semantics.key !== 'number' ||
    left.semantics.receivers.includes('object') ||
    left.semantics.receivers.includes('unknown');
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
  const directTarget = `${receiver}[Std.int(${key})]`;
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
  const nativeInstanceofTarget =
    expression.operator === 'instanceof' &&
    expression.right.kind === 'identifier' &&
    expression.right.reference.kind === 'ambient'
      ? haxeNativeInstanceofConstructorTargets.get(expression.right.reference.name)
      : undefined;
  // Portable typed-array adapters are Haxe abstracts and therefore cannot be passed as class
  // values. The JavaScript operator still needs the native constructor identity; ordinary
  // source-declared constructor values continue through the runtime unchanged.
  const right = nativeInstanceofTarget ?? emitExpression(expression.right, context);
  if (expression.operator === '&&' || expression.operator === '||') {
    const value = getGeneratedTargetNameHaxe('logicalLeftValue', context);
    const whenTruthy = expression.operator === '&&' ? right : value;
    const whenFalsy = expression.operator === '&&' ? value : right;
    return `(function() { final ${value}:Dynamic = ${left}; return ${runtime}.truthy(${value}) ? ${whenTruthy} : ${whenFalsy}; })()`;
  }
  return emitJavaScriptBinaryRuntimeCallHaxe(expression.operator, left, right, runtime);
}

const haxeNativeInstanceofConstructorTargets = new Map<string, string>([
  ['ArrayBuffer', 'js.lib.ArrayBuffer'],
  ['BigInt64Array', 'js.lib.BigInt64Array'],
  ['BigUint64Array', 'js.lib.BigUint64Array'],
  ['DataView', 'js.lib.DataView'],
  ['Date', 'js.lib.Date'],
  ['Float32Array', 'js.lib.Float32Array'],
  ['Float64Array', 'js.lib.Float64Array'],
  ['Int16Array', 'js.lib.Int16Array'],
  ['Int32Array', 'js.lib.Int32Array'],
  ['Int8Array', 'js.lib.Int8Array'],
  ['Map', 'js.lib.Map'],
  ['RegExp', 'js.lib.RegExp'],
  ['Set', 'js.lib.Set'],
  ['Uint16Array', 'js.lib.Uint16Array'],
  ['Uint32Array', 'js.lib.Uint32Array'],
  ['Uint8Array', 'js.lib.Uint8Array'],
  ['Uint8ClampedArray', 'js.lib.Uint8ClampedArray'],
]);

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
      return `${context.haxeReflectName}.deleteField(${emitExpression(expression.operand.object, context)}, ${emitHaxeStringLiteral(safeHaxeName(expression.operand.name))})`;
    }
    if (expression.operand.kind === 'element') {
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
    expression.left.kind === 'property' &&
    haxeNativeIntegerProperties.has(
      `${getIrExpressionAmbientTypeNameHaxe(expression.left.object, context) ?? ''}.${expression.left.name}`,
    )
  ) {
    return `Std.int(${emitExpression(expression.right, context)})`;
  }
  if (
    expression.operator === '=' &&
    expression.left.kind === 'element' &&
    (expression.left.semantics.receivers.every((receiver) => haxeIntegerTypedArrayReceivers.has(receiver)) ||
      isIrIntegerTypedArrayHaxe(getIrExpressionTypeHaxe(expression.left.object, context)))
  ) {
    return `Std.int(${emitExpression(expression.right, context)})`;
  }
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
  const emitted = emitExpression(expression.right, context);
  return expression.operator === '='
    ? emitExpressionAsExpectedTypeHaxe(
        expression.right,
        getIrExpressionTypeHaxe(expression.left, context),
        context,
        emitted,
      )
    : emitted;
}

const haxeIntegerTypedArrayReceivers = new Set([
  'int8Array',
  'int16Array',
  'int32Array',
  'uint8Array',
  'uint8ClampedArray',
  'uint16Array',
  'uint32Array',
]);

const haxeConstructedAmbientValueTypeNames = new Set([
  'ArrayBuffer',
  'BigInt64Array',
  'BigUint64Array',
  'DataView',
  'Float32Array',
  'Float64Array',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
]);

function isIrIntegerTypedArrayHaxe(type: Readonly<IrType> | undefined): boolean {
  if (!type) return false;
  if (type.kind === 'union') {
    const concrete = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
    return concrete.length > 0 && concrete.every(isIrIntegerTypedArrayHaxe);
  }
  if (type.kind !== 'named' || type.reference.kind !== 'ambient') return false;
  if (['Partial', 'Readonly', 'Required'].includes(type.reference.name) && type.typeArguments[0]) {
    return isIrIntegerTypedArrayHaxe(type.typeArguments[0]);
  }
  return [
    'Int16Array',
    'Int32Array',
    'Int8Array',
    'Uint16Array',
    'Uint32Array',
    'Uint8Array',
    'Uint8ClampedArray',
  ].includes(type.reference.name);
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
  const parameterTypes = expandIrCallParameterTypesHaxe(getIrCallParameterTypesHaxe(expression, context), expression);
  return expression.arguments
    .map((argument, index) => {
      if (defaulted.get(index)?.value === 'undefined') {
        emissionError(context, 'explicit undefined default arguments require Haxe omission lowering');
      }
      const emitted = emitHaxeCallArgument(argument, context);
      return emitExpressionAsExpectedTypeHaxe(argument, parameterTypes?.[index], context, emitted);
    })
    .join(', ');
}

function expandIrCallParameterTypesHaxe(
  parameterTypes: readonly (Readonly<IrType> | undefined)[] | undefined,
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
): readonly (Readonly<IrType> | undefined)[] | undefined {
  const restPosition = expression.semantics.signature?.restParameter;
  if (!parameterTypes || restPosition === undefined) return parameterTypes;
  const restType = parameterTypes[restPosition];
  const elementType = restType?.kind === 'array' ? restType.element : undefined;
  return expression.arguments.map((_, index) => (index < restPosition ? parameterTypes[index] : elementType));
}

function getIrCallParameterTypesHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): readonly (Readonly<IrType> | undefined)[] | undefined {
  if (expression.callee.kind === 'function') {
    return expression.callee.parameters.map((parameter) => getIrCallParameterTypeHaxe(parameter.type));
  }
  if (expression.callee.kind === 'property') {
    const objectType = getIrExpressionTypeHaxe(expression.callee.object, context);
    const memberType = objectType
      ? getIrObjectPropertyTypeHaxe(objectType, expression.callee.name, context)
      : undefined;
    const concrete = memberType ? getIrSingleConcreteTypeHaxe(memberType) : undefined;
    return concrete?.kind === 'function'
      ? concrete.parameters.map((parameter) => getIrCallParameterTypeHaxe(parameter.type))
      : undefined;
  }
  if (expression.callee.kind !== 'identifier' || expression.callee.reference.kind !== 'binding') return undefined;
  const binding = expression.callee.reference.binding;
  const local = context.module.declarations.find(
    (declaration) => declaration.kind === 'function' && declaration.binding.id === binding.id,
  );
  if (local?.kind === 'function') {
    return local.parameters.map((parameter) => getIrCallParameterTypeHaxe(parameter.type));
  }
  const imported = context.module.imports
    .flatMap((entry) => entry.bindings.map((candidate) => ({ candidate, entry })))
    .find(({ candidate }) => candidate.binding.id === binding.id);
  if (!imported || imported.candidate.imported === '*' || imported.candidate.imported === 'default') return undefined;
  const sourceModule = getHaxeResolvedImportModule(imported.entry.specifier, context, imported.candidate.imported);
  if (!sourceModule) return undefined;
  const direct = sourceModule.declarations.find(
    (declaration) => declaration.kind === 'function' && declaration.binding.name === imported.candidate.imported,
  );
  if (direct?.kind === 'function') {
    return direct.parameters.map((parameter) => getIrCallParameterTypeHaxe(parameter.type));
  }
  const facade = context.getModuleFacade?.(sourceModule);
  const slot = facade?.modules
    .find((module) => isHaxeCompilerModuleIdentityEqual(module.module, sourceModule))
    ?.slots.find((candidate) => candidate.exportName === imported.candidate.imported && candidate.lane === 'value');
  if (!slot) return undefined;
  const target = getModuleFacadeBindingTargetHaxe(slot, context);
  return target.declaration.kind === 'function'
    ? target.declaration.parameters.map((parameter) => getIrCallParameterTypeHaxe(parameter.type))
    : undefined;
}

// A declaration's generic parameter belongs to the callee and cannot be named at its call site.
// Haxe infers that position from the actual argument just as TypeScript did. Concrete positions on
// the same generic function remain useful targets (for example an imported structural options bag).
function getIrCallParameterTypeHaxe(type: Readonly<IrType>): Readonly<IrType> | undefined {
  return hasIrTypeParameterReferenceHaxe(type) ? undefined : type;
}

function emitHaxeCallArgument(expression: Readonly<IrExpression>, context: EmitContext): string {
  const emitted = emitExpression(expression, context);
  const type = getIrExpressionTypeHaxe(expression, context);
  const concrete = type ? getIrSingleConcreteTypeHaxe(type) : undefined;
  if (concrete?.kind === 'primitive' && concrete.name === 'void') {
    // JavaScript permits a void-returning call in value position and passes its `undefined`
    // completion value. Haxe's `Void` is not a value, so materialize the source completion after
    // evaluating the call exactly once (notably for generic compile-time assertions of sync APIs).
    return `(function() { ${emitted}; return js.Syntax.code("undefined"); })()`;
  }
  return isIrExpressionFunctionValuedHaxe(expression, context) ? `cast(${emitted})` : emitted;
}

function emitReturnedExpressionHaxe(expression: Readonly<IrExpression>, context: EmitContext): string {
  return normalizeHaxeExpressionGrouping(emitExpressionAsExpectedTypeHaxe(expression, context.returnType, context));
}

function emitExpressionAsExpectedTypeHaxe(
  expression: Readonly<IrExpression>,
  expectedType: Readonly<IrType> | undefined,
  context: EmitContext,
  emitted: string = emitExpression(expression, context),
): string {
  if (!expectedType) return emitted;
  const concreteExpected = getIrSingleConcreteTypeHaxe(expectedType);
  if (
    (concreteExpected.kind === 'array' || concreteExpected.kind === 'tuple') &&
    expression.kind === 'array' &&
    expression.elements.length === 0
  ) {
    return `(cast [] : ${emitType(concreteExpected, context)})`;
  }
  const expressionType = getIrExpressionTypeHaxe(expression, context);
  const expectedStringNominal =
    isIrNamedUnionAliasHaxe(concreteExpected, context) ||
    (concreteExpected.kind === 'named' &&
      concreteExpected.reference.kind === 'ambient' &&
      concreteExpected.reference.name === 'WebGLPowerPreference');
  const expectedNative =
    concreteExpected.kind === 'named' &&
    concreteExpected.reference.kind === 'ambient' &&
    !['Dynamic', 'String'].includes(
      getCompilerRuntimeExternalSymbolTargetHaxe(
        concreteExpected.reference.name,
        'type',
        context.options.runtimeModule,
      ) ?? 'Dynamic',
    );
  const expectedFunction = isIrTypeFunctionShapedHaxe(concreteExpected, context);
  const nullableFunctionIdentifier =
    expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    expression.presence !== 'narrowedPresent' &&
    context.nullableBindingIds.has(expression.reference.binding.id);
  const functionBoundary =
    expectedFunction && isIrExpressionFunctionValuedHaxe(expression, context) && !nullableFunctionIdentifier;
  if (functionBoundary) {
    if (expression.kind === 'function') return `cast(${normalizeHaxeExpressionGrouping(emitted)})`;
    const direct = emitted.startsWith('cast(') && emitted.endsWith(')') ? emitted.slice(5, -1) : emitted;
    return `(cast ${normalizeHaxeExpressionGrouping(direct)} : ${emitType(concreteExpected, context)})`;
  }
  const alreadyExpectedStructuralType =
    expressionType !== undefined &&
    emitType(getIrSingleConcreteTypeHaxe(expressionType), context) === emitType(concreteExpected, context);
  if (
    expression.kind === 'binary' &&
    expression.operator === '??' &&
    ((expectedStringNominal && isIrExpressionStringBackedHaxe(expression, context)) ||
      expectedFunction ||
      concreteExpected.kind === 'array' ||
      concreteExpected.kind === 'object')
  ) {
    const target = emitType(concreteExpected, context);
    return `((cast ${normalizeHaxeExpressionGrouping(emitExpression(expression.left, context))} : Null<${target}>) ?? (cast ${normalizeHaxeExpressionGrouping(emitExpression(expression.right, context))} : ${target}))`;
  }
  if (
    expectedNative ||
    (isIrStructuralRecordTypeHaxe(concreteExpected, context) &&
      (expression.kind === 'object' || !alreadyExpectedStructuralType)) ||
    (expectedStringNominal &&
      (isIrExpressionStringBackedHaxe(expression, context) ||
        expression.kind === 'object' ||
        expression.kind === 'call')) ||
    ((concreteExpected.kind === 'array' || concreteExpected.kind === 'tuple') &&
      !alreadyExpectedStructuralType &&
      (expression.kind === 'undefinedDefault' ||
        expression.kind === 'array' ||
        expression.kind === 'tuple' ||
        expression.kind === 'conditional' ||
        (expression.kind === 'binary' && expression.operator === '??') ||
        (expressionType !== undefined &&
          emitType(getIrSingleConcreteTypeHaxe(expressionType), context) !== emitType(concreteExpected, context))))
  ) {
    return `(cast ${normalizeHaxeExpressionGrouping(emitted)} : ${emitType(concreteExpected, context)})`;
  }
  return emitted;
}

function isIrStructuralRecordTypeHaxe(
  type: Readonly<IrType>,
  context: EmitContext,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const concrete = getIrSingleConcreteTypeHaxe(type);
  if (concrete.kind === 'object') return true;
  if (concrete.kind === 'union') {
    const members = concrete.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
    return members.length > 0 && members.every((member) => isIrStructuralRecordTypeHaxe(member, context, seen));
  }
  if (concrete.kind !== 'named') return false;
  if (
    concrete.reference.kind === 'ambient' &&
    ['Partial', 'Readonly', 'Required'].includes(concrete.reference.name) &&
    concrete.typeArguments[0]
  ) {
    return isIrStructuralRecordTypeHaxe(concrete.typeArguments[0], context, seen);
  }
  if (concrete.reference.kind !== 'binding') return false;
  const target = getIrNamedDeclarationTargetHaxe(concrete, context);
  if (!target || seen.has(target.binding.id)) return false;
  if (target.declaration.kind === 'interface') return true;
  if (target.declaration.kind !== 'typeAlias') return false;
  const substituted = resolveIrTypeStructuralSubstitution(
    target.declaration.type,
    createIrTypeParameterSubstitutionPlan(target.declaration.typeParameters, concrete.typeArguments),
  );
  return isIrStructuralRecordTypeHaxe(substituted, context, new Set(seen).add(target.binding.id));
}

function getIrSingleConcreteTypeHaxe(type: Readonly<IrType>): Readonly<IrType> {
  if (type.kind !== 'union') return type;
  const concrete = type.types.filter((member) => member.kind !== 'null' && member.kind !== 'undefined');
  return concrete.length === 1 ? concrete[0]! : type;
}

function isIrExpressionFunctionValuedHaxe(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  if (expression.kind === 'function') return true;
  if (expression.kind === 'conditional') {
    return (
      isIrExpressionFunctionValuedHaxe(expression.whenTrue, context) &&
      isIrExpressionFunctionValuedHaxe(expression.whenFalse, context)
    );
  }
  if (expression.kind !== 'identifier' || expression.reference.kind !== 'binding') return false;
  if (expression.reference.binding.kind === 'function') return true;
  const type = getIrExpressionTypeHaxe(expression, context);
  if (type && isIrTypeFunctionShapedHaxe(type, context)) return true;
  const names = new Set([expression.reference.binding.name]);
  for (const imported of context.module.imports) {
    for (const binding of imported.bindings) {
      if (binding.binding.id === expression.reference.binding.id) names.add(binding.imported);
    }
  }
  return [...names].some((name) => context.functionValueNames.has(name));
}

function isIrTypeFunctionShapedHaxe(
  type: Readonly<IrType>,
  context: EmitContext,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (type.kind === 'function') return true;
  if (type.kind === 'union') return type.types.some((member) => isIrTypeFunctionShapedHaxe(member, context, seen));
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return false;
  const name = type.reference.binding.name;
  if (seen.has(name)) return false;
  return (
    context.typeAliasesByName
      .get(name)
      ?.some((alias) => isIrTypeFunctionShapedHaxe(alias, context, new Set([...seen, name]))) ?? false
  );
}

function getHaxeFunctionValueNames(modules: readonly Readonly<IrModule>[]): ReadonlySet<string> {
  const cached = haxeFunctionValueNamesBySourceModules.get(modules);
  if (cached) return cached;
  const names = new Set(
    modules.flatMap((module) =>
      module.declarations.flatMap((declaration) => (declaration.kind === 'function' ? [declaration.binding.name] : [])),
    ),
  );
  haxeFunctionValueNamesBySourceModules.set(modules, names);
  return names;
}

function getHaxeTypeAliasesByName(
  modules: readonly Readonly<IrModule>[],
): ReadonlyMap<string, readonly Readonly<IrType>[]> {
  const cached = haxeTypeAliasesBySourceModules.get(modules);
  if (cached) return cached;
  const aliases = new Map<string, Readonly<IrType>[]>();
  for (const module of modules) {
    for (const declaration of module.declarations) {
      if (declaration.kind !== 'typeAlias') continue;
      const values = aliases.get(declaration.binding.name) ?? [];
      values.push(declaration.type);
      aliases.set(declaration.binding.name, values);
    }
  }
  haxeTypeAliasesBySourceModules.set(modules, aliases);
  return aliases;
}

function emitObjectExpressionHaxe(expression: Readonly<IrObjectExpression>, context: EmitContext): string {
  if (expression.members.some((member) => member.kind === 'getAccessor')) {
    return emitObjectAccessorExpressionHaxe(expression, context);
  }
  if (expression.members.every((member) => member.kind === 'property')) {
    return `{ ${expression.members
      .map((member) => {
        const expected = getIrObjectPropertyTypeHaxe(expression.type, member.name, context);
        return `${safeHaxeName(member.name)}: ${emitExpressionAsExpectedTypeHaxe(member.value, expected, context)}`;
      })
      .join(', ')} }`;
  }
  const target = getGeneratedTargetNameHaxe('objectSpreadValue', context);
  const lines = [`final ${target}:Dynamic = {};`];
  for (const member of expression.members) {
    if (member.kind === 'property') {
      const expected = getIrObjectPropertyTypeHaxe(expression.type, member.name, context);
      lines.push(
        `${context.haxeReflectName}.setField(${target}, ${emitHaxeStringLiteral(safeHaxeName(member.name))}, ${emitExpressionAsExpectedTypeHaxe(member.value, expected, context)});`,
      );
      continue;
    }
    if (member.kind === 'computedProperty') {
      lines.push(
        `${context.options.runtimeModule ?? 'flighthq._internal'}._Js.setProperty(${target}, ${emitExpression(member.key, context)}, ${emitExpression(member.value, context)});`,
      );
      continue;
    }
    if (member.kind === 'spread') {
      const source = getGeneratedTargetNameHaxe('objectSpreadSource', context);
      const key = getGeneratedTargetNameHaxe('objectSpreadKey', context);
      lines.push(
        `final ${source}:Dynamic = ${emitExpression(member.expression, context)};`,
        `if (${source} != null) for (${key} in ${context.haxeReflectName}.fields(${source})) ${context.haxeReflectName}.setField(${target}, ${key}, ${context.haxeReflectName}.field(${source}, ${key}));`,
      );
      continue;
    }
    emissionError(context, 'object getter escaped accessor-specific Haxe lowering');
  }
  lines.push(`return ${target};`);
  return `(function() {\n${indentSourceLines(lines).join('\n')}\n})()`;
}

function getIrObjectPropertyTypeHaxe(
  type: Readonly<IrType>,
  name: string,
  context: EmitContext,
  seen: ReadonlySet<string> = new Set(),
): Readonly<IrType> | undefined {
  const concrete = getIrSingleConcreteTypeHaxe(type);
  if (concrete.kind === 'object') return concrete.properties.find((property) => property.name === name)?.type;
  if (concrete.kind === 'intersection') {
    const inherited = concrete.types.flatMap((member) => {
      const property = getIrObjectPropertyTypeHaxe(member, name, context, seen);
      return property ? [property] : [];
    });
    if (inherited.length === 1) return inherited[0];
  }
  if (
    concrete.kind === 'named' &&
    concrete.reference.kind === 'ambient' &&
    (concrete.reference.name === 'Record' || concrete.reference.name === 'ReadonlyRecord')
  ) {
    return concrete.typeArguments[1];
  }
  if (
    concrete.kind === 'named' &&
    concrete.reference.kind === 'ambient' &&
    concrete.reference.name === 'WebGLContextAttributes' &&
    name === 'powerPreference'
  ) {
    return {
      kind: 'union',
      types: [
        { kind: 'named', reference: { kind: 'ambient', name: 'WebGLPowerPreference' }, typeArguments: [] },
        { kind: 'undefined' },
      ],
    };
  }
  if (
    concrete.kind === 'named' &&
    concrete.reference.kind === 'ambient' &&
    ['Partial', 'Readonly', 'Required'].includes(concrete.reference.name) &&
    concrete.typeArguments[0]
  ) {
    return getIrObjectPropertyTypeHaxe(concrete.typeArguments[0], name, context, seen);
  }
  if (concrete.kind !== 'named' || concrete.reference.kind !== 'binding') return undefined;
  const target = getIrNamedDeclarationTargetHaxe(concrete, context);
  if (!target || seen.has(target.binding.id)) return undefined;
  if (target.declaration.kind === 'interface') {
    const substitution = createIrTypeParameterSubstitutionPlan(
      target.declaration.typeParameters,
      concrete.typeArguments,
    );
    const property = target.declaration.properties.find((candidate) => candidate.name === name);
    if (property) return resolveIrTypeStructuralSubstitution(property.type, substitution);
    const inheritedSeen = new Set(seen).add(target.binding.id);
    for (const extended of target.declaration.extends) {
      const inherited = getIrObjectPropertyTypeHaxe(
        resolveIrTypeStructuralSubstitution(extended, substitution),
        name,
        context,
        inheritedSeen,
      );
      if (inherited) return inherited;
    }
    return undefined;
  }
  if (target.declaration.kind !== 'typeAlias') return undefined;
  const substituted = resolveIrTypeStructuralSubstitution(
    target.declaration.type,
    createIrTypeParameterSubstitutionPlan(target.declaration.typeParameters, concrete.typeArguments),
  );
  return getIrObjectPropertyTypeHaxe(substituted, name, context, new Set(seen).add(target.binding.id));
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
  const construction = `new ${className}(${arguments_.join(', ')})`;
  const target = emitType(expression.type, context);
  return target === 'Dynamic' ? construction : `(cast ${construction} : ${target})`;
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
    returnType: declaration.returns,
    returnsAbsent: canIrTypeReturnAbsentHaxe(declaration.returns, outer.module),
  };
  const emittedParameters = emitParametersWithInitializersHaxe(declaration.parameters, context);
  return [
    `${access}function ${getBindingTargetNameHaxe(declaration.binding, context)}${emitTypeParameters(declaration.typeParameters, context, false)}(${emittedParameters.signature}):${emitType(declaration.returns, context)} {`,
    ...indentSourceLines([
      ...emittedParameters.initializers,
      ...(declaration.async
        ? emitCompilerHaxeTaskFunctionBody(declaration, emittedParameters.context)
        : emitFunctionStatementsHaxe(declaration.body, emittedParameters.context)),
    ]),
    '}',
  ];
}

function emitImports(imports: readonly IrImport[], context: EmitContext): string[] {
  const bindingsByTarget = new Map<
    string,
    Array<{
      readonly binding: Readonly<IrImport['bindings'][number]>;
      readonly importedName: string;
      readonly localName: string;
      readonly modulePath: string;
    }>
  >();
  for (const imported of imports) {
    // Validate even an import with no bindings: side-effect resources still have to be
    // materialized, and a default resource import should report that boundary before the generic
    // default-import capability gap.
    if (imported.specifier.startsWith('.')) haxeImportModule(imported.specifier, context);
    if (imported.bindings.length === 0) continue;
    for (const binding of imported.bindings) {
      if (binding.imported === '*' || binding.imported === 'default') {
        emissionError(context, `${binding.imported} imports require explicit Haxe mapping for ${imported.specifier}`);
      }
      const forwardedTarget = getLocalImportedExportTargetHaxe(
        imported.specifier,
        binding.imported,
        binding.binding.space,
        context,
      );
      const importedName = forwardedTarget?.importedName ?? getImportedTargetNameHaxe(imported, binding, context);
      const localName = getBindingTargetNameHaxe(binding.binding, context);
      const modulePath = forwardedTarget?.modulePath ?? haxeImportModule(imported.specifier, context, binding.imported);
      const target = `${modulePath}.${importedName}`;
      const targetBindings = bindingsByTarget.get(target) ?? [];
      targetBindings.push({ binding, importedName, localName, modulePath });
      bindingsByTarget.set(target, targetBindings);
    }
  }
  const emitted: string[] = [];
  for (const targetBindings of bindingsByTarget.values()) {
    const canonical = [...targetBindings].sort((left, right) => {
      const leftExact = left.localName === left.importedName ? 0 : 1;
      const rightExact = right.localName === right.importedName ? 0 : 1;
      return (
        leftExact - rightExact ||
        (left.binding.binding.space === right.binding.binding.space
          ? 0
          : left.binding.binding.space === 'type'
            ? -1
            : 1) ||
        compareTextCodeUnits(left.localName, right.localName)
      );
    })[0]!;
    for (const targetBinding of targetBindings) {
      context.facadeBindingTargetNames.set(targetBinding.binding.binding.id, canonical.localName);
    }
    emitted.push(
      `import ${canonical.modulePath}.${canonical.importedName}${canonical.importedName === canonical.localName ? '' : ` as ${canonical.localName}`};`,
    );
  }
  for (const imported of imports) {
    for (const binding of imported.bindings) {
      if (binding.binding.space === 'type' || binding.imported === '*' || binding.imported === 'default') continue;
      if (
        imports.some(
          (candidate) =>
            candidate.specifier === imported.specifier &&
            candidate.bindings.some(
              (candidateBinding) =>
                candidateBinding.binding.space === 'type' && candidateBinding.imported === binding.imported,
            ),
        )
      ) {
        continue;
      }
      const typeTarget = getImportedTypeLaneTargetHaxe(imported, binding, context);
      if (!typeTarget) continue;
      const localName = getGeneratedTargetNameHaxe(typeTarget.importedName, context);
      context.importedTypeTargetNames.set(binding.binding.id, localName);
      emitted.push(
        `import ${typeTarget.modulePath}.${typeTarget.importedName}${typeTarget.importedName === localName ? '' : ` as ${localName}`};`,
      );
    }
  }
  return [`import Reflect as ${context.haxeReflectName};`, ...new Set(emitted)].sort();
}

function getImportedTypeLaneTargetHaxe(
  imported: Readonly<IrImport>,
  binding: Readonly<IrImport['bindings'][number]>,
  context: EmitContext,
): { readonly importedName: string; readonly modulePath: string } | undefined {
  const sourceModule = getHaxeResolvedImportModule(imported.specifier, context, binding.imported);
  if (!sourceModule) return undefined;
  const forwardedTarget = getLocalImportedExportTargetHaxe(imported.specifier, binding.imported, 'type', context);
  if (forwardedTarget) return forwardedTarget;
  const direct = sourceModule.declarations.find(
    (declaration) =>
      'binding' in declaration &&
      declaration.binding.name === binding.imported &&
      (declaration.kind === 'class' ||
        declaration.kind === 'enum' ||
        declaration.kind === 'interface' ||
        declaration.kind === 'typeAlias'),
  );
  if (direct && 'binding' in direct) {
    if (direct.binding.id === binding.binding.id) return undefined;
    return {
      importedName: getSourceBindingTargetNameHaxe(sourceModule, direct.binding, context),
      modulePath: getHaxeModulePath(sourceModule, context.options),
    };
  }
  const facade = context.getModuleFacade?.(sourceModule);
  const slot = facade?.modules
    .find((module) => isHaxeCompilerModuleIdentityEqual(module.module, sourceModule))
    ?.slots.find((candidate) => candidate.exportName === binding.imported && candidate.lane === 'type');
  if (
    !slot ||
    (slot.source.kind !== 'module-all' && slot.source.kind !== 'module-binding') ||
    slot.route.kind !== 'binding' ||
    ((slot.route.binding.kind === 'class' || slot.route.binding.kind === 'enum') &&
      slot.route.binding.id === binding.binding.id)
  ) {
    return undefined;
  }
  const importedName = getHaxeFacadeTypeTargetNames(sourceModule, context).get(binding.imported);
  return importedName ? { importedName, modulePath: getHaxeModulePath(sourceModule, context.options) } : undefined;
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
  return getHaxeFacadeTypeTargetNames(sourceModule, context).get(binding.imported) ?? fallback;
}

// `import { Type }; export type { Type };` is a source-language re-export, but a Haxe import is
// module-private and does not create a secondary type on the importing module. Consumers of that
// shape therefore have to target the facade route's declaration home directly. Explicit and star
// facades still keep their generated aliases/forwarders, which are part of the public Haxe layout.
function getLocalImportedExportTargetHaxe(
  specifier: string,
  importedName: string,
  lane: 'type' | 'value',
  context: EmitContext,
): { readonly importedName: string; readonly modulePath: string } | undefined {
  const sourceModule = getHaxeResolvedImportModule(specifier, context, importedName);
  if (!sourceModule) return undefined;
  const exportedImport = sourceModule.exports.find(
    (exported) =>
      exported.kind === 'local' &&
      exported.exported === importedName &&
      exported.binding.kind === 'import' &&
      exported.binding.space === lane,
  );
  if (!exportedImport) return undefined;
  const slot = context
    .getModuleFacade?.(sourceModule)
    ?.modules.find((module) => isHaxeCompilerModuleIdentityEqual(module.module, sourceModule))
    ?.slots.find((candidate) => candidate.exportName === importedName && candidate.lane === lane);
  if (!slot || slot.route.kind !== 'binding') return undefined;
  const target = getModuleFacadeBindingTargetHaxe(slot, context);
  return {
    importedName: getSourceBindingTargetNameHaxe(target.module, target.binding, context),
    modulePath: getHaxeModulePath(target.module, context.options),
  };
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
      const typeSlot = context.moduleFacadeSlots.find(
        (candidate) =>
          candidate.exportName === exported.exported &&
          candidate.lane === 'type' &&
          candidate.source.kind === 'module-binding' &&
          candidate.route.kind === 'binding',
      );
      const valueSlot = context.moduleFacadeSlots.find(
        (candidate) =>
          candidate.exportName === exported.exported &&
          candidate.lane === 'value' &&
          candidate.source.kind === 'module-binding' &&
          candidate.route.kind === 'binding',
      );
      const typeTarget = typeSlot ? getModuleFacadeBindingTargetHaxe(typeSlot, context) : undefined;
      const valueTarget = valueSlot ? getModuleFacadeBindingTargetHaxe(valueSlot, context) : undefined;
      const sharedNominal =
        typeTarget !== undefined &&
        valueTarget !== undefined &&
        typeTarget.binding.id === valueTarget.binding.id &&
        (valueTarget.binding.kind === 'class' || valueTarget.binding.kind === 'enum');
      if (typeTarget && !sharedNominal) {
        const typeName =
          context.facadeTypeTargetNames.get(exported.exported) ??
          getGeneratedTargetNameHaxe(
            safeHaxeTypeName(`${haxeImplementationModule(context.module.source)}_${exported.exported}`),
            context,
          );
        context.facadeBindingTargetNames.set(typeTarget.binding.id, typeName);
        typeLines.add(emitFacadeTypeAliasHaxe(typeName, typeTarget, context));
      }
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
    if (target) context.facadeBindingTargetNames.set(target.binding.id, targetName);
    const targetModulePath = target ? getHaxeModulePath(target.module, context.options) : modulePath;
    const sourceName = target
      ? getSourceBindingTargetNameHaxe(target.module, target.binding, context)
      : safeHaxeTypeName(exported.imported);
    typeLines.add(
      target
        ? emitFacadeTypeAliasHaxe(targetName, target, context)
        : `typedef ${targetName} = ${targetModulePath}.${sourceName};`,
    );
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
      typeLines.push(emitFacadeTypeAliasHaxe(typeName, typeTarget, context));
    }
    if (!valueTarget || sharedNominal || !valueName) continue;
    const modulePath = getHaxeModulePath(valueTarget.module, context.options);
    const sourceName = getSourceBindingTargetNameHaxe(valueTarget.module, valueTarget.binding, context);
    if (valueTarget.declaration.kind === 'function') {
      valueLines.push(
        ...emitFunctionReexportForwardingHaxe(
          valueName,
          sourceName,
          valueTarget.declaration,
          valueTarget.module,
          modulePath,
          context,
        ),
      );
      continue;
    }
    if (valueTarget.declaration.kind === 'variable') {
      const type = valueTarget.declaration.type
        ? emitFacadeTypeHaxe(valueTarget.declaration.type, valueTarget.module, context)
        : 'Dynamic';
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

function getIrNamedDeclarationTargetHaxe(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  context: EmitContext,
): HaxeNamedDeclarationTarget | undefined {
  const reference = type.reference;
  if (reference.kind !== 'binding' || reference.path.length > 0) return undefined;
  if (context.namedDeclarationTargets.has(reference.binding.id)) {
    return context.namedDeclarationTargets.get(reference.binding.id) ?? undefined;
  }
  const exact = getHaxeDeclarationTargetsByBindingId(context.sourceModules).get(reference.binding.id);
  if (exact) {
    context.namedDeclarationTargets.set(reference.binding.id, exact);
    return exact;
  }
  const importedBindings = context.module.imports.flatMap((entry) =>
    entry.bindings.map((binding) => ({ binding, entry, owner: context.module })),
  );
  const exactImported = importedBindings.find(({ binding }) => binding.binding.id === reference.binding.id);
  const foreignOwner = context.sourceModules.find(
    (module) =>
      module.packageName === reference.binding.packageName &&
      normalizePathPortable(module.source) === normalizePathPortable(reference.binding.source),
  );
  const exactForeignImported = foreignOwner?.imports
    .flatMap((entry) => entry.bindings.map((binding) => ({ binding, entry, owner: foreignOwner })))
    .find(({ binding }) => binding.binding.id === reference.binding.id);
  const sameNamedImports = importedBindings.filter(
    ({ binding }) => binding.binding.name === reference.binding.name && binding.binding.space === 'type',
  );
  const imported =
    exactImported ?? exactForeignImported ?? (sameNamedImports.length === 1 ? sameNamedImports[0] : undefined);
  if (!imported || imported.binding.imported === '*' || imported.binding.imported === 'default') {
    context.namedDeclarationTargets.set(reference.binding.id, null);
    return undefined;
  }
  const sourceModule = getHaxeResolvedImportModuleFrom(
    imported.owner,
    imported.entry.specifier,
    context.sourceModules,
    context.moduleResolution,
    imported.binding.imported,
  );
  if (!sourceModule) {
    context.namedDeclarationTargets.set(reference.binding.id, null);
    return undefined;
  }
  const direct = sourceModule.declarations.find(
    (candidate) =>
      'binding' in candidate &&
      candidate.binding.name === imported.binding.imported &&
      (candidate.kind === 'class' ||
        candidate.kind === 'enum' ||
        candidate.kind === 'interface' ||
        candidate.kind === 'typeAlias'),
  );
  if (direct && 'binding' in direct) {
    const target = { binding: direct.binding, declaration: direct, module: sourceModule } as const;
    context.namedDeclarationTargets.set(reference.binding.id, target);
    return target;
  }
  const facade = context.getModuleFacade?.(sourceModule);
  const slot = facade?.modules
    .find((module) => isHaxeCompilerModuleIdentityEqual(module.module, sourceModule))
    ?.slots.find((candidate) => candidate.exportName === imported.binding.imported && candidate.lane === 'type');
  const target = slot ? getModuleFacadeBindingTargetHaxe(slot, context) : undefined;
  context.namedDeclarationTargets.set(reference.binding.id, target ?? null);
  return target;
}

const haxeDeclarationTargetsBySourceModules = new WeakMap<
  readonly Readonly<IrModule>[],
  ReadonlyMap<string, HaxeNamedDeclarationTarget>
>();

function getHaxeDeclarationTargetsByBindingId(
  modules: readonly Readonly<IrModule>[],
): ReadonlyMap<string, HaxeNamedDeclarationTarget> {
  const cached = haxeDeclarationTargetsBySourceModules.get(modules);
  if (cached) return cached;
  const targets = new Map<string, HaxeNamedDeclarationTarget>();
  for (const module of modules) {
    for (const declaration of module.declarations) {
      if ('binding' in declaration) {
        targets.set(declaration.binding.id, { binding: declaration.binding, declaration, module });
      }
    }
  }
  haxeDeclarationTargetsBySourceModules.set(modules, targets);
  return targets;
}

function isIrNamedUnionAliasHaxe(type: Readonly<IrType>, context: EmitContext): boolean {
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return false;
  const target = getIrNamedDeclarationTargetHaxe(type, context);
  return target?.declaration.kind === 'typeAlias' && target.declaration.type.kind === 'union';
}

function isIrExpressionStringBackedHaxe(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  const type = getIrExpressionTypeHaxe(expression, context);
  if (type && isIrTypeStringBackedHaxe(type, context)) return true;
  if (expression.kind === 'binary' && expression.operator === '??') {
    return (
      isIrExpressionStringBackedHaxe(expression.left, context) &&
      isIrExpressionStringBackedHaxe(expression.right, context)
    );
  }
  if (expression.kind === 'conditional') {
    return (
      isIrExpressionStringBackedHaxe(expression.whenTrue, context) &&
      isIrExpressionStringBackedHaxe(expression.whenFalse, context)
    );
  }
  if (expression.kind === 'undefinedDefault') {
    return (
      isIrExpressionStringBackedHaxe(expression.value, context) &&
      isIrExpressionStringBackedHaxe(expression.fallback, context)
    );
  }
  return false;
}

function isIrTypeStringBackedHaxe(
  type: Readonly<IrType>,
  context: EmitContext,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const concrete = getIrSingleConcreteTypeHaxe(type);
  if (concrete.kind === 'primitive') return concrete.name === 'string';
  if (concrete.kind === 'literal') return typeof concrete.value === 'string';
  if (concrete.kind === 'union')
    return concrete.types.every((member) => isIrTypeStringBackedHaxe(member, context, seen));
  if (concrete.kind === 'named' && concrete.reference.kind === 'ambient') {
    return ['GPUPowerPreference', 'WebGLPowerPreference'].includes(concrete.reference.name);
  }
  if (concrete.kind !== 'named' || concrete.reference.kind !== 'binding') return false;
  const target = getIrNamedDeclarationTargetHaxe(concrete, context);
  if (!target || target.declaration.kind !== 'typeAlias' || seen.has(target.binding.id)) return false;
  const substituted = resolveIrTypeStructuralSubstitution(
    target.declaration.type,
    createIrTypeParameterSubstitutionPlan(target.declaration.typeParameters, concrete.typeArguments),
  );
  return isIrTypeStringBackedHaxe(substituted, context, new Set(seen).add(target.binding.id));
}

function emitFacadeTypeAliasHaxe(
  targetName: string,
  target: Readonly<{
    binding: IrBindingIdentity | IrTypeBindingIdentity;
    declaration: Readonly<IrDeclaration>;
    module: Readonly<IrModule>;
  }>,
  context: EmitContext,
): string {
  const parameters = getHaxeTypeDeclarationParameters(target.declaration);
  const declarationParameters = emitFacadeTypeParametersHaxe(parameters, target.module, context);
  const arguments_ = parameters.map((parameter) =>
    getSourceBindingTargetNameHaxe(target.module, parameter.binding, context),
  );
  const source = `${getHaxeModulePath(target.module, context.options)}.${getSourceBindingTargetNameHaxe(target.module, target.binding, context)}`;
  return `typedef ${targetName}${declarationParameters} = ${source}${arguments_.length > 0 ? `<${arguments_.join(', ')}>` : ''};`;
}

function getHaxeTypeDeclarationParameters(declaration: Readonly<IrDeclaration>): readonly Readonly<IrTypeParameter>[] {
  return declaration.kind === 'class' || declaration.kind === 'interface' || declaration.kind === 'typeAlias'
    ? declaration.typeParameters
    : [];
}

function emitFacadeTypeParametersHaxe(
  parameters: readonly Readonly<IrTypeParameter>[],
  module: Readonly<IrModule>,
  context: EmitContext,
  includeDefaults = true,
): string {
  if (parameters.length === 0) return '';
  return `<${parameters
    .map((parameter) => {
      const name = getSourceBindingTargetNameHaxe(module, parameter.binding, context);
      const constraint =
        parameter.constraint &&
        parameter.constraint.kind !== 'function' &&
        !isEntityConstraintHaxeInModule(parameter.constraint, module)
          ? `:${emitFacadeTypeHaxe(parameter.constraint, module, context)}`
          : '';
      const default_ =
        includeDefaults && parameter.default ? ` = ${emitFacadeTypeHaxe(parameter.default, module, context)}` : '';
      return `${name}${constraint}${default_}`;
    })
    .join(', ')}>`;
}

function emitFacadeTypeHaxe(type: Readonly<IrType>, module: Readonly<IrModule>, context: EmitContext): string {
  const moduleContext: EmitContext = {
    ...context,
    module,
    packageName: convertPackageNameToHaxePackageName(module.packageName, context.options.rootPackage),
    targetNames:
      context.sourceModuleTargetNames.get(getHaxeCompilerModuleKey(module)) ?? createIrModuleTargetNamesHaxe(module),
  };
  return emitIrTypeHaxe(type, {
    fail: (message) => emissionError(context, message),
    getBindingName: (binding) => {
      const facadeName = context.facadeBindingTargetNames.get(binding.id);
      if (facadeName) return facadeName;
      if (binding.kind === 'typeParameter') {
        return getSourceBindingTargetNameHaxe(module, binding, context);
      }
      const localDeclaration = module.declarations.find(
        (declaration) => 'binding' in declaration && declaration.binding.id === binding.id,
      );
      if (localDeclaration && 'binding' in localDeclaration) {
        return `${getHaxeModulePath(module, context.options)}.${getSourceBindingTargetNameHaxe(module, localDeclaration.binding, context)}`;
      }
      for (const imported of module.imports) {
        const importedBinding = imported.bindings.find((candidate) => candidate.binding.id === binding.id);
        if (!importedBinding) continue;
        const forwardedTarget = getLocalImportedExportTargetHaxe(
          imported.specifier,
          importedBinding.imported,
          importedBinding.binding.space,
          moduleContext,
        );
        const modulePath =
          forwardedTarget?.modulePath ?? haxeImportModule(imported.specifier, moduleContext, importedBinding.imported);
        const importedName =
          forwardedTarget?.importedName ?? getImportedTargetNameHaxe(imported, importedBinding, moduleContext);
        return `${modulePath}.${importedName}`;
      }
      return binding.space === 'type' || binding.kind === 'class' || binding.kind === 'enum'
        ? safeHaxeTypeName(binding.name)
        : safeHaxeName(binding.name);
    },
    getExternalTypeName: (name) =>
      getCompilerRuntimeExternalSymbolTargetHaxe(name, 'type', context.options.runtimeModule),
    getMemberName: safeHaxeName,
    getTypeName: safeHaxeTypeName,
  });
}

function createFacadeSourceContextHaxe(module: Readonly<IrModule>, context: EmitContext): EmitContext {
  const targetNames =
    context.sourceModuleTargetNames.get(getHaxeCompilerModuleKey(module)) ?? createIrModuleTargetNamesHaxe(module);
  const moduleFacade = context.getModuleFacade?.(module);
  const facadeTypeTargetNames = getHaxeFacadeTypeTargetNames(module, context);
  const qualifiedBindings = new Map<string, string>();
  for (const imported of module.imports) {
    for (const binding of imported.bindings) {
      if (binding.imported === '*' || binding.imported === 'default') continue;
      const moduleContext = {
        ...context,
        module,
        packageName: convertPackageNameToHaxePackageName(module.packageName, context.options.rootPackage),
        targetNames,
      };
      const forwardedTarget = getLocalImportedExportTargetHaxe(
        imported.specifier,
        binding.imported,
        binding.binding.space,
        moduleContext,
      );
      qualifiedBindings.set(
        binding.binding.id,
        `${forwardedTarget?.modulePath ?? haxeImportModule(imported.specifier, moduleContext, binding.imported)}.${forwardedTarget?.importedName ?? getImportedTargetNameHaxe(imported, binding, moduleContext)}`,
      );
    }
  }
  for (const declaration of module.declarations) {
    if (!('binding' in declaration)) continue;
    qualifiedBindings.set(
      declaration.binding.id,
      `${getHaxeModulePath(module, context.options)}.${getSourceBindingTargetNameHaxe(module, declaration.binding, context)}`,
    );
  }
  return {
    ...context,
    ambientUtilityHeritageTargets: createAmbientUtilityHeritageTargetsHaxe(module),
    bindingTypes: collectIrModuleBindingTypesHaxe(module),
    facadeBindingTargetNames: qualifiedBindings,
    facadeTypeTargetNames,
    generatedNames: new Set([...targetNames.values(), ...facadeTypeTargetNames.values()]),
    machineNames: new Map(),
    module,
    moduleFacadeSlots:
      moduleFacade?.modules.find((candidate) => isHaxeCompilerModuleIdentityEqual(candidate.module, module))?.slots ??
      [],
    nullableBindingIds: collectIrModuleNullableBindingIds(module),
    packageName: convertPackageNameToHaxePackageName(module.packageName, context.options.rootPackage),
    targetNames,
  };
}

function collectIrModuleBindingTypesHaxe(module: Readonly<IrModule>): ReadonlyMap<string, IrType> {
  const bindingTypes = new Map<string, IrType>();
  analyzeIrModuleTraversal(module, {
    parameter(parameter) {
      bindingTypes.set(parameter.binding.id, parameter.type);
    },
    variable(variable) {
      if ('binding' in variable && variable.type) bindingTypes.set(variable.binding.id, variable.type);
    },
  });
  return bindingTypes;
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
      target.module,
      modulePath,
      context,
    );
  }
  if (target.declaration.kind === 'variable') {
    const type = target.declaration.type
      ? emitFacadeTypeHaxe(target.declaration.type, target.module, context)
      : 'Dynamic';
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
    return [emitFacadeTypeAliasHaxe(targetName, target, context)];
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
  sourceModule: Readonly<IrModule>,
  modulePath: string,
  context: EmitContext,
): string[] {
  const sourceContext = declaration.parameters.some((parameter) => parameter.initializer)
    ? createFacadeSourceContextHaxe(sourceModule, context)
    : undefined;
  const bodyContext = sourceContext
    ? { ...sourceContext, facadeBindingTargetNames: new Map(sourceContext.facadeBindingTargetNames) }
    : undefined;
  const initializers: string[] = [];
  const params = declaration.parameters
    .map((p) => {
      const name = getSourceBindingTargetNameHaxe(sourceModule, p.binding, context);
      const type =
        p.dependentCallablePack || hasIrDependentCallablePackHaxe(p.type)
          ? 'Dynamic'
          : emitFacadeTypeHaxe(p.type, sourceModule, context);
      if (p.rest) {
        const elementType = p.type.kind === 'array' ? emitFacadeTypeHaxe(p.type.element, sourceModule, context) : type;
        return `...${name}:${elementType}`;
      }
      if (p.initializer) {
        const effective = getGeneratedTargetNameHaxe(`${name}Default`, bodyContext!);
        const initializer = emitExpressionAsExpectedTypeHaxe(p.initializer, p.type, bodyContext!);
        initializers.push(
          `final ${effective}:${type} = js.Syntax.strictEq(${name}, js.Syntax.code("undefined")) ? ${initializer} : (cast ${name} : ${type});`,
        );
        bodyContext!.facadeBindingTargetNames.set(p.binding.id, effective);
        return `?${name}:${type}`;
      }
      return `${p.optional ? '?' : ''}${name}:${type}`;
    })
    .join(', ');
  const args = declaration.parameters
    .map(
      (parameter) =>
        `${parameter.rest ? '...' : ''}${bodyContext ? getBindingTargetNameHaxe(parameter.binding, bodyContext) : getSourceBindingTargetNameHaxe(sourceModule, parameter.binding, context)}`,
    )
    .join(', ');
  const returnType = emitFacadeTypeHaxe(declaration.returns, sourceModule, context);
  return [
    `function ${targetName}${emitFacadeTypeParametersHaxe(declaration.typeParameters, sourceModule, context, false)}(${params}):${returnType} {`,
    ...initializers.map((line) => `  ${line}`),
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
      const type = emitStructureFieldTypeHaxe(property.type, context);
      // An optional member has to be defaulted, because `@:structInit` reads a field's default as
      // permission to leave it out of the literal.
      return property.optional
        ? `  public var ${safeHaxeName(property.name)}:${hasIrTypeNullMemberHaxe(property.type) ? type : `Null<${type}>`} = null;`
        : `  public var ${safeHaxeName(property.name)}:${emitStructureFieldTypeHaxe(property.type, context)};`;
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
    return `public var ${name}:${emitStructureFieldTypeHaxe(property.type, context)};`;
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
  return `(cast ${inner} : ${emitType(expression.type, context)})`;
}

function emitIdentifierReferenceHaxe(reference: Readonly<IrIdentifierReference>, context: EmitContext): string {
  if (reference.kind === 'super') return 'super';
  if (reference.kind === 'this') return context.dynamicThis ? 'js.Syntax.code("this")' : 'this';
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
  if (typeof value === 'string') return emitHaxeStringLiteral(value);
  if (value === null) return 'null';
  return String(value);
}

function emitHaxeStringLiteral(value: string): string {
  let emitted = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (character === '"') emitted += '\\"';
    else if (character === '\\') emitted += '\\\\';
    else if (character === '\n') emitted += '\\n';
    else if (character === '\r') emitted += '\\r';
    else if (character === '\t') emitted += '\\t';
    else if (codePoint < 0x20 || codePoint === 0x7f) {
      emitted += `\\x${codePoint.toString(16).padStart(2, '0')}`;
    } else {
      emitted += character;
    }
  }
  return `${emitted}"`;
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
      const type =
        parameter.dependentCallablePack || hasIrDependentCallablePackHaxe(parameter.type)
          ? 'Dynamic'
          : emitType(parameter.type, context);
      if (type === 'Array<Dynamic>') context.dynamicBindingIds.add(parameter.binding.id);
      if (parameter.rest) {
        const elementType = parameter.type.kind === 'array' ? emitType(parameter.type.element, context) : type;
        return `...${name}:${elementType}`;
      }
      if (parameter.initializer) return `?${name}:${type}`;
      return `${parameter.optional ? '?' : ''}${name}:${type}`;
    })
    .join(', ');
}

function emitParametersWithInitializersHaxe(
  parameters: readonly IrParameter[],
  context: EmitContext,
): { context: EmitContext; initializers: string[]; signature: string } {
  const bodyContext: EmitContext = {
    ...context,
    facadeBindingTargetNames: new Map(context.facadeBindingTargetNames),
  };
  const initializers: string[] = [];
  for (const parameter of parameters) {
    const sourceName = getBindingTargetNameHaxe(parameter.binding, context);
    if (parameter.rest) {
      const targetName = getGeneratedTargetNameHaxe(`${sourceName}Array`, bodyContext);
      const type = emitType(parameter.type, bodyContext);
      initializers.push(`final ${targetName}:${type} = ${sourceName}.toArray();`);
      bodyContext.facadeBindingTargetNames.set(parameter.binding.id, targetName);
      continue;
    }
    if (!parameter.initializer) continue;
    const targetName = getGeneratedTargetNameHaxe(`${sourceName}Default`, bodyContext);
    const type =
      parameter.dependentCallablePack || hasIrDependentCallablePackHaxe(parameter.type)
        ? 'Dynamic'
        : emitType(parameter.type, bodyContext);
    const initializer = emitExpressionAsExpectedTypeHaxe(parameter.initializer, parameter.type, bodyContext);
    initializers.push(
      `final ${targetName}:${type} = js.Syntax.strictEq(${sourceName}, js.Syntax.code("undefined")) ? ${initializer} : (cast ${sourceName} : ${type});`,
    );
    bodyContext.facadeBindingTargetNames.set(parameter.binding.id, targetName);
  }
  return { context: bodyContext, initializers, signature: emitParameters(parameters, context) };
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
        `} while (${emitConditionHaxe(statement.condition, context)});`,
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
          `  for (${getBindingTargetNameHaxe(forInBinding, context)} in [${forInKeyPlan.keys.map(emitHaxeStringLiteral).join(', ')}]) {`,
          ...indentSourceLines(emitStatementBody(statement.body, context), 2),
          '  }',
          '}',
        ]);
      }
      return emitControlFlowBoundaryHaxe(statement.label, true, context, () => [
        `for (${getBindingTargetNameHaxe(forInBinding, context)} in ${forInKeyPlan ? `[${forInKeyPlan.keys.map(emitHaxeStringLiteral).join(', ')}]` : `${context.haxeReflectName}.fields(${emitExpression(statement.object, context)})`}) {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ]);
    case 'forOf':
      if (statement.await) emissionError(context, 'async iteration requires the Haxe async-lowering pass');
      if ('pattern' in statement.variable)
        emissionError(context, 'binding patterns require destructuring lowering before Haxe emission');
      const forOfBinding = statement.variable.binding;
      if (isIrExpressionStringHaxe(statement.iterable, context)) {
        const codePoint = getGeneratedTargetNameHaxe(`${forOfBinding.name}CodePoint`, context);
        return emitControlFlowBoundaryHaxe(statement.label, true, context, () => [
          `for (${codePoint} in new haxe.iterators.StringIteratorUnicode(${emitExpression(statement.iterable, context)})) {`,
          `  final ${getBindingTargetNameHaxe(forOfBinding, context)} = String.fromCharCode(${codePoint});`,
          ...indentSourceLines(emitStatementBody(statement.body, context)),
          '}',
        ]);
      }
      const iterable = emitForOfIterableHaxe(statement, context);
      return emitControlFlowBoundaryHaxe(statement.label, true, context, () => [
        `for (${getBindingTargetNameHaxe(forOfBinding, context)} in ${iterable}) {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ]);
    case 'if': {
      const lines = [
        `if (${emitConditionHaxe(statement.condition, context)}) {`,
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
            ? [`${completion.returnValueName} = ${emitReturnedExpressionHaxe(statement.expression, context)};`]
            : []),
          `${completion.returnedName} = true;`,
          `throw ${completion.returnSignalName};`,
        ];
      }
      return [`return${statement.expression ? ` ${emitReturnedExpressionHaxe(statement.expression, context)}` : ''};`];
    case 'switch': {
      if (statement.label) {
        emissionError(context, `labeled switch ${statement.label.name} requires Haxe switch completion lowering`);
      }
      if (statement.cases.some((clause) => clause.expression && clause.expression.kind !== 'literal')) {
        return emitConditionalSwitchHaxe(statement, context);
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
      if (!statement.cases.some((clause) => clause.expression === undefined)) {
        lines.push('  default: {}');
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
        `while (${emitConditionHaxe(statement.condition, context)}) {`,
        ...indentSourceLines(emitStatementBody(statement.body, context)),
        '}',
      ]);
  }
}

function emitConditionalSwitchHaxe(
  statement: Readonly<Extract<IrStatement, { kind: 'switch' }>>,
  context: EmitContext,
): string[] {
  const subject = getGeneratedTargetNameHaxe('switchSubject', context);
  const cases = statement.cases.filter((clause) => clause.expression);
  const defaultCase = statement.cases.find((clause) => !clause.expression);
  const lines = ['{', `  final ${subject} = ${emitExpression(statement.expression, context)};`];
  cases.forEach((clause, index) => {
    lines.push(
      `  ${index === 0 ? 'if' : 'else if'} (js.Syntax.strictEq(${subject}, ${emitExpression(clause.expression!, context)})) {`,
      ...indentSourceLines(
        emitStatements(
          clause.statements.filter((item) => item.kind !== 'break'),
          context,
        ),
        2,
      ),
      '  }',
    );
  });
  if (defaultCase) {
    lines.push(
      `  ${cases.length > 0 ? 'else ' : ''}{`,
      ...indentSourceLines(
        emitStatements(
          defaultCase.statements.filter((item) => item.kind !== 'break'),
          context,
        ),
        2,
      ),
      '  }',
    );
  }
  lines.push('}');
  return lines;
}

function emitForOfIterableHaxe(
  statement: Readonly<Extract<IrStatement, { kind: 'forOf' }>>,
  context: EmitContext,
): string {
  const emitted = emitExpression(statement.iterable, context);
  const elementType =
    'pattern' in statement.variable || !statement.variable.type
      ? 'Dynamic'
      : emitType(statement.variable.type, context);
  const iterableType = statement.iterableType;
  if (!iterableType) return `(cast ${emitted} : Iterable<${elementType}>)`;
  const targetType = emitType(iterableType, context);
  if (targetType === 'Dynamic') return `(cast ${emitted} : Iterable<${elementType}>)`;
  if (targetType === 'Iterator' || targetType.startsWith('Iterator<')) {
    return `(cast ${emitted} : Iterator<${elementType}>)`;
  }
  const receiverType =
    statement.iterable.kind === 'property'
      ? getIrExpressionTypeHaxe(statement.iterable.object, context)
      : statement.iterable.kind === 'element'
        ? getIrExpressionTypeHaxe(statement.iterable.object, context)
        : undefined;
  const receiverLosesStaticType = receiverType !== undefined && isIrTypeReflectiveHaxe(receiverType, context);
  const needsIterableProof =
    (iterableType.kind === 'named' &&
      iterableType.reference.kind === 'ambient' &&
      ['Iterable', 'Map', 'ReadonlyMap', 'ReadonlySet', 'Set'].includes(iterableType.reference.name)) ||
    receiverLosesStaticType ||
    statement.iterable.kind === 'property';
  // A property read from a union, generic, or structurally erased owner is Dynamic in Haxe even
  // when the checker proved its member iterable. Carry only that otherwise-lost proof; direct Array
  // and typed-array expressions already satisfy Haxe's for-loop protocol without an extra cast.
  return needsIterableProof ? `(cast ${emitted} : Iterable<${elementType}>)` : emitted;
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
  const declarations = statements.flatMap((statement, statementIndex) =>
    statement.kind === 'variable'
      ? statement.declarations.flatMap((variable) => ('binding' in variable ? [{ statementIndex, variable }] : []))
      : [],
  );
  const forward = declarations.filter(({ statementIndex, variable }) => {
    if (variable.initializer) {
      let selfCaptured = false;
      analyzeIrExpressionSubtreeTraversal(variable.initializer, {
        expression(expression) {
          if (
            expression.kind === 'identifier' &&
            expression.reference.kind === 'binding' &&
            expression.reference.binding.id === variable.binding.id
          ) {
            selfCaptured = true;
            return false;
          }
          return undefined;
        },
      });
      if (selfCaptured) return true;
    }
    for (let index = 0; index < statementIndex; index += 1) {
      let found = false;
      analyzeIrStatementSubtreeTraversal(statements[index]!, {
        expression(expression) {
          if (
            expression.kind === 'identifier' &&
            expression.reference.kind === 'binding' &&
            expression.reference.binding.id === variable.binding.id
          ) {
            found = true;
            return false;
          }
          return undefined;
        },
      });
      if (found) return true;
    }
    return false;
  });
  const ids = new Set(forward.map(({ variable }) => variable.binding.id));
  const bodyContext: EmitContext = forward.length === 0 ? context : { ...context, forwardDeclaredBindingIds: ids };
  const prefix = forward.map(({ variable }) => {
    const type = variable.type ? emitType(variable.type, bodyContext) : 'Dynamic';
    // These declarations precede a closure that captures the binding; source evaluation assigns
    // them before the closure can be invoked, but Haxe checks the closure at its declaration and
    // reports WVarInit. JavaScript bindings occupy `undefined` until that source assignment, so an
    // explicit target initialization preserves the state while carrying the source ordering proof.
    return `var ${getBindingTargetNameHaxe(variable.binding, bodyContext)}:${type} = js.Syntax.code("undefined");`;
  });
  return [...prefix, ...statements.flatMap((statement) => emitStatement(statement, bodyContext)).filter(Boolean)];
}

function emitFunctionStatementsHaxe(statements: readonly IrStatement[], context: EmitContext): string[] {
  const emitted = emitStatements(statements, context);
  const returnType = context.returnType ? emitType(context.returnType, context) : undefined;
  const canCompleteNormally = getIrStatementListCompletionSet(statements).completions.some(
    (completion) => completion.kind === 'normal',
  );
  if (!returnType || returnType === 'Void') return emitted;
  if (!canCompleteNormally) {
    const finalLine = emitted.at(-1)?.trimStart();
    if (finalLine?.startsWith('return') || finalLine?.startsWith('throw')) return emitted;
    // Completion-record lowering can make a source-level guaranteed return conditional in target
    // syntax. The IR proof says this point is unreachable, but Haxe's local analysis cannot recover
    // that proof from the synthetic finally flags. Keep the target fail-loud while satisfying its
    // non-void control-flow check.
    return [...emitted, 'throw new haxe.Exception("unreachable control flow");'];
  }
  return [...emitted, context.returnsAbsent ? 'return null;' : 'return cast(js.Syntax.code("undefined"));'];
}

function emitType(type: Readonly<IrType>, context: EmitContext): string {
  return emitIrTypeHaxe(type, {
    fail: (message) => emissionError(context, message),
    getBindingName: (binding) => getBindingTargetNameHaxe(binding, context),
    getExternalTypeName: (name) =>
      getCompilerRuntimeExternalSymbolTargetHaxe(name, 'type', context.options.runtimeModule),
    getMemberName: safeHaxeName,
    getTypeName: safeHaxeTypeName,
    resolveNamedType: (named) => {
      if (named.reference.kind !== 'binding') return undefined;
      const imported =
        context.importedTypeTargetNames.get(named.reference.binding.id) ??
        getForeignNamedTypeLocalTargetHaxe(named, context) ??
        getImportedNamedTypeLocalTargetByNameHaxe(named, context);
      return imported ? [imported, ...named.reference.path.map(safeHaxeTypeName)].join('.') : undefined;
    },
  });
}

function getImportedNamedTypeLocalTargetByNameHaxe(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  context: EmitContext,
): string | undefined {
  if (type.reference.kind !== 'binding') return undefined;
  const candidates = new Set<string>();
  for (const imported of context.module.imports) {
    for (const binding of imported.bindings) {
      if (binding.binding.name !== type.reference.binding.name) continue;
      const target =
        context.importedTypeTargetNames.get(binding.binding.id) ??
        context.facadeBindingTargetNames.get(binding.binding.id);
      if (target) candidates.add(target);
    }
  }
  // A name-only recovery is safe only when this module has one imported target for that spelling.
  // Distinct same-named imports remain an allocation error instead of being guessed here.
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function getForeignNamedTypeLocalTargetHaxe(
  type: Readonly<Extract<IrType, { kind: 'named' }>>,
  context: EmitContext,
): string | undefined {
  if (type.reference.kind !== 'binding') return undefined;
  const cacheKey = JSON.stringify([getHaxeCompilerModuleKey(context.module), type.reference.binding.id]);
  if (context.foreignNamedTypeLocalTargetNames.has(cacheKey)) {
    return context.foreignNamedTypeLocalTargetNames.get(cacheKey) ?? undefined;
  }
  const target = getIrNamedDeclarationTargetHaxe(type, context);
  if (!target) {
    context.foreignNamedTypeLocalTargetNames.set(cacheKey, null);
    return undefined;
  }
  for (const imported of context.module.imports) {
    for (const binding of imported.bindings) {
      if (binding.binding.space !== 'type' || binding.imported === '*' || binding.imported === 'default') continue;
      const localType = {
        kind: 'named',
        reference: { binding: binding.binding, kind: 'binding', path: [] },
        typeArguments: [],
      } as const;
      const importedTarget = getIrNamedDeclarationTargetHaxe(localType, context);
      if (importedTarget?.binding.id !== target.binding.id) continue;
      const targetName =
        context.importedTypeTargetNames.get(binding.binding.id) ??
        context.facadeBindingTargetNames.get(binding.binding.id) ??
        getBindingTargetNameHaxe(binding.binding, context);
      context.foreignNamedTypeLocalTargetNames.set(cacheKey, targetName);
      return targetName;
    }
  }
  if (isHaxeCompilerModuleIdentityEqual(target.module, context.module)) {
    context.foreignNamedTypeLocalTargetNames.set(cacheKey, null);
    return undefined;
  }
  const qualified = `${getHaxeModulePath(target.module, context.options)}.${getSourceBindingTargetNameHaxe(target.module, target.binding, context)}`;
  context.foreignNamedTypeLocalTargetNames.set(cacheKey, qualified);
  return qualified;
}

function getIrExpressionTypeHaxe(
  expression: Readonly<IrExpression>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  switch (expression.kind) {
    case 'array':
      return expression.type;
    case 'binary':
      return expression.semantics.result === 'boolean' ||
        expression.semantics.result === 'number' ||
        expression.semantics.result === 'string'
        ? { kind: 'primitive', name: expression.semantics.result }
        : undefined;
    case 'cast':
      return expression.type;
    case 'call':
      return expression.semantics.resultType;
    case 'element': {
      const objectType = getIrExpressionTypeHaxe(expression.object, context);
      return objectType ? getIrIndexedElementTypeHaxe(objectType, expression.index, context) : undefined;
    }
    case 'function':
      return {
        kind: 'function',
        parameters: expression.parameters.map((parameter) =>
          parameter.rest
            ? { name: parameter.binding.name, optional: false, rest: true, type: parameter.type }
            : parameter.optional
              ? { name: parameter.binding.name, optional: true, rest: false, type: parameter.type }
              : { name: parameter.binding.name, optional: false, rest: false, type: parameter.type },
        ),
        returns: expression.returns,
        typeParameters: expression.typeParameters,
      };
    case 'identifier':
      return expression.reference.kind === 'binding'
        ? (context.bindingTypes.get(expression.reference.binding.id) ??
            getIrImportedOrModuleBindingTypeHaxe(expression.reference.binding, context))
        : undefined;
    case 'literal':
      return expression.value === null
        ? { kind: 'null' }
        : typeof expression.value === 'boolean'
          ? { kind: 'primitive', name: 'boolean' }
          : typeof expression.value === 'number'
            ? { kind: 'primitive', name: 'number' }
            : { kind: 'primitive', name: 'string' };
    case 'new':
      if (expression.callee.kind !== 'identifier' || expression.callee.reference.kind !== 'ambient') return undefined;
      if (expression.callee.reference.name === 'Array' && expression.typeArguments[0]) {
        return { element: expression.typeArguments[0], kind: 'array', readonly: false };
      }
      return haxeConstructedAmbientValueTypeNames.has(expression.callee.reference.name)
        ? { kind: 'named', reference: expression.callee.reference, typeArguments: [] }
        : undefined;
    case 'property':
      if (expression.member?.name === 'length') return { kind: 'primitive', name: 'number' };
      {
        const objectType = getIrExpressionTypeHaxe(expression.object, context);
        const declaredType = objectType ? getIrObjectPropertyTypeHaxe(objectType, expression.name, context) : undefined;
        return declaredType ?? expression.type;
      }
    case 'tuple':
      return {
        elements: expression.elements.map((element) => ({
          optional: element.optional,
          rest: false,
          type: element.expression
            ? (getIrExpressionTypeHaxe(element.expression, context) ?? { kind: 'unknown', source: 'unknown' })
            : { kind: 'undefined' },
        })),
        kind: 'tuple',
        readonly: false,
      };
    case 'tupleSpread':
      return expression.type;
    case 'unary':
      return expression.semantics.result === 'boolean' ||
        expression.semantics.result === 'number' ||
        expression.semantics.result === 'string'
        ? { kind: 'primitive', name: expression.semantics.result }
        : undefined;
    case 'undefinedValue':
      return expression.type;
    default:
      return undefined;
  }
}

function getIrIndexedElementTypeHaxe(
  type: Readonly<IrType>,
  index: Readonly<IrExpression>,
  context: EmitContext,
  seen: ReadonlySet<string> = new Set(),
): Readonly<IrType> | undefined {
  const concrete = getIrSingleConcreteTypeHaxe(type);
  if (concrete.kind === 'array') return concrete.element;
  if (concrete.kind === 'tuple') {
    if (index.kind === 'literal' && typeof index.value === 'number' && Number.isInteger(index.value)) {
      return concrete.elements[index.value]?.type;
    }
    const members = concrete.elements.map((element) => element.type);
    return members.length === 1
      ? members[0]
      : members.length > 1
        ? { kind: 'union', types: members as [IrType, IrType, ...IrType[]] }
        : undefined;
  }
  if (concrete.kind !== 'named') return undefined;
  if (concrete.reference.kind === 'ambient') {
    if (['Record', 'ReadonlyRecord'].includes(concrete.reference.name)) return concrete.typeArguments[1];
    if (['Partial', 'Readonly', 'Required'].includes(concrete.reference.name) && concrete.typeArguments[0]) {
      return getIrIndexedElementTypeHaxe(concrete.typeArguments[0], index, context, seen);
    }
    if (haxeConstructedAmbientValueTypeNames.has(concrete.reference.name)) {
      return { kind: 'primitive', name: 'number' };
    }
    return undefined;
  }
  const target = getIrNamedDeclarationTargetHaxe(concrete, context);
  if (!target || target.declaration.kind !== 'typeAlias' || seen.has(target.binding.id)) return undefined;
  const substituted = resolveIrTypeStructuralSubstitution(
    target.declaration.type,
    createIrTypeParameterSubstitutionPlan(target.declaration.typeParameters, concrete.typeArguments),
  );
  return getIrIndexedElementTypeHaxe(substituted, index, context, new Set(seen).add(target.binding.id));
}

function isHaxeMapIteratorResultValueHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'property' }>>,
  context: EmitContext,
): boolean {
  if (
    expression.object.kind !== 'call' ||
    expression.object.arguments.length !== 0 ||
    expression.object.callee.kind !== 'property' ||
    expression.object.callee.name !== 'next'
  ) {
    return false;
  }
  return isHaxeMapIteratorFactoryCallHaxe(expression.object.callee.object, context);
}

function isHaxeMapIteratorNextCallHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context?: EmitContext,
): expression is Readonly<Extract<IrExpression, { kind: 'call' }>> & {
  callee: Readonly<Extract<IrExpression, { kind: 'property' }>>;
} {
  if (expression.arguments.length !== 0 || expression.callee.kind !== 'property' || expression.callee.name !== 'next') {
    return false;
  }
  const iterator = expression.callee.object;
  if (!context) {
    return (
      iterator.kind === 'call' && iterator.callee.kind === 'property' && iterator.callee.member?.receiver === 'map'
    );
  }
  return isHaxeMapIteratorFactoryCallHaxe(iterator, context);
}

function isHaxeMapIteratorFactoryCallHaxe(iterator: Readonly<IrExpression>, context: EmitContext): boolean {
  return (
    iterator.kind === 'call' &&
    iterator.arguments.length === 0 &&
    iterator.callee.kind === 'property' &&
    ['entries', 'keys', 'values'].includes(iterator.callee.name) &&
    (iterator.callee.member?.receiver === 'map' ||
      ['Map', 'ReadonlyMap'].includes(getIrExpressionAmbientTypeNameHaxe(iterator.callee.object, context) ?? ''))
  );
}

function isIrArrayExpressionHaxe(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  const type = getIrExpressionTypeHaxe(expression, context);
  if (type && ['array', 'tuple'].includes(getIrSingleConcreteTypeHaxe(type).kind)) return true;
  if (expression.kind !== 'call' || expression.callee.kind !== 'property') return false;
  if (expression.callee.member?.receiver === 'array') return true;
  return (
    ['concat', 'copy', 'filter', 'flat', 'flatMap', 'map', 'slice', 'splice'].includes(expression.callee.name) &&
    isIrArrayExpressionHaxe(expression.callee.object, context)
  );
}

function getIrImportedOrModuleBindingTypeHaxe(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  context: EmitContext,
): Readonly<IrType> | undefined {
  const local = context.module.declarations.find(
    (declaration) => 'binding' in declaration && declaration.binding.id === binding.id,
  );
  if (local?.kind === 'variable') return local.type;
  if (local?.kind === 'function') return getIrFunctionDeclarationTypeHaxe(local);
  const imported = context.module.imports
    .flatMap((entry) => entry.bindings.map((candidate) => ({ candidate, entry })))
    .find(({ candidate }) => candidate.binding.id === binding.id);
  if (!imported) return undefined;
  const sourceModule = getHaxeResolvedImportModule(imported.entry.specifier, context, imported.candidate.imported);
  if (!sourceModule) return undefined;
  const direct = sourceModule.declarations.find(
    (declaration) => 'binding' in declaration && declaration.binding.name === imported.candidate.imported,
  );
  if (direct?.kind === 'variable') return direct.type;
  if (direct?.kind === 'function') return getIrFunctionDeclarationTypeHaxe(direct);
  const facade = context.getModuleFacade?.(sourceModule);
  const slot = facade?.modules
    .find((module) => isHaxeCompilerModuleIdentityEqual(module.module, sourceModule))
    ?.slots.find((candidate) => candidate.exportName === imported.candidate.imported && candidate.lane === 'value');
  if (!slot || (slot.source.kind !== 'module-all' && slot.source.kind !== 'module-binding')) return undefined;
  const target = getModuleFacadeBindingTargetHaxe(slot, context);
  return target.declaration.kind === 'variable'
    ? target.declaration.type
    : target.declaration.kind === 'function'
      ? getIrFunctionDeclarationTypeHaxe(target.declaration)
      : undefined;
}

function getIrFunctionDeclarationTypeHaxe(declaration: Readonly<IrFunctionDeclaration>): Readonly<IrType> {
  return {
    kind: 'function',
    parameters: declaration.parameters.map((parameter) =>
      parameter.rest
        ? { name: parameter.binding.name, optional: false, rest: true, type: parameter.type }
        : parameter.optional
          ? { name: parameter.binding.name, optional: true, rest: false, type: parameter.type }
          : { name: parameter.binding.name, optional: false, rest: false, type: parameter.type },
    ),
    returns: declaration.returns,
    typeParameters: declaration.typeParameters,
  };
}

const haxeStringReturningAmbientMethods = new Set([
  'charAt',
  'concat',
  'padEnd',
  'padStart',
  'repeat',
  'replace',
  'replaceAll',
  'slice',
  'substring',
  'toLowerCase',
  'toUpperCase',
  'trim',
]);

function isIrExpressionStringHaxe(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  const type = getIrExpressionTypeHaxe(expression, context);
  if (type?.kind === 'primitive' && type.name === 'string') return true;
  return (
    expression.kind === 'call' &&
    expression.callee.kind === 'property' &&
    expression.callee.member?.receiver === 'string' &&
    haxeStringReturningAmbientMethods.has(expression.callee.member.name)
  );
}

function emitConditionalExpressionHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'conditional' }>>,
  context: EmitContext,
): string {
  const branchTypes = new Set([
    ...getIrConditionalBranchTypesHaxe(expression.whenTrue, context),
    ...getIrConditionalBranchTypesHaxe(expression.whenFalse, context),
  ]);
  const whenTrue = emitExpression(expression.whenTrue, context);
  const whenFalse = emitExpression(expression.whenFalse, context);
  const objectMembersDiffer =
    expression.whenTrue.kind === 'object' &&
    expression.whenFalse.kind === 'object' &&
    getIrObjectExpressionMemberShapeHaxe(expression.whenTrue) !==
      getIrObjectExpressionMemberShapeHaxe(expression.whenFalse);
  const eraseBranches = branchTypes.size > 1 || objectMembersDiffer;
  return `(${emitConditionHaxe(expression.condition, context)} ? ${eraseBranches ? `(cast ${whenTrue} : Dynamic)` : whenTrue} : ${eraseBranches ? `(cast ${whenFalse} : Dynamic)` : whenFalse})`;
}

function getIrObjectExpressionMemberShapeHaxe(expression: Readonly<IrObjectExpression>): string {
  return expression.members
    .map((member) =>
      member.kind === 'property' || member.kind === 'getAccessor' ? `${member.kind}:${member.name}` : member.kind,
    )
    .sort()
    .join('|');
}

function getIrConditionalBranchTypesHaxe(expression: Readonly<IrExpression>, context: EmitContext): readonly string[] {
  if (expression.kind === 'conditional') {
    return [
      ...getIrConditionalBranchTypesHaxe(expression.whenTrue, context),
      ...getIrConditionalBranchTypesHaxe(expression.whenFalse, context),
    ];
  }
  const type = getIrExpressionTypeHaxe(expression, context);
  return type ? [emitType(getIrSingleConcreteTypeHaxe(type), context)] : [];
}

function emitConditionHaxe(expression: Readonly<IrExpression>, context: EmitContext): string {
  if (isIrExpressionBooleanHaxe(expression, context)) {
    return normalizeHaxeExpressionGrouping(emitExpression(expression, context));
  }
  const runtime = `${context.options.runtimeModule ?? 'flighthq._internal'}._Js`;
  return `${runtime}.truthy(${normalizeHaxeExpressionGrouping(emitExpression(expression, context))})`;
}

// A typed Haxe expression is valid only while its annotation remains grouped. The shared source
// normalizer normally removes a redundant outer pair in assignment/return/condition positions, but
// both `(cast value : Type)` and `(value : Type)` use that pair as grammar rather than precedence.
function normalizeHaxeExpressionGrouping(source: string): string {
  return source.endsWith(')') && (source.startsWith('(cast ') || source.includes(' : '))
    ? source
    : normalizeSourceTextGrouping(source);
}

function isIrExpressionBooleanHaxe(expression: Readonly<IrExpression>, context: EmitContext): boolean {
  if (expression.kind === 'binary' || expression.kind === 'unary') return expression.semantics.result === 'boolean';
  const type = getIrExpressionTypeHaxe(expression, context);
  return (
    (type?.kind === 'primitive' && type.name === 'boolean') ||
    (type?.kind === 'literal' && typeof type.value === 'boolean')
  );
}

function emitStructureFieldTypeHaxe(type: Readonly<IrType>, context: EmitContext): string {
  return type.kind === 'primitive' && type.name === 'void' ? 'Dynamic' : emitType(type, context);
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

function emitHaxeIntegerArgument(expression: Readonly<IrExpression>, emitted: string, context: EmitContext): string {
  const type = getIrExpressionTypeHaxe(expression, context);
  return type && hasIrTypeAbsentMemberHaxe(type, context.module) ? `Std.int(cast(${emitted}))` : `Std.int(${emitted})`;
}

function emitNewArgumentsHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'new' }>>,
  context: EmitContext,
): string[] {
  const ambientConstructorName =
    expression.callee.kind === 'identifier' && expression.callee.reference.kind === 'ambient'
      ? expression.callee.reference.name
      : undefined;
  const integerLengthConstructor =
    ambientConstructorName !== undefined && haxeIntegerLengthConstructorNames.has(ambientConstructorName);
  const integerArguments = ambientConstructorName
    ? (haxeNativeConstructorIntArgumentPositions.get(ambientConstructorName) ?? [])
    : [];
  const castArguments = ambientConstructorName
    ? (haxeNativeConstructorCastArgumentPositions.get(ambientConstructorName) ?? [])
    : [];
  if (
    expression.arguments.length === 0 &&
    ambientConstructorName !== undefined &&
    haxeZeroLengthTypedArrayConstructorNames.has(ambientConstructorName)
  ) {
    return ['0'];
  }
  return expression.arguments.map((argument, index) => {
    const emitted = emitExpression(argument, context);
    const type = getIrExpressionTypeHaxe(argument, context);
    if (castArguments.includes(index)) return `cast(${emitted})`;
    if (
      index === 0 &&
      expression.callee.kind === 'identifier' &&
      expression.callee.reference.kind === 'ambient' &&
      haxeIntegerTypedArrayConstructorNames.has(expression.callee.reference.name) &&
      type?.kind === 'array'
    ) {
      return `cast(${emitted})`;
    }
    return (integerArguments.includes(index) || (integerLengthConstructor && index === 0)) &&
      type?.kind === 'primitive' &&
      type.name === 'number'
      ? `Std.int(${emitted})`
      : emitted;
  });
}

const haxeNativeConstructorIntArgumentPositions = new Map<string, readonly number[]>([['ImageData', [1, 2]]]);

const haxeNativeConstructorCastArgumentPositions = new Map<string, readonly number[]>([
  ['AudioBuffer', [0]],
  ['Proxy', [1]],
]);

const haxeGlobalFunctionIntArgumentPositions = new Map<string, readonly number[]>([
  ['cancelAnimationFrame', [0]],
  ['clearInterval', [0]],
  ['clearTimeout', [0]],
  ['setInterval', [1]],
  ['setTimeout', [1]],
]);

const haxeNativeMethodIntArgumentPositions = new Map<string, readonly number[]>([
  ['AudioBuffer.copyToChannel', [1]],
  ['AudioBuffer.getChannelData', [0]],
  ['Element.releasePointerCapture', [0]],
  ['Element.setPointerCapture', [0]],
  ['HTMLElement.releasePointerCapture', [0]],
  ['HTMLElement.setPointerCapture', [0]],
  ['Window.cancelAnimationFrame', [0]],
  ['Window.clearInterval', [0]],
  ['Window.clearTimeout', [0]],
  ['Window.setInterval', [1]],
  ['Window.setTimeout', [1]],
  ['WebSocket.close', [0]],
]);

const haxeNativeSyntaxConstantExpressions = new Map<string, string>([
  ['Math.SQRT1_2', 'Math.sqrt(0.5)'],
  ['Math.SQRT2', 'Math.sqrt(2.0)'],
]);

const haxeNativeSyntaxMethods = new Set([
  'CanvasRenderingContext2D.clip',
  'CanvasRenderingContext2D.getContextAttributes',
  'CanvasRenderingContext2D.getTransform',
  'CanvasRenderingContext2D.roundRect',
  'Element.getContext',
  'Intl.PluralRules.select',
]);

const haxeNativeSyntaxProperties = new Set([
  'CanvasRenderingContext2D.globalCompositeOperation',
  'CanvasRenderingContext2D.imageSmoothingQuality',
  'CanvasRenderingContext2D.roundRect',
  'HTMLCanvasElement.prototype',
  'Navigator.gpu',
  'Navigator.wakeLock',
  'WebSocket.binaryType',
]);

const haxeNativeSyntaxWritableProperties = new Set([
  'CanvasRenderingContext2D.globalCompositeOperation',
  'CanvasRenderingContext2D.imageSmoothingQuality',
  'WebSocket.binaryType',
]);

const haxeNativeValueOwnerNames = new Map<string, string>([
  ['document', 'Document'],
  ['navigator', 'Navigator'],
  ['window', 'Window'],
]);

const haxeNativeTargetOwnerNames = new Map<string, string>([
  ['flighthq._internal._IntlPluralRules', 'Intl.PluralRules'],
  ['js.html.CanvasElement', 'HTMLCanvasElement'],
  ['js.html.CanvasRenderingContext2D', 'CanvasRenderingContext2D'],
  ['js.html.Element', 'Element'],
  ['js.html.Navigator', 'Navigator'],
  ['js.html.WebSocket', 'WebSocket'],
  ['js.html.Window', 'Window'],
]);

const haxeNativeIntegerProperties = new Set([
  'HTMLCanvasElement.height',
  'HTMLCanvasElement.width',
  'HTMLImageElement.height',
  'HTMLImageElement.width',
]);

const haxeIntegerLengthConstructorNames = new Set([
  'Array',
  'ArrayBuffer',
  'Float32Array',
  'Float64Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
]);

const haxeIntegerTypedArrayConstructorNames = new Set([
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
]);

const haxeZeroLengthTypedArrayConstructorNames = new Set([
  'BigInt64Array',
  'BigUint64Array',
  'Float32Array',
  'Float64Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
]);

// A spread of an unbounded collection has no arity until run time, so the call itself becomes a
// reflective one: Haxe's reflection helper takes the arguments as an array, which is exactly the
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
      if (fixed.length > 0) groups.push(`([${fixed.join(', ')}] : Array<Dynamic>)`);
      fixed = [];
      groups.push(`(cast ${emitExpression(argument.expression, context)} : Array<Dynamic>)`);
      continue;
    }
    fixed.push(emitExpression(argument, context));
  }
  if (fixed.length > 0) groups.push(`([${fixed.join(', ')}] : Array<Dynamic>)`);
  const args =
    groups.length === 1
      ? groups[0]!
      : `${groups[0]!}${groups
          .slice(1)
          .map((group) => `.concat(${group})`)
          .join('')}`;
  const receiver = expression.callee.kind === 'property' ? emitExpression(expression.callee.object, context) : 'null';
  return `${context.haxeReflectName}.callMethod(${receiver}, cast(${emitExpression(expression.callee, context)}), ${args})`;
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
    ...members.map(({ name, value }) => `  var ${name} = ${emitHaxeStringLiteral(value)};`),
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
  if (
    object?.kind === 'identifier' &&
    object.reference.kind === 'binding' &&
    context.dynamicBindingIds.has(object.reference.binding.id)
  ) {
    return true;
  }
  const objectType = object ? getIrExpressionTypeHaxe(object, context) : undefined;
  if (!objectType) return false;
  const target = emitType(getIrSingleConcreteTypeHaxe(objectType), context);
  return target === 'Dynamic' || target === 'Array<Dynamic>';
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

function getIrNarrowedMemberTypeHaxe(
  type: Readonly<IrType> | undefined,
  name: string,
  context: EmitContext,
  seen: ReadonlySet<string> = new Set(),
): Readonly<IrType> | undefined {
  if (!type) return undefined;
  if (type.kind === 'union') {
    const matches = type.types.flatMap((member) => {
      const match = getIrNarrowedMemberTypeHaxe(member, name, context, seen);
      return match ? [match] : [];
    });
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (
    type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    (type.reference.name === 'Readonly' || type.reference.name === 'Required') &&
    type.typeArguments.length === 1
  ) {
    return getIrNarrowedMemberTypeHaxe(type.typeArguments[0], name, context, seen);
  }
  if (type.kind === 'primitive') return type.name === name ? type : undefined;
  if (type.kind !== 'named' || type.reference.kind !== 'binding') return undefined;
  if (type.reference.binding.name === name) return type;
  const target = getIrNamedDeclarationTargetHaxe(type, context);
  if (!target || target.declaration.kind !== 'typeAlias' || seen.has(target.binding.id)) return undefined;
  const substituted = resolveIrTypeStructuralSubstitution(
    target.declaration.type,
    createIrTypeParameterSubstitutionPlan(target.declaration.typeParameters, type.typeArguments),
  );
  return getIrNarrowedMemberTypeHaxe(substituted, name, context, new Set(seen).add(target.binding.id));
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
  return declaration &&
    (declaration.kind === 'interface' || declaration.kind === 'typeAlias') &&
    declaration.typeParameters.length === 0
    ? getBindingTargetNameHaxe(declaration.binding, context)
    : undefined;
}

function getIrImportedTypeNameByNameHaxe(name: string, context: EmitContext): string | undefined {
  const candidates = new Set<string>();
  for (const imported of context.module.imports) {
    for (const binding of imported.bindings) {
      if (binding.binding.space !== 'type' || binding.binding.name !== name) continue;
      const target =
        context.importedTypeTargetNames.get(binding.binding.id) ??
        context.facadeBindingTargetNames.get(binding.binding.id);
      if (target) candidates.add(target);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
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
      if (existing && property.optional && !existing.optional) {
        flattened[flattened.indexOf(existing)] = { ...existing, optional: true };
      }
      if (!existing) {
        flattened.push({
          ...property,
          optional:
            property.optional || !members.every((candidate) => candidate.some((entry) => entry.name === property.name)),
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

function emitTypeParameters(
  parameters: readonly IrTypeParameter[],
  context: EmitContext,
  includeDefaults = true,
): string {
  if (parameters.length === 0) return '';
  return `<${parameters
    .map(
      (parameter) =>
        `${getBindingTargetNameHaxe(parameter.binding, context)}${parameter.constraint && parameter.constraint.kind !== 'function' && !isEntityConstraintHaxe(parameter.constraint, context) ? `:${emitType(parameter.constraint, context)}` : ''}${includeDefaults && parameter.default ? ` = ${emitType(parameter.default, context)}` : ''}`,
    )
    .join(', ')}>`;
}

function isEntityConstraintHaxe(type: Readonly<IrType>, context: EmitContext): boolean {
  return isEntityConstraintHaxeInModule(type, context.module);
}

function isEntityConstraintHaxeInModule(type: Readonly<IrType>, module: Readonly<IrModule>): boolean {
  if (type.kind !== 'named' || type.reference.kind !== 'binding' || type.reference.path.length > 0) return false;
  const binding = type.reference.binding;
  if (binding.name === 'Entity') return true;
  if (binding.kind !== 'import') return false;
  return module.imports.some((imported) =>
    imported.bindings.some(
      (importedBinding) => importedBinding.binding.id === binding.id && importedBinding.imported === 'Entity',
    ),
  );
}

function emitOptionalCallHaxe(
  expression: Readonly<Extract<IrExpression, { kind: 'call' }>>,
  context: EmitContext,
): string {
  const callable = getGeneratedTargetNameHaxe('optionalCall', context);
  const args = expression.arguments.map((argument) => emitExpression(argument, context));
  if (expression.callee.kind === 'property') {
    const receiver = getGeneratedTargetNameHaxe('optionalCallReceiver', context);
    return `(function() { final ${receiver}:Dynamic = ${emitExpression(expression.callee.object, context)}; final ${callable}:Dynamic = ${receiver}.${safeHaxeName(expression.callee.name)}; return ${callable} == null ? null : ${context.haxeReflectName}.callMethod(${receiver}, ${callable}, [${args.join(', ')}]); })()`;
  }
  return `(function() { final ${callable}:Dynamic = ${emitExpression(expression.callee, context)}; return ${callable} == null ? null : ${context.haxeReflectName}.callMethod(null, ${callable}, [${args.join(', ')}]); })()`;
}

function emitVariable(variable: Readonly<IrVariable>, context: EmitContext): string {
  if ('pattern' in variable)
    emissionError(context, 'binding patterns require destructuring lowering before Haxe emission');
  if (context.forwardDeclaredBindingIds.has(variable.binding.id)) {
    const target = getBindingTargetNameHaxe(variable.binding, context);
    if (variable.initialValue === 'undefined') return `${target} = js.Syntax.code("undefined");`;
    if (!variable.initializer) return '';
    return `${target} = ${normalizeHaxeExpressionGrouping(emitExpression(variable.initializer, context))};`;
  }
  // A JavaScript `let`/`var` declaration with no initializer receives `undefined` when its
  // declaration executes. Haxe instead leaves the local definitely uninitialized and rejects a
  // later read even when source control flow correlates it with an assignment (for example an
  // error value guarded by a boolean flag, or two awaited outcomes joined after their catches).
  if (variable.initializer === undefined) {
    const type = variable.type ? `:${emitType(variable.type, context)}` : ':Dynamic';
    return `var ${getBindingTargetNameHaxe(variable.binding, context)}${type} = js.Syntax.code("undefined");`;
  }
  // Haxe checks a closure body more precisely than the source-declared callable envelope. Keeping
  // that envelope on an initialized local can therefore reject a valid source closure (notably a
  // callback whose contextual return is void). The expression already carries parameter types, so
  // let Haxe infer the initialized local's callable type and retain annotations for declarations that
  // must be assigned later.
  const functionValuedInitializer =
    variable.initializer !== undefined && isIrExpressionFunctionValuedHaxe(variable.initializer, context);
  const type = variable.type && !functionValuedInitializer ? `:${emitType(variable.type, context)}` : '';
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
  const functionCast =
    variable.type !== undefined &&
    variable.initializer !== undefined &&
    variable.initializer.kind !== 'function' &&
    isIrTypeFunctionShapedHaxe(variable.type, context) &&
    isIrExpressionFunctionValuedHaxe(variable.initializer, context);
  const directInitializer = variable.initializer ? emitExpression(variable.initializer, context) : undefined;
  const expectedInitializer =
    variable.initializer && variable.type && variable.initializer.kind !== 'function'
      ? emitExpressionAsExpectedTypeHaxe(variable.initializer, variable.type, context, directInitializer)
      : directInitializer;
  const initializer = variable.initializer
    ? ` = ${restCast ? `(cast ${directInitializer} : ${emitType(variable.type!, context)})` : functionCast ? `(cast ${normalizeHaxeExpressionGrouping(directInitializer!)} : ${emitType(variable.type!, context)})` : normalizeHaxeExpressionGrouping(expectedInitializer!)}`
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
  const initializer =
    declaration.type &&
    isIrTypeFunctionShapedHaxe(declaration.type, context) &&
    isIrExpressionFunctionValuedHaxe(declaration.initializer, context)
      ? `(cast ${normalizeHaxeExpressionGrouping(emitExpression(declaration.initializer, context))} : ${emitType(declaration.type, context)})`
      : emitExpression(declaration.initializer, context);
  return [`${storage} ${getBindingTargetNameHaxe(declaration.binding, context)}${type} = ${initializer};`];
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

function createHaxeSourceModuleTargetNameIndex(
  modules: readonly Readonly<IrModule>[],
): Map<string, ReadonlyMap<string, string>> {
  const targetNames = new Map(
    modules.map((module) => [getHaxeCompilerModuleKey(module), createIrModuleTargetNamesHaxe(module)]),
  );
  const packageTypeNames = new Map<
    string,
    Map<
      string,
      Array<{
        readonly bindingId: string;
        readonly module: Readonly<IrModule>;
        readonly moduleKey: string;
      }>
    >
  >();
  for (const module of modules) {
    const moduleKey = getHaxeCompilerModuleKey(module);
    const moduleTargetNames = targetNames.get(moduleKey)!;
    const typeNames = packageTypeNames.get(module.packageName) ?? new Map();
    for (const declaration of module.declarations) {
      if (
        declaration.kind !== 'class' &&
        declaration.kind !== 'enum' &&
        declaration.kind !== 'interface' &&
        declaration.kind !== 'typeAlias'
      ) {
        continue;
      }
      const targetName = moduleTargetNames.get(declaration.binding.id);
      if (!targetName) continue;
      const candidates = typeNames.get(targetName) ?? [];
      candidates.push({ bindingId: declaration.binding.id, module, moduleKey });
      typeNames.set(targetName, candidates);
    }
    packageTypeNames.set(module.packageName, typeNames);
  }
  for (const [packageName, typeNames] of packageTypeNames) {
    const occupied = new Set<string>([
      ...typeNames.keys(),
      ...modules
        .filter((module) => module.packageName === packageName)
        .map((module) => haxeImplementationModule(module.source)),
    ]);
    for (const [targetName, candidates] of typeNames) {
      const distinctModules = new Set(candidates.map((candidate) => candidate.moduleKey));
      if (distinctModules.size < 2) continue;
      const primary = candidates.find((candidate) => haxeImplementationModule(candidate.module.source) === targetName);
      for (const candidate of candidates.sort((left, right) => compareTextCodeUnits(left.moduleKey, right.moduleKey))) {
        if (candidate === primary) continue;
        const preferredName = `${haxeImplementationModule(candidate.module.source)}_${targetName}`;
        let uniqueName = preferredName;
        for (let suffix = 2; occupied.has(uniqueName); suffix += 1) {
          uniqueName = `${preferredName}_${String(suffix)}`;
        }
        occupied.add(uniqueName);
        (targetNames.get(candidate.moduleKey) as Map<string, string>).set(candidate.bindingId, uniqueName);
      }
    }
  }
  return targetNames;
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

function getHaxeFacadeTypeTargetNames(module: Readonly<IrModule>, context: EmitContext): ReadonlyMap<string, string> {
  const moduleKey = getHaxeCompilerModuleKey(module);
  const cached = context.sourceModuleFacadeTypeTargetNames.get(moduleKey);
  if (cached) return cached;
  const targetNames = context.sourceModuleTargetNames.get(moduleKey) ?? createIrModuleTargetNamesHaxe(module);
  const names = createHaxeFacadeTypeTargetNames(module, context.getModuleFacade?.(module), targetNames);
  context.sourceModuleFacadeTypeTargetNames.set(moduleKey, names);
  return names;
}

function getSourceBindingTargetNameHaxe(
  module: Readonly<IrModule>,
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  context: EmitContext,
): string {
  const moduleKey = getHaxeCompilerModuleKey(module);
  let targetNames = context.sourceModuleTargetNames.get(moduleKey);
  if (!targetNames) {
    targetNames = createIrModuleTargetNamesHaxe(module);
    context.sourceModuleTargetNames.set(moduleKey, targetNames);
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
  const uniqueTargets = new Map(
    (targets.length > 0 ? targets : scoped).map((edge) => [
      `${edge.target.packageName}\0${normalizePathPortable(edge.target.source)}`,
      edge.target,
    ]),
  );
  if (uniqueTargets.size === 1) {
    const target = [...uniqueTargets.values()][0]!;
    return modules.find(
      (module) =>
        module.packageName === target.packageName &&
        path.posix.normalize(module.source) === path.posix.normalize(target.source),
    );
  }
  if (!specifier.startsWith('.')) {
    const packageName = /^(@[^/]+\/[^/]+)/u.exec(specifier)?.[1];
    if (!packageName || !importedName) return undefined;
    const owners = modules.filter(
      (module) =>
        module.packageName === packageName &&
        module.declarations.some(
          (declaration) =>
            'binding' in declaration &&
            declaration.binding.name === importedName &&
            'exported' in declaration &&
            declaration.exported,
        ),
    );
    return owners.length === 1 ? owners[0] : undefined;
  }
  const source = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer.source), specifier.replace(/\.[cm]?js$/u, '.ts')),
  );
  const candidates = new Set([source, `${source}.ts`, `${source}/index.ts`]);
  const matchingModules = modules.filter((module) => candidates.has(path.posix.normalize(module.source)));
  const samePackage = matchingModules.filter((module) => module.packageName === importer.packageName);
  if (samePackage.length === 1) return samePackage[0];
  // Semantic lowering can materialize an inferred direct import for a public type which appears
  // only inside another package's declaration. Those requests are repository-relative but are not
  // present in the authored module-resolution graph, so recover the unique source owner across the
  // complete emission session instead of incorrectly assigning the consumer's Haxe package.
  return matchingModules.length === 1 ? matchingModules[0] : undefined;
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
      (semantics.left.flow === 'boolean' || semantics.left.flow === 'number' || semantics.left.flow === 'object')
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
    'haxe-runtime-external-symbol-binding-incomplete',
    { classification: 'target-runtime' },
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
    'haxe-runtime-external-constructor-abi-incomplete',
    { classification: 'target-runtime' },
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
  const cached = haxePascalCaseCache.get(value);
  if (cached !== undefined) return cached;
  const match = /^(?<prefix>_*)(?<name>.*)$/u.exec(value);
  const prefix = match?.groups?.prefix ?? '';
  const name = match?.groups?.name ?? value;
  const result = `${prefix}${name
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('')}`;
  haxePascalCaseCache.set(value, result);
  return result;
}

function safeHaxeName(name: string): string {
  const cached = haxeSafeNameCache.get(name);
  if (cached !== undefined) return cached;
  const stripped = name.startsWith('#') ? name.slice(1) : name;
  const escaped = [...stripped]
    .map((character, index) =>
      (index === 0 ? /[A-Za-z_]/u : /[A-Za-z0-9_]/u).test(character)
        ? character
        : `_u${character.codePointAt(0)!.toString(16).padStart(4, '0')}_`,
    )
    .join('');
  const identifier = escaped || '_';
  const result = haxeKeywords.has(identifier) ? `${identifier}_` : identifier;
  haxeSafeNameCache.set(name, result);
  return result;
}

function safeHaxeTypeName(name: string): string {
  return safeHaxeName(pascalCase(name));
}

const haxePascalCaseCache = new Map<string, string>();
const haxeSafeNameCache = new Map<string, string>();

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
