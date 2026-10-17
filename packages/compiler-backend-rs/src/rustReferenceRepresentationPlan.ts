import path from 'node:path';

import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import { analyzeIrModuleClosureEvidence } from '../../compiler-closure/src/index.js';
import {
  analyzeIrExpressionSubtreeTraversal,
  analyzeIrModuleTraversal,
  analyzeIrStatementSubtreeTraversal,
  getIrModuleTraversalPathValue,
} from '../../compiler-ir-traversal/src/index.js';
import type {
  CompilerIrTraversalPath,
  CompilerModuleIdentity,
  CompilerRustReferenceCallablePlan,
  CompilerRustReferenceModulePlan,
  CompilerRustReferenceRepresentation,
  CompilerRustReferenceRepresentationPlan,
  CompilerRustReferenceRepresentationPlanInput,
  CompilerRustReferenceRepresentationRefusal,
  IrBindingIdentity,
  IrClassDeclaration,
  IrClassField,
  IrClassMethod,
  IrExpression,
  IrFunctionDeclaration,
  IrImportBinding,
  IrModule,
  IrParameter,
  IrType,
} from '../../compiler-types/src/index.js';
import {
  analyzeIrModuleOwnershipEvidenceRust,
  collectIrModuleReferentMutatedParameterIdsRust,
} from './rustOwnershipEvidence.js';

type IrCallExpression = Readonly<Extract<IrExpression, { kind: 'call' }>>;

type RustSharedClassRepresentation = Extract<
  CompilerRustReferenceRepresentation,
  'optional-null-shared-ref-cell-class' | 'optional-undefined-shared-ref-cell-class' | 'shared-ref-cell-class'
>;

type RustOptionalSharedClassRepresentation = Exclude<RustSharedClassRepresentation, 'shared-ref-cell-class'>;

interface RustSharedClassCarrierType {
  readonly classType: Readonly<IrType>;
  readonly representation: RustSharedClassRepresentation;
  readonly sentinel?: 'null' | 'undefined' | undefined;
}

interface RustReferenceCallRecord {
  readonly call: IrCallExpression;
  readonly enclosingFunction: RustReferenceFunctionRecord;
}

interface RustReferenceCallableDraft {
  readonly binding: IrBindingIdentity;
  readonly parameters: Map<number, CompilerRustReferenceRepresentation>;
  returns?: RustSharedClassRepresentation | undefined;
}

interface RustReferenceFunctionRecord {
  readonly declaration: Readonly<IrFunctionDeclaration>;
  readonly mutatedParameterPositions: Set<number>;
}

interface RustSimpleClassConstructorPlan {
  readonly borrowedPositions: ReadonlySet<number>;
  readonly optionalClassParameters: ReadonlyMap<number, RustSharedClassCarrierType>;
}

interface RustSimpleClassMethodPlan {
  readonly async: boolean;
  readonly identity: string;
  readonly mutatedClassParameterPositions: ReadonlySet<number>;
  readonly optionalClassParameters: ReadonlyMap<
    number,
    RustSharedClassCarrierType & Readonly<{ representation: RustOptionalSharedClassRepresentation }>
  >;
  readonly requiredClassParameters: ReadonlyMap<
    number,
    Readonly<{
      classType: Readonly<IrType>;
      representation: 'borrowed-class' | 'mutable-borrowed-class';
    }>
  >;
}

interface RustReferenceImportRecord {
  readonly binding: Readonly<IrImportBinding>;
  readonly specifier: string;
}

interface RustReferenceModuleRecord {
  readonly bindingTypes: Map<string, Readonly<IrType>>;
  readonly calls: RustReferenceCallRecord[];
  readonly classBindingIds: Set<string>;
  readonly functions: RustReferenceFunctionRecord[];
  readonly functionsByBindingId: Map<string, RustReferenceFunctionRecord>;
  readonly importsByBindingId: ReadonlyMap<string, RustReferenceImportRecord>;
  readonly module: Readonly<IrModule>;
  readonly ownership: ReturnType<typeof analyzeIrModuleOwnershipEvidenceRust>;
  readonly sharedArrays: RustSharedArrayAnalysis;
  sharedClasses: RustSharedClassAnalysis;
  readonly sharedMaps: RustSharedHashCollectionAnalysis;
  readonly sharedSets: RustSharedHashCollectionAnalysis;
}

interface RustSharedArrayAnalysis {
  readonly ambiguousBindingIds: ReadonlySet<string>;
  readonly bindingIds: Set<string>;
  readonly groupByBindingId: ReadonlyMap<string, string>;
  readonly groupsByKey: ReadonlyMap<string, ReadonlySet<string>>;
}

interface RustSharedHashCollectionAnalysis {
  readonly ambiguousBindingIds: ReadonlySet<string>;
  readonly bindingIds: Set<string>;
  readonly groupByBindingId: ReadonlyMap<string, string>;
  readonly groupsByKey: ReadonlyMap<string, ReadonlySet<string>>;
  readonly kind: RustSharedHashCollectionKind;
  readonly variablesByBindingId: ReadonlyMap<string, RustSharedHashCollectionVariable>;
}

interface RustSharedClassAnalysis {
  readonly ambiguousBindingIds: ReadonlySet<string>;
  readonly bindingRepresentations: Map<string, RustSharedClassRepresentation>;
  readonly carrierTypesByBindingId: ReadonlyMap<string, RustSharedClassCarrierType>;
  readonly groupByBindingId: ReadonlyMap<string, string>;
  readonly groupsByKey: ReadonlyMap<string, ReadonlySet<string>>;
  readonly variablesByBindingId: ReadonlyMap<string, RustSharedClassVariable>;
}

interface RustSharedClassVariable {
  readonly binding: Readonly<IrBindingIdentity>;
  readonly carrier: RustSharedClassCarrierType;
  readonly initializer: Readonly<IrExpression> | undefined;
  readonly mutable: boolean;
  readonly type: Readonly<IrType> | undefined;
}

interface RustSharedHashCollectionVariable {
  readonly binding: Readonly<IrBindingIdentity>;
  readonly initializer: Readonly<IrExpression> | undefined;
  readonly mutable: boolean;
  readonly type: Readonly<IrType> | undefined;
}

type RustSharedHashCollectionKind = 'map' | 'set';

type RustReferenceCallTarget =
  | Readonly<{ kind: 'ambiguous'; imported: RustReferenceImportRecord }>
  | Readonly<{
      function: RustReferenceFunctionRecord;
      imported?: RustReferenceImportRecord;
      kind: 'function';
      module: RustReferenceModuleRecord;
    }>
  | Readonly<{ kind: 'local-unplanned' }>
  | Readonly<{ kind: 'unrepresented'; imported: RustReferenceImportRecord }>
  | Readonly<{ kind: 'unresolved'; imported: RustReferenceImportRecord }>;

export function createCompilerRustReferenceRepresentationPlan(
  input: Readonly<CompilerRustReferenceRepresentationPlanInput>,
): CompilerRustReferenceRepresentationPlan {
  if (input.moduleResolution && input.moduleResolution.schema !== 'flight-compiler-module-resolution/1') {
    throw new TypeError('Rust reference representation planning requires flight-compiler-module-resolution/1');
  }
  const modules = createRustReferenceModuleRecords(input.modules, input.moduleResolution);
  collectRustReferenceClassMethodParameterMutations(modules, input.moduleResolution);
  propagateRustReferenceArrayParameterMutation(modules, input.moduleResolution);
  propagateRustReferenceClassParameterMutation(modules, input.moduleResolution);
  propagateRustReferenceHashCollectionParameterMutation(modules, input.moduleResolution, 'map');
  propagateRustReferenceHashCollectionParameterMutation(modules, input.moduleResolution, 'set');
  activateRustSharedClassReturnBindings(modules, input.moduleResolution);
  activateRustSharedClassFunctionReturnAliases(modules, input.moduleResolution);
  activateRustSharedClassAliasGroups(modules, input.moduleResolution);
  activateRustOptionalSharedClassInitializers(modules);
  activateRustSharedClassIdentityComparisons(modules, input.moduleResolution);
  activateRustSharedHashCollectionUnsupportedUses(modules, input.moduleResolution, 'map');
  activateRustSharedHashCollectionUnsupportedUses(modules, input.moduleResolution, 'set');
  activateRustSharedClassUnsupportedUses(modules, input.moduleResolution);
  activateRustSharedClassMethodMutations(modules, input.moduleResolution);
  activateRustSharedArrayCallMutations(modules, input.moduleResolution);
  activateRustSharedClassCallMutations(modules, input.moduleResolution);
  activateRustSharedHashCollectionCallMutations(modules, input.moduleResolution, 'map');
  activateRustSharedHashCollectionCallMutations(modules, input.moduleResolution, 'set');
  const plan: CompilerRustReferenceRepresentationPlan = {
    modules: [...modules]
      .sort((left, right) => compareTextCodeUnits(moduleKey(left.module), moduleKey(right.module)))
      .map((module) => createRustReferenceModulePlan(module, modules, input.moduleResolution)),
    schema: 'flight-rust-reference-representation-plan/1',
  };
  return cloneAndFreezeRustReferenceRepresentationPlan(plan);
}

function collectRustReferenceClassMethodParameterMutations(
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): void {
  for (const module of modules) {
    for (const { call, enclosingFunction } of module.calls) {
      const method = getRustSimpleClassMethodCall(call, module, modules, moduleResolution);
      if (!method) continue;
      if (method.mutating && method.receiver.reference.kind === 'binding') {
        const receiverId = method.receiver.reference.binding.id;
        const position = enclosingFunction.declaration.parameters.findIndex(
          (parameter) => parameter.binding.id === receiverId,
        );
        if (position >= 0) enclosingFunction.mutatedParameterPositions.add(position);
      }
      for (const argumentPosition of method.plan.mutatedClassParameterPositions) {
        const argument = call.arguments[argumentPosition];
        if (!argument || argument.kind !== 'identifier' || argument.reference.kind !== 'binding') continue;
        const argumentId = argument.reference.binding.id;
        const parameterPosition = enclosingFunction.declaration.parameters.findIndex(
          (parameter) => parameter.binding.id === argumentId,
        );
        if (parameterPosition >= 0) enclosingFunction.mutatedParameterPositions.add(parameterPosition);
      }
    }
  }
}

function createRustReferenceModuleRecords(
  modules: readonly Readonly<IrModule>[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): readonly RustReferenceModuleRecord[] {
  const records: RustReferenceModuleRecord[] = [];
  for (const module of modules) {
    const ownership = analyzeIrModuleOwnershipEvidenceRust(module);
    const bindingTypes = new Map(ownership.bindings.map((binding) => [binding.binding.id, binding.type]));
    const mutatedParameters = collectIrModuleReferentMutatedParameterIdsRust(module);
    const classBindingIds = new Set(
      module.declarations.flatMap((declaration) => (declaration.kind === 'class' ? [declaration.binding.id] : [])),
    );
    const sharedArrays = createRustSharedArrayAnalysis(module, ownership, bindingTypes);
    const sharedClasses = createRustSharedClassAnalysis(module, ownership, bindingTypes, classBindingIds);
    const sharedMaps = createRustSharedHashCollectionAnalysis(module, ownership, bindingTypes, 'map');
    const sharedSets = createRustSharedHashCollectionAnalysis(module, ownership, bindingTypes, 'set');
    const record: RustReferenceModuleRecord = {
      bindingTypes,
      calls: [],
      classBindingIds,
      functions: [],
      functionsByBindingId: new Map(),
      importsByBindingId: new Map(
        module.imports.flatMap((item) =>
          item.bindings.map((binding) => [binding.binding.id, { binding, specifier: item.specifier }] as const),
        ),
      ),
      module,
      ownership,
      sharedArrays,
      sharedClasses,
      sharedMaps,
      sharedSets,
    };
    const functions = module.declarations.flatMap((declaration) =>
      declaration.kind === 'function'
        ? [
            {
              declaration,
              mutatedParameterPositions: new Set(
                declaration.parameters.flatMap((parameter, position) =>
                  mutatedParameters.has(parameter.binding.id) ? [position] : [],
                ),
              ),
            } satisfies RustReferenceFunctionRecord,
          ]
        : [],
    );
    record.functions.push(...functions);
    for (const function_ of functions) {
      record.functionsByBindingId.set(function_.declaration.binding.id, function_);
      for (const statement of function_.declaration.body) {
        analyzeIrStatementSubtreeTraversal(statement, {
          expression(expression) {
            if (expression.kind === 'call') record.calls.push({ call: expression, enclosingFunction: function_ });
            return undefined;
          },
        });
      }
    }
    records.push(record);
  }
  // An imported type is class evidence only after its target resolves to an actual exported class or
  // source uses it directly as a constructor. Resolve the complete graph before deriving effective
  // binding types so interfaces and otherwise unresolved imported names cannot enter shared-class
  // planning speculatively.
  for (const record of records) {
    const importedBindingIds = new Set(record.importsByBindingId.keys());
    for (const imported of record.importsByBindingId.values()) {
      if (imported.binding.imported === '*') continue;
      const matches = resolveRustReferenceImportModules(imported, record.module, records, moduleResolution).flatMap(
        (target) =>
          target.module.declarations.flatMap((declaration) =>
            declaration.kind === 'class' &&
            declaration.exported &&
            declaration.binding.name === imported.binding.imported
              ? [declaration]
              : [],
          ),
      );
      if (matches.length === 1) record.classBindingIds.add(imported.binding.binding.id);
    }
    analyzeIrModuleTraversal(record.module, {
      expression(expression) {
        if (
          expression.kind === 'new' &&
          expression.callee.kind === 'identifier' &&
          expression.callee.reference.kind === 'binding' &&
          importedBindingIds.has(expression.callee.reference.binding.id)
        ) {
          record.classBindingIds.add(expression.callee.reference.binding.id);
        }
        return undefined;
      },
    });
  }
  for (const record of records) {
    for (const function_ of record.functions) {
      if (!isRustReferenceMixedFixedClassAbiShapeSupported(function_, record, records, moduleResolution)) continue;
      for (const [position, carrier] of getRustReferenceOptionalClassParameterPlans(
        function_,
        record,
        records,
        moduleResolution,
      )) {
        const parameter = function_.declaration.parameters[position];
        if (!parameter?.optional) continue;
        record.bindingTypes.set(parameter.binding.id, {
          kind: 'union',
          types: [carrier.classType, { kind: 'undefined' }],
        });
      }
    }
    for (const declaration of record.module.declarations) {
      if (declaration.kind !== 'class') continue;
      const constructorPlan = getRustSimpleClassConstructorPlan(
        declaration,
        record,
        records,
        moduleResolution,
        new Set(),
      );
      for (const [position, carrier] of constructorPlan?.optionalClassParameters ?? []) {
        const parameter = declaration.classConstructor?.parameters[position];
        if (!parameter) continue;
        record.bindingTypes.set(parameter.binding.id, {
          kind: 'union',
          types: [carrier.classType, { kind: 'undefined' }],
        });
      }
      const visitingClasses = new Set([`${moduleKey(record.module)}:${declaration.binding.id}`]);
      for (const method of declaration.methods) {
        const methodPlan = getRustSimpleClassMethodPlan(
          method,
          declaration,
          record,
          records,
          moduleResolution,
          visitingClasses,
        );
        for (const [position, carrier] of methodPlan?.optionalClassParameters ?? []) {
          const parameter = method.parameters[position];
          if (!parameter) continue;
          record.bindingTypes.set(
            parameter.binding.id,
            parameter.optional
              ? {
                  kind: 'union',
                  types: [carrier.classType, { kind: 'undefined' }],
                }
              : parameter.type,
          );
        }
      }
    }
    record.sharedClasses = createRustSharedClassAnalysis(
      record.module,
      record.ownership,
      record.bindingTypes,
      record.classBindingIds,
    );
  }
  return records;
}

function propagateRustReferenceArrayParameterMutation(
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const module of modules) {
      for (const { call, enclosingFunction } of module.calls) {
        const target = resolveRustReferenceCallTarget(call, module, modules, moduleResolution);
        if (target.kind !== 'function') continue;
        for (const position of getRustReferenceArrayMutationPositions(target.function)) {
          const argument = call.arguments[position];
          if (argument?.kind !== 'identifier' || argument.reference.kind !== 'binding') continue;
          const argumentBindingId = argument.reference.binding.id;
          const callerPosition = enclosingFunction.declaration.parameters.findIndex(
            (parameter) => parameter.binding.id === argumentBindingId,
          );
          if (callerPosition < 0 || enclosingFunction.mutatedParameterPositions.has(callerPosition)) continue;
          const callerParameter = enclosingFunction.declaration.parameters[callerPosition];
          if (callerParameter?.type.kind !== 'array') continue;
          enclosingFunction.mutatedParameterPositions.add(callerPosition);
          changed = true;
        }
      }
    }
  }
}

function propagateRustReferenceClassParameterMutation(
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const module of modules) {
      for (const { call, enclosingFunction } of module.calls) {
        const target = resolveRustReferenceCallTarget(call, module, modules, moduleResolution);
        if (target.kind !== 'function') continue;
        const mutationPositions = new Set([
          ...getRustReferenceClassMutationPositions(target.function, target.module, modules, moduleResolution),
          ...[
            ...getRustReferenceOptionalClassParameterPlans(
              target.function,
              target.module,
              modules,
              moduleResolution,
            ).keys(),
          ].filter((position) => target.function.mutatedParameterPositions.has(position)),
        ]);
        for (const position of mutationPositions) {
          const argument = call.arguments[position];
          if (argument?.kind !== 'identifier' || argument.reference.kind !== 'binding') continue;
          const argumentBindingId = argument.reference.binding.id;
          const callerPosition = enclosingFunction.declaration.parameters.findIndex(
            (parameter) => parameter.binding.id === argumentBindingId,
          );
          if (callerPosition < 0 || enclosingFunction.mutatedParameterPositions.has(callerPosition)) continue;
          const callerParameter = enclosingFunction.declaration.parameters[callerPosition];
          if (
            !callerParameter ||
            !getRustSharedClassCarrierType(callerParameter.type, module, modules, moduleResolution)
          ) {
            continue;
          }
          enclosingFunction.mutatedParameterPositions.add(callerPosition);
          changed = true;
        }
      }
    }
  }
}

function propagateRustReferenceHashCollectionParameterMutation(
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  kind: RustSharedHashCollectionKind,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const module of modules) {
      for (const { call, enclosingFunction } of module.calls) {
        const target = resolveRustReferenceCallTarget(call, module, modules, moduleResolution);
        if (target.kind !== 'function') continue;
        for (const position of getRustReferenceHashCollectionMutationPositions(target.function, kind)) {
          const argument = call.arguments[position];
          if (argument?.kind !== 'identifier' || argument.reference.kind !== 'binding') continue;
          const argumentBindingId = argument.reference.binding.id;
          const callerPosition = enclosingFunction.declaration.parameters.findIndex(
            (parameter) => parameter.binding.id === argumentBindingId,
          );
          if (callerPosition < 0 || enclosingFunction.mutatedParameterPositions.has(callerPosition)) continue;
          const callerParameter = enclosingFunction.declaration.parameters[callerPosition];
          if (!callerParameter || !isRustSharedHashCollectionTypeSupported(callerParameter.type, kind)) continue;
          enclosingFunction.mutatedParameterPositions.add(callerPosition);
          changed = true;
        }
      }
    }
  }
}

function createRustReferenceModulePlan(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): CompilerRustReferenceModulePlan {
  const callables = new Map<string, RustReferenceCallableDraft>();
  const mutatedBindings = new Map<string, IrBindingIdentity>();
  const refusals = new Map<string, CompilerRustReferenceRepresentationRefusal>();

  addRustAsyncClassMethodDeclarationRefusals(module, modules, moduleResolution, refusals);
  addRustSharedArrayRefusals(module, modules, moduleResolution, refusals);
  addRustSharedClassIdentityRefusals(module, modules, moduleResolution, refusals);
  addRustAsyncClassMethodCallRefusals(module, modules, moduleResolution, refusals);
  addRustClassMethodParameterRefusals(module, modules, moduleResolution, refusals);
  addRustSharedClassMethodValueRefusals(module, modules, moduleResolution, refusals);
  addRustOptionalClassCarrierBoundaryRefusals(module, modules, moduleResolution, refusals);
  addRustSharedClassRefusals(module, modules, moduleResolution, refusals);
  addRustSharedClassReturnRefusals(module, modules, moduleResolution, refusals);
  addRustSharedHashCollectionRefusals(module, modules, moduleResolution, refusals, 'map');
  addRustSharedHashCollectionRefusals(module, modules, moduleResolution, refusals, 'set');

  for (const evidence of module.ownership.bindings) {
    if (
      (evidence.type.kind === 'array' ||
        getRustSharedClassCarrierType(evidence.type, module, modules, moduleResolution) !== undefined ||
        isRustSharedHashCollectionTypeSupported(evidence.type, 'map') ||
        isRustSharedHashCollectionTypeSupported(evidence.type, 'set')) &&
      (evidence.mutation === 'referentMutated' || evidence.mutation === 'bindingAndReferent')
    ) {
      mutatedBindings.set(evidence.binding.id, evidence.binding);
    }
  }

  for (const function_ of module.functions) {
    const returnCarrier = getRustReferenceClassReturnCarrier(function_, module, modules, moduleResolution, new Set());
    if (returnCarrier) {
      addRustReferenceCallableReturnPlan(callables, function_.declaration.binding, returnCarrier.representation);
    }
    for (const [position, carrier] of getRustReferenceOptionalClassParameterPlans(
      function_,
      module,
      modules,
      moduleResolution,
    )) {
      addRustReferenceCallablePlan(
        callables,
        function_.declaration.binding,
        new Set([position]),
        carrier.representation,
      );
      const parameter = function_.declaration.parameters[position];
      if (parameter && function_.mutatedParameterPositions.has(position)) {
        mutatedBindings.set(parameter.binding.id, parameter.binding);
      }
    }
    addRustReferenceCallablePlan(
      callables,
      function_.declaration.binding,
      getRustReferenceArrayMutationPositions(function_),
      'mutable-borrowed-vec',
    );
    const classPositions = getRustReferenceClassBorrowPositions(function_, module, modules, moduleResolution);
    addRustReferenceCallablePlan(callables, function_.declaration.binding, classPositions, 'borrowed-class');
    const mutatedClassPositions = getRustReferenceClassMutationPositions(function_, module, modules, moduleResolution);
    addRustReferenceCallablePlan(
      callables,
      function_.declaration.binding,
      new Set([...mutatedClassPositions].filter((position) => classPositions.has(position))),
      'mutable-borrowed-class',
    );
    for (const position of mutatedClassPositions) {
      const parameter = function_.declaration.parameters[position];
      if (parameter && classPositions.has(position)) mutatedBindings.set(parameter.binding.id, parameter.binding);
    }
    for (const kind of RUST_SHARED_HASH_COLLECTION_KINDS) {
      addRustReferenceCallablePlan(
        callables,
        function_.declaration.binding,
        getRustReferenceHashCollectionMutationPositions(function_, kind),
        getRustReferenceHashCollectionBorrowedRepresentation(kind),
      );
    }
  }

  for (const { call } of module.calls) {
    if (call.callee.kind !== 'identifier' || call.callee.reference.kind !== 'binding') continue;
    const target = resolveRustReferenceCallTarget(call, module, modules, moduleResolution);
    if (target.kind === 'local-unplanned') continue;
    if (target.kind !== 'function') {
      const hasArray = call.arguments.some((argument) => isRustReferenceArrayExpression(argument, module.bindingTypes));
      const hasClass = call.arguments.some((argument) => isRustReferenceClassExpression(argument, module));
      const hashCollectionKinds = RUST_SHARED_HASH_COLLECTION_KINDS.filter((kind) =>
        call.arguments.some((argument) => isRustReferenceHashCollectionExpression(argument, module.bindingTypes, kind)),
      );
      if (!hasArray && !hasClass && hashCollectionKinds.length === 0) continue;
      if (hasArray) {
        const code =
          target.kind === 'ambiguous'
            ? 'rust-reference-array-call-target-ambiguous'
            : target.kind === 'unresolved'
              ? 'rust-reference-array-call-target-unresolved'
              : 'rust-reference-mutating-parameter-unrepresented';
        addRustReferenceRefusal(
          refusals,
          code,
          `${moduleKey(module.module)}:${call.callee.reference.binding.id}`,
          target.kind === 'ambiguous'
            ? `array call target ${target.imported.binding.imported} resolves to multiple Rust providers`
            : target.kind === 'unresolved'
              ? `array call target ${target.imported.binding.imported} has no resolved Rust provider`
              : `array call target ${target.imported.binding.imported} has no represented Rust function declaration`,
        );
      }
      if (hasClass) {
        addRustReferenceRefusal(
          refusals,
          'rust-reference-shared-class-call-unrepresented',
          `${moduleKey(module.module)}:${call.callee.reference.binding.id}`,
          `class call target ${target.imported.binding.imported} is ${target.kind} and has no exact represented Rust mutable parameter`,
        );
      }
      for (const kind of hashCollectionKinds) {
        const collectionName = getRustReferenceHashCollectionName(kind);
        addRustReferenceRefusal(
          refusals,
          getRustReferenceHashCollectionRefusalCode(kind, 'call'),
          `${moduleKey(module.module)}:${call.callee.reference.binding.id}`,
          `${collectionName} call target ${target.imported.binding.imported} is ${target.kind} and has no exact represented Rust mutable parameter`,
        );
      }
      continue;
    }
    const unrepresentedMutationPositions = [...target.function.mutatedParameterPositions].filter((position) => {
      const type = target.function.declaration.parameters[position]?.type;
      return (
        type?.kind !== 'array' &&
        !getRustSharedClassCarrierType(type, target.module, modules, moduleResolution) &&
        !isRustSharedHashCollectionTypeSupported(type, 'map') &&
        !isRustSharedHashCollectionTypeSupported(type, 'set')
      );
    });
    if (target.imported && unrepresentedMutationPositions.length > 0) {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-mutating-parameter-unrepresented',
        `${moduleKey(module.module)}:${call.callee.reference.binding.id}`,
        `imported function ${target.imported.binding.imported} mutates a parameter outside the represented Rust collection reference plan`,
      );
      continue;
    }
    const returnCarrier = getRustReferenceClassReturnCarrier(
      target.function,
      target.module,
      modules,
      moduleResolution,
      new Set(),
    );
    if (returnCarrier) {
      addRustReferenceCallableReturnPlan(callables, call.callee.reference.binding, returnCarrier.representation);
    }
    const arrayPositions = getRustReferenceArrayMutationPositions(target.function);
    addRustReferenceCallablePlan(callables, call.callee.reference.binding, arrayPositions, 'mutable-borrowed-vec');
    for (const position of arrayPositions) {
      const argument = call.arguments[position];
      if (argument?.kind === 'array') continue;
      if (
        argument?.kind === 'identifier' &&
        argument.reference.kind === 'binding' &&
        module.bindingTypes.get(argument.reference.binding.id)?.kind === 'array'
      ) {
        mutatedBindings.set(argument.reference.binding.id, argument.reference.binding);
        addRustSharedArrayCallBorrowConflictRefusal(module, call, position, refusals);
        continue;
      }
      addRustReferenceRefusal(
        refusals,
        'rust-reference-array-argument-unrepresented',
        `${moduleKey(module.module)}:${call.callee.reference.binding.id}:${String(position)}`,
        `argument ${String(position)} to ${call.callee.reference.binding.name} lacks a represented Rust Vec binding`,
      );
    }
    addRustReferenceClassCallPlan(
      callables,
      mutatedBindings,
      refusals,
      module,
      modules,
      moduleResolution,
      call,
      target.function,
      target.module,
    );
    for (const kind of RUST_SHARED_HASH_COLLECTION_KINDS) {
      addRustReferenceHashCollectionCallPlan(callables, mutatedBindings, refusals, module, call, target.function, kind);
    }
  }

  return {
    callables: [...callables.values()]
      .sort((left, right) => compareTextCodeUnits(left.binding.id, right.binding.id))
      .map(
        ({ binding, parameters, returns }): CompilerRustReferenceCallablePlan => ({
          binding,
          parameters: [...parameters]
            .sort(([left], [right]) => left - right)
            .map(([position, representation]) => ({ position, representation })),
          ...(returns ? { returns } : {}),
        }),
      ),
    module: moduleIdentity(module.module),
    referentMutatedBindings: [...mutatedBindings.values()].sort((left, right) =>
      compareTextCodeUnits(left.id, right.id),
    ),
    refusals: [...refusals.values()].sort((left, right) =>
      compareTextCodeUnits(`${left.subject}\0${left.code}`, `${right.subject}\0${right.code}`),
    ),
    sharedArrayBindings: [...module.sharedArrays.bindingIds]
      .map((id) => ({
        binding: module.ownership.bindings.find((evidence) => evidence.binding.id === id)!.binding,
        representation: 'shared-ref-cell-vec' as const,
      }))
      .sort((left, right) => compareTextCodeUnits(left.binding.id, right.binding.id)),
    sharedClassBindings: [...module.sharedClasses.bindingRepresentations]
      .map(([id, representation]) => ({
        binding: module.ownership.bindings.find((evidence) => evidence.binding.id === id)!.binding,
        representation,
      }))
      .sort((left, right) => compareTextCodeUnits(left.binding.id, right.binding.id)),
    sharedMapBindings: [...module.sharedMaps.bindingIds]
      .map((id) => ({
        binding: module.ownership.bindings.find((evidence) => evidence.binding.id === id)!.binding,
        representation: 'shared-ref-cell-hash-map' as const,
      }))
      .sort((left, right) => compareTextCodeUnits(left.binding.id, right.binding.id)),
    sharedSetBindings: [...module.sharedSets.bindingIds]
      .map((id) => ({
        binding: module.ownership.bindings.find((evidence) => evidence.binding.id === id)!.binding,
        representation: 'shared-ref-cell-hash-set' as const,
      }))
      .sort((left, right) => compareTextCodeUnits(left.binding.id, right.binding.id)),
  };
}

function addRustReferenceClassCallPlan(
  callables: Map<string, RustReferenceCallableDraft>,
  mutatedBindings: Map<string, IrBindingIdentity>,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  call: IrCallExpression,
  target: RustReferenceFunctionRecord,
  targetModule: RustReferenceModuleRecord,
): void {
  const optionalPositions = getRustReferenceOptionalClassParameterPlans(
    target,
    targetModule,
    modules,
    moduleResolution,
  );
  const positions = getRustReferenceClassBorrowPositions(target, targetModule, modules, moduleResolution);
  const mutablePositions = getRustReferenceClassMutationPositions(target, targetModule, modules, moduleResolution);
  const callableBinding =
    call.callee.kind === 'identifier' && call.callee.reference.kind === 'binding'
      ? call.callee.reference.binding
      : target.declaration.binding;
  addRustReferenceCallablePlan(callables, callableBinding, positions, 'borrowed-class');
  addRustReferenceCallablePlan(
    callables,
    callableBinding,
    new Set([...mutablePositions].filter((position) => positions.has(position))),
    'mutable-borrowed-class',
  );
  for (const [position, carrier] of optionalPositions) {
    addRustReferenceCallablePlan(callables, callableBinding, new Set([position]), carrier.representation);
    const argument = call.arguments[position];
    const parameter = target.declaration.parameters[position];
    if (
      parameter?.optional &&
      !hasRustReferenceOptionalParameterInvocationEvidence(call, target.declaration.parameters, position)
    ) {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-call-unrepresented',
        `${moduleKey(module.module)}:${callableBinding.id}:${String(position)}`,
        `argument ${String(position)} to ${target.declaration.binding.name} lacks exact optional-parameter invocation evidence`,
      );
      continue;
    }
    if (!argument && parameter?.optional) continue;
    if (
      argument &&
      isRustReferenceClassCarrierExpressionCompatible(
        argument,
        carrier,
        module,
        modules,
        moduleResolution,
        targetModule,
      )
    ) {
      if (
        target.mutatedParameterPositions.has(position) &&
        argument.kind === 'identifier' &&
        argument.reference.kind === 'binding'
      ) {
        mutatedBindings.set(argument.reference.binding.id, argument.reference.binding);
        addRustSharedClassCallBorrowConflictRefusal(module, call, position, refusals);
      }
      continue;
    }
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-call-unrepresented',
      `${moduleKey(module.module)}:${callableBinding.id}:${String(position)}`,
      `argument ${String(position)} to ${target.declaration.binding.name} does not match its exact optional simple-class sentinel carrier`,
    );
  }
  for (const position of positions) {
    const argument = call.arguments[position];
    const parameter = target.declaration.parameters[position];
    if (
      argument &&
      parameter &&
      isRustReferenceExactClassArgument(argument, module, parameter.type, targetModule, modules, moduleResolution)
    ) {
      if (mutablePositions.has(position) && argument.kind === 'identifier' && argument.reference.kind === 'binding') {
        mutatedBindings.set(argument.reference.binding.id, argument.reference.binding);
        addRustSharedClassCallBorrowConflictRefusal(module, call, position, refusals);
      }
      continue;
    }
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-call-unrepresented',
      `${moduleKey(module.module)}:${callableBinding.id}:${String(position)}`,
      `argument ${String(position)} to ${target.declaration.binding.name} lacks an exact represented simple-class binding`,
    );
  }
  for (const position of getRustReferenceAnyClassParameterPositions(target, targetModule)) {
    if (positions.has(position) || optionalPositions.has(position)) continue;
    const argument = call.arguments[position];
    const parameter = target.declaration.parameters[position];
    const excludedFlexibleClassParameter = Boolean(
      parameter && (parameter.initializer || parameter.optional || parameter.rest),
    );
    if (!excludedFlexibleClassParameter && (!argument || !isRustReferenceClassExpression(argument, module))) {
      continue;
    }
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-call-unrepresented',
      `${moduleKey(module.module)}:${callableBinding.id}:${String(position)}`,
      `argument ${String(position)} to ${target.declaration.binding.name} uses a class outside the exact represented simple-class plan`,
    );
  }
}

function hasRustReferenceOptionalParameterInvocationEvidence(
  invocation: Readonly<IrCallExpression | Extract<IrExpression, { kind: 'new' }>>,
  parameters: readonly Readonly<IrParameter>[],
  position: number,
): boolean {
  const evidence = invocation.semantics.optionalParameters;
  if (
    !evidence ||
    evidence.parameterCount !== parameters.length ||
    evidence.providedArgumentCount === 'dynamic' ||
    evidence.providedArgumentCount !== invocation.arguments.length
  ) {
    return false;
  }
  const expectedOptional = parameters.flatMap((parameter, index) =>
    parameter.optional && !parameter.initializer ? [index] : [],
  );
  const expectedOmitted = expectedOptional.filter((index) => index >= invocation.arguments.length);
  const expectedProvided = expectedOptional.filter((index) => index < invocation.arguments.length);
  const optional = [...new Set(evidence.optional)].sort((left, right) => left - right);
  const omitted = [...new Set(evidence.omitted)].sort((left, right) => left - right);
  const provided = [...new Set(evidence.provided.map((item) => item.position))].sort((left, right) => left - right);
  return (
    evidence.optional.length === optional.length &&
    evidence.omitted.length === omitted.length &&
    evidence.provided.length === provided.length &&
    optional.length === expectedOptional.length &&
    optional.every((item, index) => item === expectedOptional[index]) &&
    omitted.length === expectedOmitted.length &&
    omitted.every((item, index) => item === expectedOmitted[index]) &&
    provided.length === expectedProvided.length &&
    provided.every((item, index) => item === expectedProvided[index]) &&
    optional.includes(position)
  );
}

function addRustReferenceHashCollectionCallPlan(
  callables: Map<string, RustReferenceCallableDraft>,
  mutatedBindings: Map<string, IrBindingIdentity>,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
  module: RustReferenceModuleRecord,
  call: IrCallExpression,
  target: RustReferenceFunctionRecord,
  kind: RustSharedHashCollectionKind,
): void {
  const positions = getRustReferenceHashCollectionMutationPositions(target, kind);
  addRustReferenceCallablePlan(
    callables,
    call.callee.kind === 'identifier' && call.callee.reference.kind === 'binding'
      ? call.callee.reference.binding
      : target.declaration.binding,
    positions,
    getRustReferenceHashCollectionBorrowedRepresentation(kind),
  );
  for (const position of positions) {
    const argument = call.arguments[position];
    if (
      argument?.kind === 'identifier' &&
      argument.reference.kind === 'binding' &&
      isRustSharedHashCollectionTypeSupported(module.bindingTypes.get(argument.reference.binding.id), kind)
    ) {
      mutatedBindings.set(argument.reference.binding.id, argument.reference.binding);
      addRustSharedHashCollectionCallBorrowConflictRefusal(module, call, position, refusals, kind);
      continue;
    }
    addRustReferenceRefusal(
      refusals,
      getRustReferenceHashCollectionRefusalCode(kind, 'call'),
      `${moduleKey(module.module)}:${call.callee.kind === 'identifier' && call.callee.reference.kind === 'binding' ? call.callee.reference.binding.id : target.declaration.binding.id}:${String(position)}`,
      `argument ${String(position)} to ${target.declaration.binding.name} lacks an exact represented Rust ${kind === 'map' ? 'HashMap' : 'HashSet'} binding`,
    );
  }
  for (const position of getRustReferenceAnyHashCollectionMutationPositions(target, kind)) {
    if (positions.has(position)) continue;
    const argument = call.arguments[position];
    if (!argument || !isRustReferenceHashCollectionExpression(argument, module.bindingTypes, kind)) continue;
    addRustReferenceRefusal(
      refusals,
      getRustReferenceHashCollectionRefusalCode(kind, 'call'),
      `${moduleKey(module.module)}:${call.callee.kind === 'identifier' && call.callee.reference.kind === 'binding' ? call.callee.reference.binding.id : target.declaration.binding.id}:${String(position)}`,
      `argument ${String(position)} to ${target.declaration.binding.name} uses a ${getRustReferenceHashCollectionName(kind)} domain outside the exact represented Rust ${kind === 'map' ? 'HashMap' : 'HashSet'} plan`,
    );
  }
}

function createRustSharedArrayAnalysis(
  module: Readonly<IrModule>,
  ownership: RustReferenceModuleRecord['ownership'],
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
): RustSharedArrayAnalysis {
  const parents = new Map<string, string>();
  const aliasEdges: Array<readonly [string, string]> = [];
  const ordinaryAliasBindingIds = new Set<string>();
  const identityMethodAliasEdges: Array<readonly [string, string]> = [];
  const ambiguousBindingIds = new Set<string>();
  const find = (id: string): string => {
    const parent = parents.get(id);
    if (!parent || parent === id) return id;
    const root = find(parent);
    parents.set(id, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    if (!parents.has(left)) parents.set(left, left);
    if (!parents.has(right)) parents.set(right, right);
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
  };

  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if (
        'binding' in variable &&
        bindingTypes.get(variable.binding.id)?.kind === 'array' &&
        variable.initializer?.kind === 'conditional'
      ) {
        const alternatives = new Set(
          [variable.initializer.whenTrue, variable.initializer.whenFalse].flatMap((alternative) =>
            alternative.kind === 'identifier' &&
            alternative.reference.kind === 'binding' &&
            bindingTypes.get(alternative.reference.binding.id)?.kind === 'array'
              ? [alternative.reference.binding.id]
              : [],
          ),
        );
        if (alternatives.size > 1) ambiguousBindingIds.add(variable.binding.id);
      }
      if (!('binding' in variable) || bindingTypes.get(variable.binding.id)?.kind !== 'array') return;
      if (
        variable.initializer?.kind === 'identifier' &&
        variable.initializer.reference.kind === 'binding' &&
        bindingTypes.get(variable.initializer.reference.binding.id)?.kind === 'array'
      ) {
        const edge = [variable.binding.id, variable.initializer.reference.binding.id] as const;
        aliasEdges.push(edge);
        ordinaryAliasBindingIds.add(edge[0]);
        ordinaryAliasBindingIds.add(edge[1]);
        union(...edge);
        return;
      }
      if (
        variable.initializer?.kind === 'call' &&
        variable.initializer.optional === false &&
        variable.initializer.callee.kind === 'property' &&
        variable.initializer.callee.optional === false &&
        variable.initializer.callee.member?.receiver === 'array' &&
        ((variable.initializer.callee.member.name === 'reverse' && variable.initializer.arguments.length === 0) ||
          (variable.initializer.callee.member.name === 'copyWithin' &&
            variable.initializer.arguments.length >= 1 &&
            variable.initializer.arguments.length <= 3) ||
          (variable.initializer.callee.member.name === 'fill' &&
            variable.initializer.arguments.length >= 1 &&
            variable.initializer.arguments.length <= 3) ||
          (variable.initializer.callee.member.name === 'sort' && variable.initializer.arguments.length === 1)) &&
        variable.initializer.callee.object.kind === 'identifier' &&
        variable.initializer.callee.object.reference.kind === 'binding' &&
        bindingTypes.get(variable.initializer.callee.object.reference.binding.id)?.kind === 'array'
      ) {
        identityMethodAliasEdges.push([variable.binding.id, variable.initializer.callee.object.reference.binding.id]);
      }
    },
  });

  const evidenceById = new Map(ownership.bindings.map((evidence) => [evidence.binding.id, evidence]));
  for (const edge of identityMethodAliasEdges) {
    const receiverId = edge[1];
    if (ordinaryAliasBindingIds.has(receiverId) || evidenceById.get(receiverId)?.reuse === 'multiple') {
      aliasEdges.push(edge);
      union(...edge);
    }
  }

  const groups = new Map<string, Set<string>>();
  for (const [left, right] of aliasEdges) {
    const root = find(left);
    const group = groups.get(root) ?? new Set<string>();
    group.add(left);
    group.add(right);
    groups.set(root, group);
  }
  const bindingIds = new Set<string>();
  const groupByBindingId = new Map<string, string>();
  const groupsByKey = new Map<string, ReadonlySet<string>>();
  for (const group of groups.values()) {
    const groupKey = [...group].sort(compareTextCodeUnits)[0]!;
    groupsByKey.set(groupKey, group);
    for (const id of group) groupByBindingId.set(id, groupKey);
    if (
      [...group].some((id) => {
        const mutation = evidenceById.get(id)?.mutation;
        return mutation === 'referentMutated' || mutation === 'bindingAndReferent';
      })
    ) {
      for (const id of group) bindingIds.add(id);
    }
  }
  return { ambiguousBindingIds, bindingIds, groupByBindingId, groupsByKey };
}

function activateRustSharedArrayCallMutations(
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): void {
  for (const module of modules) {
    for (const { call } of module.calls) {
      const target = resolveRustReferenceCallTarget(call, module, modules, moduleResolution);
      if (target.kind !== 'function') continue;
      for (const position of getRustReferenceArrayMutationPositions(target.function)) {
        const argument = call.arguments[position];
        if (argument?.kind !== 'identifier' || argument.reference.kind !== 'binding') continue;
        const groupKey = module.sharedArrays.groupByBindingId.get(argument.reference.binding.id);
        if (!groupKey) continue;
        for (const id of module.sharedArrays.groupsByKey.get(groupKey) ?? []) {
          module.sharedArrays.bindingIds.add(id);
        }
      }
    }
  }
}

function createRustSharedClassAnalysis(
  module: Readonly<IrModule>,
  ownership: RustReferenceModuleRecord['ownership'],
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
  classBindingIds: ReadonlySet<string>,
): RustSharedClassAnalysis {
  const parents = new Map<string, string>();
  const aliasEdges: Array<readonly [string, string]> = [];
  const ambiguousBindingIds = new Set<string>();
  const carrierTypesByBindingId = new Map<string, RustSharedClassCarrierType>();
  const variablesByBindingId = new Map<string, RustSharedClassVariable>();
  const find = (id: string): string => {
    const parent = parents.get(id);
    if (!parent || parent === id) return id;
    const root = find(parent);
    parents.set(id, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    if (!parents.has(left)) parents.set(left, left);
    if (!parents.has(right)) parents.set(right, right);
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
  };

  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if (!('binding' in variable)) return;
      const type = bindingTypes.get(variable.binding.id);
      const carrier = getRustSharedClassCarrierTypeCandidate(type, module, classBindingIds);
      if (!carrier) return;
      carrierTypesByBindingId.set(variable.binding.id, carrier);
      variablesByBindingId.set(variable.binding.id, {
        binding: variable.binding,
        carrier,
        initializer: variable.initializer,
        mutable: variable.mutable,
        type,
      });
      if (variable.initializer?.kind === 'conditional') {
        const alternatives = new Set(
          [variable.initializer.whenTrue, variable.initializer.whenFalse].flatMap((alternative) =>
            alternative.kind === 'identifier' &&
            alternative.reference.kind === 'binding' &&
            getRustSharedClassCarrierTypeCandidate(
              bindingTypes.get(alternative.reference.binding.id),
              module,
              classBindingIds,
            )
              ? [alternative.reference.binding.id]
              : [],
          ),
        );
        if (alternatives.size > 1) ambiguousBindingIds.add(variable.binding.id);
      }
      if (variable.initializer?.kind !== 'identifier' || variable.initializer.reference.kind !== 'binding') {
        return;
      }
      const sourceId = variable.initializer.reference.binding.id;
      const sourceCarrier = getRustSharedClassCarrierTypeCandidate(bindingTypes.get(sourceId), module, classBindingIds);
      if (!sourceCarrier) return;
      carrierTypesByBindingId.set(sourceId, sourceCarrier);
      const edge = [variable.binding.id, variable.initializer.reference.binding.id] as const;
      aliasEdges.push(edge);
      union(...edge);
    },
  });

  const groups = new Map<string, Set<string>>();
  for (const [left, right] of aliasEdges) {
    const root = find(left);
    const group = groups.get(root) ?? new Set<string>();
    group.add(left);
    group.add(right);
    groups.set(root, group);
  }
  const evidenceById = new Map(ownership.bindings.map((evidence) => [evidence.binding.id, evidence]));
  const bindingRepresentations = new Map<string, RustSharedClassRepresentation>();
  const groupByBindingId = new Map<string, string>();
  const groupsByKey = new Map<string, ReadonlySet<string>>();
  for (const group of groups.values()) {
    const groupKey = [...group].sort(compareTextCodeUnits)[0]!;
    groupsByKey.set(groupKey, group);
    for (const id of group) groupByBindingId.set(id, groupKey);
    if (
      [...group].some((id) => {
        const mutation = evidenceById.get(id)?.mutation;
        return mutation === 'referentMutated' || mutation === 'bindingAndReferent';
      })
    ) {
      for (const id of group) {
        const carrier = carrierTypesByBindingId.get(id);
        if (carrier) bindingRepresentations.set(id, carrier.representation);
      }
    }
  }
  for (const [id, carrier] of carrierTypesByBindingId) {
    if (variablesByBindingId.has(id) && carrier.representation !== 'shared-ref-cell-class') {
      bindingRepresentations.set(id, carrier.representation);
    }
  }
  return {
    ambiguousBindingIds,
    bindingRepresentations,
    carrierTypesByBindingId,
    groupByBindingId,
    groupsByKey,
    variablesByBindingId,
  };
}

function activateRustSharedClassBinding(analysis: RustSharedClassAnalysis, id: string): void {
  const carrier = analysis.carrierTypesByBindingId.get(id);
  if (carrier && analysis.variablesByBindingId.has(id)) {
    analysis.bindingRepresentations.set(id, carrier.representation);
  }
}

function activateRustSharedClassGroup(analysis: RustSharedClassAnalysis, groupKey: string): void {
  for (const id of analysis.groupsByKey.get(groupKey) ?? []) activateRustSharedClassBinding(analysis, id);
}

function hasRustSharedClassBinding(analysis: RustSharedClassAnalysis, id: string): boolean {
  return analysis.bindingRepresentations.has(id);
}

function activateRustSharedClassAliasGroups(
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): void {
  // A source alias preserves both names even when neither mutates the object. Elect the shared carrier
  // only after proving the whole local group, because a raw Rust move would invalidate the earlier name.
  for (const module of modules) {
    const evidenceById = new Map(module.ownership.bindings.map((evidence) => [evidence.binding.id, evidence]));
    for (const group of module.sharedClasses.groupsByKey.values()) {
      const variables = [...group].flatMap((id) => {
        const variable = module.sharedClasses.variablesByBindingId.get(id);
        return variable ? [variable] : [];
      });
      const parameterIds = [...group].filter((id) => {
        if (module.sharedClasses.variablesByBindingId.has(id)) return false;
        const function_ = module.functions.find((candidate) =>
          candidate.declaration.parameters.some((parameter) => parameter.binding.id === id),
        );
        const position = function_?.declaration.parameters.findIndex((parameter) => parameter.binding.id === id);
        return Boolean(
          function_ &&
          position !== undefined &&
          position >= 0 &&
          getRustReferenceOptionalClassParameterPlans(function_, module, modules, moduleResolution).has(position),
        );
      });
      const firstCarrier = [...group].flatMap((id) => {
        const carrier = module.sharedClasses.carrierTypesByBindingId.get(id);
        return carrier ? [carrier] : [];
      })[0];
      if (
        variables.length + parameterIds.length !== group.size ||
        !firstCarrier ||
        !isRustSharedClassTypeSupported(firstCarrier.classType, module, modules, moduleResolution) ||
        parameterIds.some((id) => {
          const carrier = module.sharedClasses.carrierTypesByBindingId.get(id);
          return (
            !carrier ||
            !isRustReferenceSameClassCarrier(carrier, module, firstCarrier, module, modules, moduleResolution)
          );
        }) ||
        variables.some((variable) => {
          const evidence = evidenceById.get(variable.binding.id);
          return (
            variable.mutable ||
            !isRustReferenceSameClassCarrier(
              variable.carrier,
              module,
              firstCarrier,
              module,
              modules,
              moduleResolution,
            ) ||
            !evidence ||
            evidence.declaration !== 'immutable' ||
            evidence.binding.scope === 'module'
          );
        })
      ) {
        continue;
      }
      const roots = variables.filter((variable) => {
        const initializer = variable.initializer;
        return !(
          initializer?.kind === 'identifier' &&
          initializer.reference.kind === 'binding' &&
          group.has(initializer.reference.binding.id)
        );
      });
      if (roots.length + parameterIds.length !== 1) continue;
      const represented = variables.every((variable) => {
        const initializer = variable.initializer;
        return (
          (initializer?.kind === 'identifier' &&
            initializer.reference.kind === 'binding' &&
            group.has(initializer.reference.binding.id)) ||
          (initializer !== undefined &&
            isRustReferenceClassCarrierExpressionCompatible(
              initializer,
              variable.carrier,
              module,
              modules,
              moduleResolution,
            ))
        );
      });
      if (!represented) continue;
      for (const id of group) activateRustSharedClassBinding(module.sharedClasses, id);
    }
  }
}

function createRustSharedHashCollectionAnalysis(
  module: Readonly<IrModule>,
  ownership: RustReferenceModuleRecord['ownership'],
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
  kind: RustSharedHashCollectionKind,
): RustSharedHashCollectionAnalysis {
  const parents = new Map<string, string>();
  const aliasEdges: Array<readonly [string, string]> = [];
  const ambiguousBindingIds = new Set<string>();
  const variablesByBindingId = new Map<string, RustSharedHashCollectionVariable>();
  const find = (id: string): string => {
    const parent = parents.get(id);
    if (!parent || parent === id) return id;
    const root = find(parent);
    parents.set(id, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    if (!parents.has(left)) parents.set(left, left);
    if (!parents.has(right)) parents.set(right, right);
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
  };

  analyzeIrModuleTraversal(module, {
    variable(variable) {
      if (!('binding' in variable)) return;
      const type = bindingTypes.get(variable.binding.id);
      if (!isRustHashCollectionLikeType(type, module, kind)) return;
      variablesByBindingId.set(variable.binding.id, {
        binding: variable.binding,
        initializer: variable.initializer,
        mutable: variable.mutable,
        type,
      });
      if (variable.initializer?.kind === 'conditional') {
        const alternatives = new Set(
          [variable.initializer.whenTrue, variable.initializer.whenFalse].flatMap((alternative) =>
            alternative.kind === 'identifier' &&
            alternative.reference.kind === 'binding' &&
            isRustHashCollectionLikeType(bindingTypes.get(alternative.reference.binding.id), module, kind)
              ? [alternative.reference.binding.id]
              : [],
          ),
        );
        if (alternatives.size > 1) ambiguousBindingIds.add(variable.binding.id);
      }
      if (
        variable.initializer?.kind !== 'identifier' ||
        variable.initializer.reference.kind !== 'binding' ||
        !isRustHashCollectionLikeType(bindingTypes.get(variable.initializer.reference.binding.id), module, kind)
      ) {
        return;
      }
      const edge = [variable.binding.id, variable.initializer.reference.binding.id] as const;
      aliasEdges.push(edge);
      union(...edge);
    },
  });

  const groups = new Map<string, Set<string>>();
  for (const [left, right] of aliasEdges) {
    const root = find(left);
    const group = groups.get(root) ?? new Set<string>();
    group.add(left);
    group.add(right);
    groups.set(root, group);
  }
  const evidenceById = new Map(ownership.bindings.map((evidence) => [evidence.binding.id, evidence]));
  const bindingIds = new Set<string>();
  const groupByBindingId = new Map<string, string>();
  const groupsByKey = new Map<string, ReadonlySet<string>>();
  for (const group of groups.values()) {
    const groupKey = [...group].sort(compareTextCodeUnits)[0]!;
    groupsByKey.set(groupKey, group);
    for (const id of group) groupByBindingId.set(id, groupKey);
    if (
      [...group].some((id) => {
        const mutation = evidenceById.get(id)?.mutation;
        return mutation === 'referentMutated' || mutation === 'bindingAndReferent';
      })
    ) {
      for (const id of group) bindingIds.add(id);
    }
  }
  return { ambiguousBindingIds, bindingIds, groupByBindingId, groupsByKey, kind, variablesByBindingId };
}

function activateRustSharedHashCollectionCallMutations(
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  kind: RustSharedHashCollectionKind,
): void {
  for (const module of modules) {
    const analysis = getRustSharedHashCollectionAnalysis(module, kind);
    for (const { call } of module.calls) {
      const target = resolveRustReferenceCallTarget(call, module, modules, moduleResolution);
      if (target.kind !== 'function') {
        for (const argument of call.arguments) {
          activateRustSharedHashCollectionGroupsUsedInExpression(analysis, argument);
        }
        continue;
      }
      for (const position of getRustReferenceAnyHashCollectionMutationPositions(target.function, kind)) {
        const argument = call.arguments[position];
        if (argument) activateRustSharedHashCollectionGroupsUsedInExpression(analysis, argument);
      }
    }
  }
}

function activateRustSharedHashCollectionUnsupportedUses(
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  kind: RustSharedHashCollectionKind,
): void {
  for (const module of modules) {
    const analysis = getRustSharedHashCollectionAnalysis(module, kind);
    analyzeIrModuleTraversal(module.module, {
      expression(expression, path_) {
        if (
          expression.kind !== 'identifier' ||
          expression.reference.kind !== 'binding' ||
          !analysis.groupByBindingId.has(expression.reference.binding.id) ||
          isRustSharedHashCollectionIdentifierUseRepresented(module, modules, moduleResolution, expression, path_, kind)
        ) {
          return;
        }
        const groupKey = analysis.groupByBindingId.get(expression.reference.binding.id)!;
        for (const id of analysis.groupsByKey.get(groupKey) ?? []) analysis.bindingIds.add(id);
      },
    });
  }
}

function activateRustSharedHashCollectionGroupsUsedInExpression(
  analysis: RustSharedHashCollectionAnalysis,
  expression: Readonly<IrExpression>,
): void {
  const groupKeys = new Set<string>();
  analyzeIrExpressionSubtreeTraversal(expression, {
    expression(candidate) {
      if (candidate.kind !== 'identifier' || candidate.reference.kind !== 'binding') return undefined;
      const groupKey = analysis.groupByBindingId.get(candidate.reference.binding.id);
      if (groupKey) groupKeys.add(groupKey);
      return undefined;
    },
  });
  for (const groupKey of groupKeys) {
    for (const id of analysis.groupsByKey.get(groupKey) ?? []) analysis.bindingIds.add(id);
  }
}

function activateRustSharedClassCallMutations(
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): void {
  for (const module of modules) {
    for (const { call } of module.calls) {
      const target = resolveRustReferenceCallTarget(call, module, modules, moduleResolution);
      if (target.kind !== 'function') {
        const method = getRustSimpleClassMethodCall(call, module, modules, moduleResolution);
        if (method) {
          for (const position of method.plan.optionalClassParameters.keys()) {
            const argument = call.arguments[position];
            if (argument) activateRustSharedClassCarrierBindingsUsedInExpression(module, argument);
          }
          for (const position of method.plan.requiredClassParameters.keys()) {
            const argument = call.arguments[position];
            if (argument) activateRustSharedClassGroupsUsedInExpression(module, argument);
          }
          continue;
        }
        for (const argument of call.arguments) activateRustSharedClassGroupsUsedInExpression(module, argument);
        continue;
      }
      for (const position of getRustReferenceOptionalClassParameterPlans(
        target.function,
        target.module,
        modules,
        moduleResolution,
      ).keys()) {
        const argument = call.arguments[position];
        if (argument) activateRustSharedClassCarrierBindingsUsedInExpression(module, argument);
      }
      for (const position of getRustReferenceClassBorrowPositions(
        target.function,
        target.module,
        modules,
        moduleResolution,
      )) {
        const argument = call.arguments[position];
        if (argument) activateRustSharedClassGroupsUsedInExpression(module, argument);
      }
    }
  }
}

function activateRustSharedClassCarrierBindingsUsedInExpression(
  module: RustReferenceModuleRecord,
  expression: Readonly<IrExpression>,
): void {
  analyzeIrExpressionSubtreeTraversal(expression, {
    expression(candidate) {
      if (candidate.kind !== 'identifier' || candidate.reference.kind !== 'binding') return undefined;
      const id = candidate.reference.binding.id;
      activateRustSharedClassBinding(module.sharedClasses, id);
      const groupKey = module.sharedClasses.groupByBindingId.get(id);
      if (groupKey) activateRustSharedClassGroup(module.sharedClasses, groupKey);
      return undefined;
    },
  });
}

function activateRustOptionalSharedClassInitializers(modules: readonly RustReferenceModuleRecord[]): void {
  for (const module of modules) {
    for (const variable of module.sharedClasses.variablesByBindingId.values()) {
      if (variable.carrier.sentinel && variable.initializer) {
        activateRustSharedClassCarrierBindingsUsedInExpression(module, variable.initializer);
      }
    }
  }
}

function activateRustSharedClassReturnBindings(
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): void {
  for (const module of modules) {
    for (const variable of module.sharedClasses.variablesByBindingId.values()) {
      if (
        !variable.initializer ||
        !isRustReferenceSharedClassReturnCall(variable.initializer, module, modules, moduleResolution)
      ) {
        continue;
      }
      activateRustSharedClassBinding(module.sharedClasses, variable.binding.id);
      const groupKey = module.sharedClasses.groupByBindingId.get(variable.binding.id);
      if (!groupKey) continue;
      activateRustSharedClassGroup(module.sharedClasses, groupKey);
    }
  }
}

function activateRustSharedClassFunctionReturnAliases(
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): void {
  for (const module of modules) {
    for (const function_ of module.functions) {
      if (!isRustReferenceClassReturnSupported(function_, module, modules, moduleResolution, new Set())) continue;
      const expression = getRustReferenceClassReturnExpression(function_);
      if (expression) activateRustSharedClassCarrierBindingsUsedInExpression(module, expression);
    }
  }
}

function activateRustSharedClassIdentityComparisons(
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): void {
  for (const module of modules) {
    analyzeIrModuleTraversal(module.module, {
      expression(expression) {
        if (
          expression.kind !== 'binary' ||
          !isRustReferenceClassIdentityComparisonSupported(expression, module, modules, moduleResolution)
        ) {
          return;
        }
        activateRustSharedClassIdentityOperand(module, expression.left);
        activateRustSharedClassIdentityOperand(module, expression.right);
      },
    });
  }
}

function activateRustSharedClassIdentityOperand(
  module: RustReferenceModuleRecord,
  expression: Readonly<IrExpression>,
): void {
  if (expression.kind !== 'identifier' || expression.reference.kind !== 'binding') return;
  const bindingId = expression.reference.binding.id;
  activateRustSharedClassBinding(module.sharedClasses, bindingId);
  const groupKey = module.sharedClasses.groupByBindingId.get(bindingId);
  if (!groupKey) return;
  activateRustSharedClassGroup(module.sharedClasses, groupKey);
}

function activateRustSharedClassUnsupportedUses(
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): void {
  for (const module of modules) {
    analyzeIrModuleTraversal(module.module, {
      expression(expression, path_) {
        if (
          expression.kind !== 'identifier' ||
          expression.reference.kind !== 'binding' ||
          !module.sharedClasses.groupByBindingId.has(expression.reference.binding.id) ||
          isRustSharedClassIdentifierUseRepresented(module, modules, moduleResolution, expression, path_)
        ) {
          return;
        }
        const groupKey = module.sharedClasses.groupByBindingId.get(expression.reference.binding.id)!;
        for (const id of module.sharedClasses.groupsByKey.get(groupKey) ?? []) {
          activateRustSharedClassBinding(module.sharedClasses, id);
        }
      },
    });
  }
}

function activateRustSharedClassMethodMutations(
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): void {
  for (const module of modules) {
    for (const { call } of module.calls) {
      const method = getRustSimpleClassMethodCall(call, module, modules, moduleResolution);
      if (!method || (!method.mutating && !method.plan.async)) continue;
      activateRustSharedClassGroupsUsedInExpression(module, method.receiver);
    }
  }
}

function activateRustSharedClassGroupsUsedInExpression(
  module: RustReferenceModuleRecord,
  expression: Readonly<IrExpression>,
): void {
  const groupKeys = new Set<string>();
  analyzeIrExpressionSubtreeTraversal(expression, {
    expression(candidate) {
      if (candidate.kind !== 'identifier' || candidate.reference.kind !== 'binding') return undefined;
      const bindingId = candidate.reference.binding.id;
      activateRustSharedClassBinding(module.sharedClasses, bindingId);
      const groupKey = module.sharedClasses.groupByBindingId.get(bindingId);
      if (groupKey) groupKeys.add(groupKey);
      return undefined;
    },
  });
  for (const groupKey of groupKeys) {
    for (const id of module.sharedClasses.groupsByKey.get(groupKey) ?? []) {
      activateRustSharedClassBinding(module.sharedClasses, id);
    }
  }
}

function addRustSharedArrayRefusals(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  for (const id of module.sharedArrays.ambiguousBindingIds) {
    const evidence = module.ownership.bindings.find((candidate) => candidate.binding.id === id);
    const mutatedByCall = module.calls.some(({ call }) => {
      const target = resolveRustReferenceCallTarget(call, module, modules, moduleResolution);
      return (
        target.kind === 'function' &&
        [...getRustReferenceArrayMutationPositions(target.function)].some((position) => {
          const argument = call.arguments[position];
          return (
            argument?.kind === 'identifier' &&
            argument.reference.kind === 'binding' &&
            argument.reference.binding.id === id
          );
        })
      );
    });
    if (
      !evidence ||
      (!mutatedByCall && evidence.mutation !== 'referentMutated' && evidence.mutation !== 'bindingAndReferent')
    ) {
      continue;
    }
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-array-alias-ambiguous',
      `${moduleKey(module.module)}:${id}`,
      `mutable array alias ${evidence.binding.name} has multiple possible source identity groups`,
    );
  }
  if (module.sharedArrays.bindingIds.size === 0) return;
  for (const evidence of module.ownership.bindings) {
    if (!module.sharedArrays.bindingIds.has(evidence.binding.id)) continue;
    const subject = `${moduleKey(module.module)}:${evidence.binding.id}`;
    if (evidence.binding.scope === 'module' || evidence.declaration === 'parameter') {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-array-use-unrepresented',
        subject,
        `shared array binding ${evidence.binding.name} is outside the supported local-variable carrier`,
      );
    }
    if (evidence.mutation === 'bindingReassigned' || evidence.mutation === 'bindingAndReferent') {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-array-binding-reassignment-unrepresented',
        subject,
        `shared array binding ${evidence.binding.name} is reassigned after alias creation`,
      );
    }
    if (evidence.boundaries.includes('suspension')) {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-array-suspension-unrepresented',
        subject,
        `shared array binding ${evidence.binding.name} crosses a suspension boundary`,
      );
    }
  }

  for (const closure of analyzeIrModuleClosureEvidence(module.module).closures) {
    const captures = closure.captures.filter((capture) => module.sharedArrays.bindingIds.has(capture.binding.id));
    if (captures.length === 0) continue;
    const subject = `${moduleKey(module.module)}:closure:${JSON.stringify(closure.path)}`;
    if (
      closure.async ||
      closure.suspensions.length > 0 ||
      captures.some((capture) => capture.lifetimeBoundaries.includes('suspension'))
    ) {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-array-suspension-unrepresented',
        subject,
        'shared array closure capture crosses an async or suspension boundary',
      );
    }
    if (closure.escape === 'mayEscape') {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-array-closure-escape-unrepresented',
        subject,
        'shared array closure capture may escape into a lifetime or Send context not represented by Rc<RefCell<_>>',
      );
    }
  }

  analyzeIrModuleTraversal(module.module, {
    expression(expression, path_) {
      if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
        if (!module.sharedArrays.bindingIds.has(expression.reference.binding.id)) return;
        if (!isRustSharedArrayIdentifierUseRepresented(module, modules, moduleResolution, expression, path_)) {
          addRustReferenceRefusal(
            refusals,
            'rust-reference-shared-array-use-unrepresented',
            `${moduleKey(module.module)}:${expression.reference.binding.id}:${JSON.stringify(path_)}`,
            `shared array binding ${expression.reference.binding.name} is used outside a proven temporary borrow scope`,
          );
        }
        return;
      }
      if (expression.kind === 'call') {
        addRustSharedArrayMemberBorrowConflictRefusal(module, expression, path_, refusals);
        return;
      }
      if (expression.kind === 'assignment') {
        addRustSharedArrayElementBorrowConflictRefusal(module, expression, path_, refusals);
      }
    },
  });
}

function isRustSharedArrayIdentifierUseRepresented(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  expression: Readonly<Extract<IrExpression, { kind: 'identifier' }>>,
  path_: CompilerIrTraversalPath,
): boolean {
  const parent = path_.length > 0 ? getIrModuleTraversalPathValue(module.module, path_.slice(0, -1)) : undefined;
  const final = path_.at(-1);
  if (
    final === 'initializer' &&
    isRecord(parent) &&
    'binding' in parent &&
    isBindingIdentity(parent.binding) &&
    module.sharedArrays.bindingIds.has(parent.binding.id)
  ) {
    return true;
  }
  if (final === 'object' && isIrExpressionValue(parent) && (parent.kind === 'property' || parent.kind === 'element')) {
    if (parent.kind === 'element') return parent.optional === false;
    if (parent.optional || parent.member?.receiver !== 'array') return false;
    if (parent.name === 'length') return true;
    const propertyPath = path_.slice(0, -1);
    const propertyParent =
      propertyPath.length > 0 ? getIrModuleTraversalPathValue(module.module, propertyPath.slice(0, -1)) : undefined;
    return (
      propertyPath.at(-1) === 'callee' && isCallExpression(propertyParent) && RUST_SHARED_ARRAY_METHODS.has(parent.name)
    );
  }
  if (path_.at(-2) === 'arguments' && typeof path_.at(-1) === 'number') {
    const call = getIrModuleTraversalPathValue(module.module, path_.slice(0, -2));
    if (!isCallExpression(call)) return false;
    const position = path_.at(-1) as number;
    if (position === 0 && isRustReferenceArrayIsArrayCall(call)) return true;
    if (isRustReferenceArrayOfCall(call)) return true;
    if (position === 0 && isRustReferenceArrayFromCall(call)) return true;
    if (
      position === 0 &&
      call.callee.kind === 'property' &&
      call.callee.member?.receiver === 'array' &&
      call.callee.member.name === 'concat'
    ) {
      return true;
    }
    const target = resolveRustReferenceCallTarget(call, module, modules, moduleResolution);
    return target.kind === 'function' && getRustReferenceArrayMutationPositions(target.function).has(position);
  }
  return false;
}

function addRustSharedArrayMemberBorrowConflictRefusal(
  module: RustReferenceModuleRecord,
  call: IrCallExpression,
  path_: CompilerIrTraversalPath,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  if (
    call.callee.kind !== 'property' ||
    call.callee.member?.receiver !== 'array' ||
    !RUST_SHARED_ARRAY_BORROW_CONFLICT_METHODS.has(call.callee.member.name) ||
    call.callee.object.kind !== 'identifier' ||
    call.callee.object.reference.kind !== 'binding'
  ) {
    return;
  }
  const receiverId = call.callee.object.reference.binding.id;
  const group = module.sharedArrays.groupByBindingId.get(receiverId);
  if (
    !group ||
    !call.arguments.some((argument) => {
      if (
        call.callee.kind === 'property' &&
        call.callee.member?.name === 'concat' &&
        argument.kind === 'identifier' &&
        argument.reference.kind === 'binding' &&
        module.sharedArrays.groupByBindingId.get(argument.reference.binding.id) === group
      ) {
        return false;
      }
      return expressionUsesRustSharedArrayGroup(argument, group, module);
    })
  ) {
    return;
  }
  addRustReferenceRefusal(
    refusals,
    'rust-reference-shared-array-borrow-conflict',
    `${moduleKey(module.module)}:${receiverId}:${JSON.stringify(path_)}`,
    RUST_SHARED_ARRAY_MUTATING_METHODS.has(call.callee.member.name)
      ? `shared array mutation ${call.callee.member.name} reads the same alias group while its mutable borrow is active`
      : `shared array method ${call.callee.member.name} reads the same alias group across its receiver borrow`,
  );
}

function addRustSharedArrayElementBorrowConflictRefusal(
  module: RustReferenceModuleRecord,
  assignment: Readonly<Extract<IrExpression, { kind: 'assignment' }>>,
  path_: CompilerIrTraversalPath,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  if (
    assignment.left.kind !== 'element' ||
    assignment.left.object.kind !== 'identifier' ||
    assignment.left.object.reference.kind !== 'binding'
  ) {
    return;
  }
  const receiverId = assignment.left.object.reference.binding.id;
  const group = module.sharedArrays.groupByBindingId.get(receiverId);
  if (
    !group ||
    (!expressionUsesRustSharedArrayGroup(assignment.left.index, group, module) &&
      !expressionUsesRustSharedArrayGroup(assignment.right, group, module))
  ) {
    return;
  }
  addRustReferenceRefusal(
    refusals,
    'rust-reference-shared-array-borrow-conflict',
    `${moduleKey(module.module)}:${receiverId}:${JSON.stringify(path_)}`,
    'shared array element mutation reads the same alias group while its mutable borrow is active',
  );
}

function addRustSharedArrayCallBorrowConflictRefusal(
  module: RustReferenceModuleRecord,
  call: IrCallExpression,
  borrowedPosition: number,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  const argument = call.arguments[borrowedPosition];
  if (argument?.kind !== 'identifier' || argument.reference.kind !== 'binding') return;
  const argumentId = argument.reference.binding.id;
  const group = module.sharedArrays.groupByBindingId.get(argumentId);
  if (
    !group ||
    !call.arguments.some(
      (candidate, position) =>
        position !== borrowedPosition && expressionUsesRustSharedArrayGroup(candidate, group, module),
    )
  ) {
    return;
  }
  addRustReferenceRefusal(
    refusals,
    'rust-reference-shared-array-borrow-conflict',
    `${moduleKey(module.module)}:${call.callee.kind}:${call.callee.kind === 'identifier' && call.callee.reference.kind === 'binding' ? call.callee.reference.binding.id : 'call'}:${String(borrowedPosition)}`,
    `call argument ${String(borrowedPosition)} mutably borrows a shared array while another argument reads the same alias group`,
  );
}

function expressionUsesRustSharedArrayGroup(
  expression: Readonly<IrExpression>,
  group: string,
  module: RustReferenceModuleRecord,
): boolean {
  let found = false;
  const referencedBindings = new Set<string>();
  analyzeIrExpressionSubtreeTraversal(expression, {
    expression(candidate) {
      if (candidate.kind === 'identifier' && candidate.reference.kind === 'binding') {
        referencedBindings.add(candidate.reference.binding.id);
        if (module.sharedArrays.groupByBindingId.get(candidate.reference.binding.id) === group) {
          found = true;
          return false;
        }
      }
      return undefined;
    },
  });
  if (found) return true;
  for (const closure of analyzeIrModuleClosureEvidence(module.module).closures) {
    const originBinding =
      closure.origin.kind === 'functionExpression' || closure.origin.kind === 'functionDeclaration'
        ? closure.origin.binding
        : undefined;
    const host =
      closure.path.at(-1) === 'initializer'
        ? getIrModuleTraversalPathValue(module.module, closure.path.slice(0, -1))
        : undefined;
    const hostBinding =
      isRecord(host) && 'binding' in host && isBindingIdentity(host.binding) ? host.binding : undefined;
    const callbackBinding = originBinding ?? hostBinding;
    if (
      callbackBinding &&
      referencedBindings.has(callbackBinding.id) &&
      closure.captures.some((capture) => module.sharedArrays.groupByBindingId.get(capture.binding.id) === group)
    ) {
      return true;
    }
  }
  return found;
}

function addRustOptionalClassCarrierBoundaryRefusals(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  for (const evidence of module.ownership.bindings) {
    if (!isRustPotentialOptionalClassCarrierType(evidence.type, module.module, module.classBindingIds)) continue;
    if (getRustOptionalSharedClassCarrierType(evidence.type, module, modules, moduleResolution)) continue;
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-type-unrepresented',
      `${moduleKey(module.module)}:${evidence.binding.id}:optional-carrier`,
      `class carrier ${evidence.binding.name} must be exactly one supported simple class plus exactly null or undefined`,
    );
  }
}

function isRustPotentialOptionalClassCarrierType(
  type: Readonly<IrType>,
  module: Readonly<IrModule>,
  classBindingIds: ReadonlySet<string>,
  resolving: ReadonlySet<string> = new Set(),
): boolean {
  const facts = getRustPotentialOptionalClassCarrierFacts(type, module, classBindingIds, resolving);
  return facts.classLike && facts.sentinel;
}

function getRustPotentialOptionalClassCarrierFacts(
  type: Readonly<IrType>,
  module: Readonly<IrModule>,
  classBindingIds: ReadonlySet<string>,
  resolving: ReadonlySet<string>,
): Readonly<{ classLike: boolean; sentinel: boolean }> {
  if (type.kind === 'null' || type.kind === 'undefined') return { classLike: false, sentinel: true };
  if (type.kind === 'array') {
    return getRustPotentialOptionalClassCarrierFacts(type.element, module, classBindingIds, resolving);
  }
  if (type.kind === 'tuple') {
    return combineRustOptionalClassCarrierFacts(
      type.elements.map((element) =>
        getRustPotentialOptionalClassCarrierFacts(element.type, module, classBindingIds, resolving),
      ),
    );
  }
  if (type.kind === 'object') {
    return combineRustOptionalClassCarrierFacts(
      type.properties.map((property) =>
        getRustPotentialOptionalClassCarrierFacts(property.type, module, classBindingIds, resolving),
      ),
    );
  }
  if (type.kind === 'union' || type.kind === 'intersection') {
    return combineRustOptionalClassCarrierFacts(
      type.types.map((member) => getRustPotentialOptionalClassCarrierFacts(member, module, classBindingIds, resolving)),
    );
  }
  if (type.kind !== 'named') return { classLike: false, sentinel: false };
  if (
    type.reference.kind === 'binding' &&
    type.reference.path.length === 0 &&
    !resolving.has(type.reference.binding.id)
  ) {
    const bindingId = type.reference.binding.id;
    const declaration = module.declarations.find(
      (candidate) => candidate.kind === 'typeAlias' && candidate.binding.id === bindingId,
    );
    if (declaration?.kind === 'typeAlias') {
      return getRustPotentialOptionalClassCarrierFacts(
        declaration.type,
        module,
        classBindingIds,
        new Set(resolving).add(bindingId),
      );
    }
    if (classBindingIds.has(bindingId)) return { classLike: true, sentinel: false };
  }
  return combineRustOptionalClassCarrierFacts(
    type.typeArguments.map((argument) =>
      getRustPotentialOptionalClassCarrierFacts(argument, module, classBindingIds, resolving),
    ),
  );
}

function combineRustOptionalClassCarrierFacts(
  facts: readonly Readonly<{ classLike: boolean; sentinel: boolean }>[],
): Readonly<{ classLike: boolean; sentinel: boolean }> {
  return {
    classLike: facts.some((fact) => fact.classLike),
    sentinel: facts.some((fact) => fact.sentinel),
  };
}

function addRustSharedClassRefusals(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  for (const id of module.sharedClasses.ambiguousBindingIds) {
    const evidence = module.ownership.bindings.find((candidate) => candidate.binding.id === id);
    const mutatedByCall = module.calls.some(({ call }) => {
      const target = resolveRustReferenceCallTarget(call, module, modules, moduleResolution);
      return (
        target.kind === 'function' &&
        [...getRustReferenceAnyClassMutationPositions(target.function, target.module)].some((position) => {
          const argument = call.arguments[position];
          return (
            argument?.kind === 'identifier' &&
            argument.reference.kind === 'binding' &&
            argument.reference.binding.id === id
          );
        })
      );
    });
    if (!evidence) continue;
    const optionalCarrier = module.sharedClasses.carrierTypesByBindingId.get(id)?.sentinel !== undefined;
    if (
      !optionalCarrier &&
      !mutatedByCall &&
      evidence.mutation !== 'referentMutated' &&
      evidence.mutation !== 'bindingAndReferent'
    ) {
      continue;
    }
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-alias-ambiguous',
      `${moduleKey(module.module)}:${id}`,
      `mutable class alias ${evidence.binding.name} has multiple possible source identity groups`,
    );
  }

  for (const group of module.sharedClasses.groupsByKey.values()) {
    if (![...group].some((id) => hasRustSharedClassBinding(module.sharedClasses, id))) continue;
    const roots = [...group].filter((id) => {
      const variable = module.sharedClasses.variablesByBindingId.get(id);
      if (!variable) {
        return module.ownership.bindings.find((evidence) => evidence.binding.id === id)?.declaration === 'parameter';
      }
      const initializer = variable?.initializer;
      if (
        initializer?.kind === 'identifier' &&
        initializer.reference.kind === 'binding' &&
        group.has(initializer.reference.binding.id)
      ) {
        return false;
      }
      return variable.carrier.representation === 'shared-ref-cell-class'
        ? isRustSimpleClassConstruction(initializer, variable.carrier.classType, module, modules, moduleResolution) ||
            (initializer !== undefined &&
              isRustReferenceSharedClassReturnCall(initializer, module, modules, moduleResolution))
        : initializer !== undefined &&
            isRustReferenceClassCarrierExpressionCompatible(
              initializer,
              variable.carrier,
              module,
              modules,
              moduleResolution,
            );
    });
    if (roots.length !== 1) {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-construction-unrepresented',
        `${moduleKey(module.module)}:group:${[...group].sort(compareTextCodeUnits).join(',')}`,
        'shared class alias group must have exactly one local represented construction root',
      );
    }
    const classKeys = new Set<string>();
    for (const id of group) {
      const variable = module.sharedClasses.variablesByBindingId.get(id);
      const parameter =
        module.ownership.bindings.find((evidence) => evidence.binding.id === id)?.declaration === 'parameter';
      const initializer = variable?.initializer;
      const aliasInitializer =
        initializer?.kind === 'identifier' &&
        initializer.reference.kind === 'binding' &&
        group.has(initializer.reference.binding.id);
      if (
        (!variable && !parameter) ||
        variable?.mutable ||
        (variable &&
          !aliasInitializer &&
          (!initializer ||
            (variable.carrier.representation === 'shared-ref-cell-class'
              ? initializer.kind !== 'new' &&
                !isRustReferenceSharedClassReturnCall(initializer, module, modules, moduleResolution)
              : !isRustReferenceClassCarrierExpressionCompatible(
                  initializer,
                  variable.carrier,
                  module,
                  modules,
                  moduleResolution,
                ))))
      ) {
        addRustReferenceRefusal(
          refusals,
          'rust-reference-shared-class-use-unrepresented',
          `${moduleKey(module.module)}:${id}`,
          `shared class binding ${variable?.binding.name ?? id} is not an initialized local const in the alias group`,
        );
      }
      const location = getRustReferenceClassDeclaration(
        module.sharedClasses.carrierTypesByBindingId.get(id)?.classType,
        module,
        modules,
        moduleResolution,
      );
      if (location) classKeys.add(`${moduleKey(location.module.module)}:${location.declaration.binding.id}`);
    }
    if (classKeys.size > 1) {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-alias-ambiguous',
        `${moduleKey(module.module)}:group:${[...group].sort(compareTextCodeUnits).join(',')}`,
        'shared class alias group spans more than one named class identity',
      );
    }
  }

  for (const evidence of module.ownership.bindings) {
    const plannedCarrier = getRustReferencePlannedClassBindingCarrier(
      evidence.binding.id,
      module,
      modules,
      moduleResolution,
    );
    if (!plannedCarrier) continue;
    const subject = `${moduleKey(module.module)}:${evidence.binding.id}`;
    const location = getRustReferenceClassDeclaration(plannedCarrier.classType, module, modules, moduleResolution);
    if (!location) {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-type-unrepresented',
        subject,
        `shared class binding ${evidence.binding.name} must retain one exact non-generic named class type`,
      );
    } else {
      addRustSimpleClassDeclarationRefusals(
        location.declaration,
        location.module,
        modules,
        moduleResolution,
        subject,
        refusals,
      );
    }
    const parameterFunction =
      evidence.declaration === 'parameter'
        ? module.functions.find((candidate) =>
            candidate.declaration.parameters.some((parameter) => parameter.binding.id === evidence.binding.id),
          )
        : undefined;
    const parameterPosition = parameterFunction?.declaration.parameters.findIndex(
      (parameter) => parameter.binding.id === evidence.binding.id,
    );
    const plannedFunctionParameter =
      parameterFunction && parameterPosition !== undefined && parameterPosition >= 0
        ? getRustReferenceOptionalClassParameterPlans(parameterFunction, module, modules, moduleResolution).has(
            parameterPosition,
          )
        : false;
    const parameterClass =
      evidence.declaration === 'parameter'
        ? module.module.declarations.find(
            (candidate) =>
              candidate.kind === 'class' &&
              candidate.classConstructor?.parameters.some((parameter) => parameter.binding.id === evidence.binding.id),
          )
        : undefined;
    const constructorParameterPosition =
      parameterClass?.kind === 'class'
        ? parameterClass.classConstructor?.parameters.findIndex(
            (parameter) => parameter.binding.id === evidence.binding.id,
          )
        : undefined;
    const plannedConstructorParameter =
      parameterClass?.kind === 'class' &&
      constructorParameterPosition !== undefined &&
      constructorParameterPosition >= 0
        ? getRustSimpleClassConstructorPlan(
            parameterClass,
            module,
            modules,
            moduleResolution,
            new Set(),
          )?.optionalClassParameters.has(constructorParameterPosition) === true
        : false;
    const parameterMethod =
      evidence.declaration === 'parameter'
        ? module.module.declarations.flatMap((candidate) =>
            candidate.kind === 'class'
              ? candidate.methods.flatMap((method) =>
                  method.parameters.some((parameter) => parameter.binding.id === evidence.binding.id)
                    ? [{ declaration: candidate, method }]
                    : [],
                )
              : [],
          )[0]
        : undefined;
    const methodParameterPosition = parameterMethod?.method.parameters.findIndex(
      (parameter) => parameter.binding.id === evidence.binding.id,
    );
    const plannedMethodParameter =
      parameterMethod && methodParameterPosition !== undefined && methodParameterPosition >= 0
        ? (() => {
            const plan = getRustSimpleClassMethodPlan(
              parameterMethod.method,
              parameterMethod.declaration,
              module,
              modules,
              moduleResolution,
              new Set([`${moduleKey(module.module)}:${parameterMethod.declaration.binding.id}`]),
            );
            return (
              plan?.optionalClassParameters.has(methodParameterPosition) === true ||
              plan?.requiredClassParameters.has(methodParameterPosition) === true
            );
          })()
        : false;
    const plannedParameter = plannedFunctionParameter || plannedConstructorParameter || plannedMethodParameter;
    if (
      evidence.declaration === 'parameter'
        ? !plannedParameter
        : evidence.binding.scope === 'module' || evidence.declaration !== 'immutable'
    ) {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-use-unrepresented',
        subject,
        `shared class binding ${evidence.binding.name} is outside the supported local const carrier`,
      );
    }
    const variable = module.sharedClasses.variablesByBindingId.get(evidence.binding.id);
    if (
      variable?.carrier.sentinel &&
      (!variable.initializer ||
        !isRustReferenceClassCarrierExpressionCompatible(
          variable.initializer,
          variable.carrier,
          module,
          modules,
          moduleResolution,
        ))
    ) {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-construction-unrepresented',
        subject,
        `optional shared class binding ${evidence.binding.name} has no represented matching-sentinel construction root`,
      );
    }
    if (evidence.mutation === 'bindingReassigned' || evidence.mutation === 'bindingAndReferent') {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-binding-reassignment-unrepresented',
        subject,
        `shared class binding ${evidence.binding.name} is reassigned after alias creation`,
      );
    }
    if (
      evidence.boundaries.includes('suspension') &&
      !isRustReferenceExactAsyncMethodReceiverBinding(evidence.binding.id, module, modules, moduleResolution)
    ) {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-suspension-unrepresented',
        subject,
        `shared class binding ${evidence.binding.name} crosses a suspension boundary`,
      );
    }
  }

  for (const closure of analyzeIrModuleClosureEvidence(module.module).closures) {
    const captures = closure.captures.filter(
      (capture) =>
        getRustReferencePlannedClassBindingCarrier(capture.binding.id, module, modules, moduleResolution) !== undefined,
    );
    if (captures.length === 0) continue;
    const subject = `${moduleKey(module.module)}:closure:${JSON.stringify(closure.path)}`;
    if (
      closure.async ||
      closure.suspensions.length > 0 ||
      captures.some((capture) => capture.lifetimeBoundaries.includes('suspension'))
    ) {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-suspension-unrepresented',
        subject,
        'shared class closure capture crosses an async or suspension boundary',
      );
    }
    if (closure.escape === 'mayEscape') {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-closure-escape-unrepresented',
        subject,
        'shared class closure capture may escape into a lifetime or Send context not represented by Rc<RefCell<_>>',
      );
    }
  }

  analyzeIrModuleTraversal(module.module, {
    expression(expression, path_) {
      if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
        if (
          !getRustReferencePlannedClassBindingCarrier(
            expression.reference.binding.id,
            module,
            modules,
            moduleResolution,
          )
        ) {
          return;
        }
        if (!isRustSharedClassIdentifierUseRepresented(module, modules, moduleResolution, expression, path_)) {
          const callArgument = path_.at(-2) === 'arguments' && typeof path_.at(-1) === 'number';
          addRustReferenceRefusal(
            refusals,
            callArgument
              ? 'rust-reference-shared-class-call-unrepresented'
              : 'rust-reference-shared-class-use-unrepresented',
            `${moduleKey(module.module)}:${expression.reference.binding.id}:${JSON.stringify(path_)}`,
            callArgument
              ? `shared class binding ${expression.reference.binding.name} is passed to a call without an exact represented mutable class parameter`
              : `shared class binding ${expression.reference.binding.name} is used outside a proven temporary field borrow`,
          );
        }
        return;
      }
      if (expression.kind === 'assignment') {
        addRustSharedClassFieldBorrowConflictRefusal(module, expression, path_, refusals);
        addRustSharedClassMutatorResultRefusal(module, modules, moduleResolution, expression, path_, refusals);
        return;
      }
      if (expression.kind === 'call') {
        addRustSharedClassMethodBorrowConflictRefusal(module, modules, moduleResolution, expression, path_, refusals);
        return;
      }
      if (expression.kind === 'new') {
        addRustSharedClassConstructorBorrowConflictRefusal(
          module,
          modules,
          moduleResolution,
          expression,
          path_,
          refusals,
        );
      }
    },
  });
}

function addRustSimpleClassDeclarationRefusals(
  declaration: Readonly<IrClassDeclaration>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  subject: string,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  const visitingClasses = new Set([`${moduleKey(module.module)}:${declaration.binding.id}`]);
  for (const method of declaration.methods) {
    if (!method.async) continue;
    const ownerSupported =
      isRustSimpleAsyncClassMethodOwnerSupported(method, declaration) &&
      isRustSimpleClassConstructionSupported(declaration, module, modules, moduleResolution, new Set());
    if (ownerSupported && isRustSimpleAsyncClassMethodBodySupported(method, declaration)) continue;
    addRustReferenceRefusal(
      refusals,
      ownerSupported ? 'rust-async-method-body-unrepresented' : 'rust-async-method-owner-carrier-unrepresented',
      `${subject}:method:${method.name}`,
      ownerSupported
        ? `async method ${declaration.binding.name}.${method.name} uses a body outside the short receiver-field borrow carrier`
        : `async method ${declaration.binding.name}.${method.name} lacks the exact owned simple-class receiver carrier`,
    );
  }
  if (
    declaration.abstract ||
    declaration.extends !== undefined ||
    declaration.implements.length > 0 ||
    declaration.typeParameters.length > 0
  ) {
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-type-unrepresented',
      subject,
      `class ${declaration.binding.name} requires generic, abstract, or inheritance semantics outside the simple-class carrier`,
    );
  }
  for (const method of declaration.methods) {
    if (getRustSimpleClassMethodPlan(method, declaration, module, modules, moduleResolution, visitingClasses)) {
      continue;
    }
    if (method.async) {
      continue;
    }
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-member-unrepresented',
      `${subject}:method:${method.name}`,
      `class ${declaration.binding.name} declares a member outside the synchronous primitive instance-method carrier`,
    );
  }
  if (declaration.fields.length === 0 || declaration.fields.some((field) => !isRustSimpleClassField(field))) {
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-field-unrepresented',
      subject,
      `class ${declaration.binding.name} requires direct, required primitive value-semantic instance fields`,
    );
  }
  if (!isRustSimpleClassConstructionSupported(declaration, module, modules, moduleResolution, new Set())) {
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-construction-unrepresented',
      subject,
      `class ${declaration.binding.name} has no represented primitive field-only construction path`,
    );
  }
}

function isRustSharedClassIdentifierUseRepresented(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  expression: Readonly<Extract<IrExpression, { kind: 'identifier' }>>,
  path_: CompilerIrTraversalPath,
): boolean {
  const parent = path_.length > 0 ? getIrModuleTraversalPathValue(module.module, path_.slice(0, -1)) : undefined;
  const final = path_.at(-1);
  if (final === 'expression' && isIrExpressionValue(parent) && parent.kind === 'cast') return true;
  const initializerIndex = path_.lastIndexOf('initializer');
  if (initializerIndex >= 0) {
    const declaration = getIrModuleTraversalPathValue(module.module, path_.slice(0, initializerIndex));
    if (
      isRecord(declaration) &&
      'binding' in declaration &&
      isBindingIdentity(declaration.binding) &&
      'initializer' in declaration &&
      isIrExpressionValue(declaration.initializer)
    ) {
      const carrier = getRustReferencePlannedClassBindingCarrier(
        declaration.binding.id,
        module,
        modules,
        moduleResolution,
      );
      if (
        carrier?.sentinel &&
        isRustReferenceClassCarrierExpressionCompatible(
          declaration.initializer,
          carrier,
          module,
          modules,
          moduleResolution,
        )
      ) {
        return true;
      }
    }
  }
  if (
    final === 'initializer' &&
    isRecord(parent) &&
    'binding' in parent &&
    isBindingIdentity(parent.binding) &&
    module.sharedClasses.groupByBindingId.has(parent.binding.id)
  ) {
    return true;
  }
  if (final === 'object' && isIrExpressionValue(parent) && parent.kind === 'property') {
    if (parent.optional || parent.structuralAccess) return false;
    if (getRustReferenceClassField(expression, parent.name, module, modules, moduleResolution)) return true;
    const call = getIrModuleTraversalPathValue(module.module, path_.slice(0, -2));
    if (
      (!isCallExpression(call) || call.callee !== parent) &&
      getRustReferenceClassInstanceMethod(expression, parent.name, module, modules, moduleResolution)
    ) {
      return true;
    }
    if (isCallExpression(call) && call.callee === parent) {
      const location = getRustReferenceClassInstanceMethodCandidate(
        expression,
        parent.name,
        module,
        modules,
        moduleResolution,
      );
      if (
        location?.method.async &&
        getRustSimpleClassMethodPlan(
          location.method,
          location.declaration,
          location.module,
          modules,
          moduleResolution,
          new Set([`${moduleKey(location.module.module)}:${location.declaration.binding.id}`]),
        )?.async
      ) {
        return true;
      }
    }
    return (
      isCallExpression(call) &&
      call.callee === parent &&
      getRustSimpleClassMethodCall(call, module, modules, moduleResolution) !== undefined
    );
  }
  if (
    (final === 'left' || final === 'right') &&
    isIrExpressionValue(parent) &&
    parent.kind === 'binary' &&
    isRustReferenceClassIdentityComparisonSupported(parent, module, modules, moduleResolution)
  ) {
    return true;
  }
  if (path_.at(-2) === 'arguments' && typeof path_.at(-1) === 'number') {
    const invocation = getIrModuleTraversalPathValue(module.module, path_.slice(0, -2));
    const position = path_.at(-1) as number;
    if (isCallExpression(invocation)) {
      if (position === 0 && isRustReferenceArrayIsArrayCall(invocation)) return true;
      if (isRustReferenceArrayOfCall(invocation)) return true;
      if (position === 0 && isRustReferenceArrayFromCall(invocation)) return true;
      if (invocation.optional) return false;
      const method = getRustSimpleClassMethodCall(invocation, module, modules, moduleResolution);
      const requiredMethodParameter = method?.plan.requiredClassParameters.get(position);
      if (requiredMethodParameter && method) {
        return isRustReferenceExactClassArgument(
          expression,
          module,
          requiredMethodParameter.classType,
          method.module,
          modules,
          moduleResolution,
        );
      }
      const methodCarrier = method?.plan.optionalClassParameters.get(position);
      if (methodCarrier && method) {
        return isRustReferenceClassCarrierExpressionCompatible(
          expression,
          methodCarrier,
          module,
          modules,
          moduleResolution,
          method.module,
        );
      }
      const target = resolveRustReferenceCallTarget(invocation, module, modules, moduleResolution);
      if (target.kind !== 'function') return false;
      const optionalCarrier = getRustReferenceOptionalClassParameterPlans(
        target.function,
        target.module,
        modules,
        moduleResolution,
      ).get(position);
      if (optionalCarrier) {
        return isRustReferenceClassCarrierExpressionCompatible(
          expression,
          optionalCarrier,
          module,
          modules,
          moduleResolution,
          target.module,
        );
      }
      return getRustReferenceClassBorrowPositions(target.function, target.module, modules, moduleResolution).has(
        position,
      );
    }
    if (isIrExpressionValue(invocation) && invocation.kind === 'new') {
      const target = getRustSimpleClassConstructorTarget(invocation, module, modules, moduleResolution);
      if (!target) return false;
      const constructorPlan = getRustSimpleClassConstructorPlan(
        target.declaration,
        target.module,
        modules,
        moduleResolution,
        new Set(),
      );
      const optionalCarrier = constructorPlan?.optionalClassParameters.get(position);
      if (optionalCarrier) {
        return isRustReferenceClassCarrierExpressionCompatible(
          expression,
          optionalCarrier,
          module,
          modules,
          moduleResolution,
          target.module,
        );
      }
      return (
        constructorPlan?.borrowedPositions.has(position) === true &&
        isRustReferenceExactBorrowedClassArgument(
          expression,
          module,
          target.declaration.classConstructor!.parameters[position]!.type,
          target.module,
          modules,
          moduleResolution,
        )
      );
    }
    return false;
  }
  if (isRustReferenceClassReturnIdentifierUse(module, modules, moduleResolution, expression, path_)) return true;
  return false;
}

function isRustReferenceClassReturnIdentifierUse(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  expression: Readonly<Extract<IrExpression, { kind: 'identifier' }>>,
  path_: CompilerIrTraversalPath,
): boolean {
  let expressionPath = path_;
  while (expressionPath.at(-1) === 'whenTrue' || expressionPath.at(-1) === 'whenFalse') {
    const parent = getIrModuleTraversalPathValue(module.module, expressionPath.slice(0, -1));
    if (!isIrExpressionValue(parent) || parent.kind !== 'conditional') return false;
    expressionPath = expressionPath.slice(0, -1);
  }
  if (expressionPath.at(-1) !== 'expression') return false;
  const statement = getIrModuleTraversalPathValue(module.module, expressionPath.slice(0, -1));
  if (!isRecord(statement) || statement.kind !== 'return' || statement.expression === undefined) return false;
  const function_ = module.functions.find((candidate) => candidate.declaration.body.includes(statement as never));
  const carrier = function_
    ? getRustReferenceClassReturnCarrier(function_, module, modules, moduleResolution, new Set())
    : undefined;
  return (
    carrier !== undefined &&
    isRustReferenceClassReturnExpressionSupported(
      expression,
      carrier,
      module,
      modules,
      moduleResolution,
      new Set(),
      new Set(),
    )
  );
}

function addRustSharedClassFieldBorrowConflictRefusal(
  module: RustReferenceModuleRecord,
  assignment: Readonly<Extract<IrExpression, { kind: 'assignment' }>>,
  path_: CompilerIrTraversalPath,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  if (
    assignment.left.kind !== 'property' ||
    assignment.left.object.kind !== 'identifier' ||
    assignment.left.object.reference.kind !== 'binding'
  ) {
    return;
  }
  const receiverId = assignment.left.object.reference.binding.id;
  const group = module.sharedClasses.groupByBindingId.get(receiverId);
  const readsReceiver = irExpressionUsesBindingInPlan(assignment.right, receiverId);
  const readsAliasGroup = group && expressionUsesRustSharedClassGroup(assignment.right, group, module);
  if (!readsReceiver && !readsAliasGroup) return;
  addRustReferenceRefusal(
    refusals,
    'rust-reference-shared-class-borrow-conflict',
    `${moduleKey(module.module)}:${receiverId}:${JSON.stringify(path_)}`,
    'shared class field mutation reads the same alias group while its mutable borrow is active',
  );
}

function addRustSharedClassMutatorResultRefusal(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  assignment: Readonly<Extract<IrExpression, { kind: 'assignment' }>>,
  path_: CompilerIrTraversalPath,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  if (
    assignment.left.kind !== 'property' ||
    assignment.left.object.kind !== 'identifier' ||
    assignment.left.object.reference.kind !== 'binding' ||
    !getRustReferencePlannedClassBindingCarrier(
      assignment.left.object.reference.binding.id,
      module,
      modules,
      moduleResolution,
    )
  ) {
    return;
  }
  const receiverId = assignment.left.object.reference.binding.id;
  if (
    assignment.operator !== '=' &&
    !isRustSharedClassCompoundFieldAssignmentSupported(assignment, module, modules, moduleResolution)
  ) {
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-use-unrepresented',
      `${moduleKey(module.module)}:${receiverId}:${JSON.stringify(path_)}`,
      `shared class field assignment operator ${assignment.operator} requires class-specific mutation lowering`,
    );
  }
  if (isRustExpressionResultDiscarded(module.module, path_)) return;
  addRustReferenceRefusal(
    refusals,
    'rust-reference-shared-class-mutator-result-unrepresented',
    `${moduleKey(module.module)}:${receiverId}:${JSON.stringify(path_)}`,
    'observed class field assignment result is not represented by the focused mutable field carrier',
  );
}

function isRustSharedClassCompoundFieldAssignmentSupported(
  assignment: Readonly<Extract<IrExpression, { kind: 'assignment' }>>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  if (
    assignment.left.kind !== 'property' ||
    assignment.left.optional ||
    assignment.left.structuralAccess ||
    assignment.left.object.kind !== 'identifier'
  ) {
    return false;
  }
  const field = getRustReferenceClassField(
    assignment.left.object,
    assignment.left.name,
    module,
    modules,
    moduleResolution,
  );
  if (!field || !isRustSimpleClassField(field) || field.type.kind !== 'primitive') return false;
  const exactFieldDomain =
    assignment.semantics.left.flow === field.type.name &&
    assignment.semantics.right.flow === field.type.name &&
    assignment.semantics.result === field.type.name;
  if (!exactFieldDomain) return false;
  if (field.type.name === 'string') return assignment.operator === '+=';
  return (
    field.type.name === 'number' &&
    (assignment.operator === '+=' ||
      assignment.operator === '-=' ||
      assignment.operator === '*=' ||
      assignment.operator === '/=' ||
      assignment.operator === '%=')
  );
}

function addRustSharedClassCallBorrowConflictRefusal(
  module: RustReferenceModuleRecord,
  call: IrCallExpression,
  borrowedPosition: number,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  const argument = call.arguments[borrowedPosition];
  if (argument?.kind !== 'identifier' || argument.reference.kind !== 'binding') return;
  const argumentId = argument.reference.binding.id;
  const group = module.sharedClasses.groupByBindingId.get(argumentId);
  if (
    !group ||
    !call.arguments.some(
      (candidate, position) =>
        position !== borrowedPosition && expressionUsesRustSharedClassGroup(candidate, group, module),
    )
  ) {
    return;
  }
  addRustReferenceRefusal(
    refusals,
    'rust-reference-shared-class-borrow-conflict',
    `${moduleKey(module.module)}:${call.callee.kind}:${call.callee.kind === 'identifier' && call.callee.reference.kind === 'binding' ? call.callee.reference.binding.id : 'call'}:${String(borrowedPosition)}`,
    `call argument ${String(borrowedPosition)} mutably borrows a shared class while another argument reads the same alias group`,
  );
}

function addRustSharedClassMethodBorrowConflictRefusal(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  call: IrCallExpression,
  path_: CompilerIrTraversalPath,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  const method = getRustSimpleClassMethodCall(call, module, modules, moduleResolution);
  for (const position of method?.plan.mutatedClassParameterPositions ?? []) {
    addRustSharedClassCallBorrowConflictRefusal(module, call, position, refusals);
  }
  const receiver = method?.receiver;
  if (
    !receiver ||
    receiver.reference.kind !== 'binding' ||
    !getRustReferencePlannedClassBindingCarrier(receiver.reference.binding.id, module, modules, moduleResolution)
  ) {
    return;
  }
  const receiverId = receiver.reference.binding.id;
  const group = module.sharedClasses.groupByBindingId.get(receiver.reference.binding.id);
  if (
    !call.arguments.some(
      (argument) =>
        irExpressionUsesBindingInPlan(argument, receiverId) ||
        (group !== undefined && expressionUsesRustSharedClassGroup(argument, group, module)),
    )
  ) {
    return;
  }
  addRustReferenceRefusal(
    refusals,
    'rust-reference-shared-class-borrow-conflict',
    `${moduleKey(module.module)}:${receiver.reference.binding.id}:${JSON.stringify(path_)}`,
    `class method ${method.method.name} borrows a shared receiver while an argument reads the same alias group`,
  );
}

function addRustSharedClassConstructorBorrowConflictRefusal(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  expression: Readonly<Extract<IrExpression, { kind: 'new' }>>,
  path_: CompilerIrTraversalPath,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  const target = getRustSimpleClassConstructorTarget(expression, module, modules, moduleResolution);
  if (!target) return;
  const positions = getRustSimpleClassConstructorBorrowPositions(
    target.declaration,
    target.module,
    modules,
    moduleResolution,
    new Set([`${moduleKey(target.module.module)}:${target.declaration.binding.id}`]),
  );
  if (!positions) return;
  for (const position of positions) {
    const argument = expression.arguments[position];
    if (argument?.kind !== 'identifier' || argument.reference.kind !== 'binding') continue;
    const group = module.sharedClasses.groupByBindingId.get(argument.reference.binding.id);
    if (
      !group ||
      !expression.arguments.some(
        (candidate, candidatePosition) =>
          candidatePosition !== position && expressionUsesRustSharedClassGroup(candidate, group, module),
      )
    ) {
      continue;
    }
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-borrow-conflict',
      `${moduleKey(module.module)}:constructor:${target.declaration.binding.id}:${String(position)}:${JSON.stringify(path_)}`,
      `constructor argument ${String(position)} borrows a shared class while another argument reads the same alias group`,
    );
  }
}

function expressionUsesRustSharedClassGroup(
  expression: Readonly<IrExpression>,
  group: string,
  module: RustReferenceModuleRecord,
): boolean {
  let found = false;
  analyzeIrExpressionSubtreeTraversal(expression, {
    expression(candidate) {
      if (
        candidate.kind === 'identifier' &&
        candidate.reference.kind === 'binding' &&
        module.sharedClasses.groupByBindingId.get(candidate.reference.binding.id) === group
      ) {
        found = true;
        return false;
      }
      return undefined;
    },
  });
  return found;
}

function addRustSharedHashCollectionRefusals(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
  kind: RustSharedHashCollectionKind,
): void {
  const analysis = getRustSharedHashCollectionAnalysis(module, kind);
  const collectionName = getRustReferenceHashCollectionName(kind);
  for (const id of analysis.ambiguousBindingIds) {
    const evidence = module.ownership.bindings.find((candidate) => candidate.binding.id === id);
    const mutatedByCall = module.calls.some(({ call }) => {
      const target = resolveRustReferenceCallTarget(call, module, modules, moduleResolution);
      return (
        target.kind === 'function' &&
        [...getRustReferenceAnyHashCollectionMutationPositions(target.function, kind)].some((position) => {
          const argument = call.arguments[position];
          return (
            argument?.kind === 'identifier' &&
            argument.reference.kind === 'binding' &&
            argument.reference.binding.id === id
          );
        })
      );
    });
    if (
      !evidence ||
      (!mutatedByCall && evidence.mutation !== 'referentMutated' && evidence.mutation !== 'bindingAndReferent')
    ) {
      continue;
    }
    addRustReferenceRefusal(
      refusals,
      getRustReferenceHashCollectionRefusalCode(kind, 'alias'),
      `${moduleKey(module.module)}:${id}`,
      `mutable ${collectionName} alias ${evidence.binding.name} has multiple possible source identity groups`,
    );
  }
  if (analysis.bindingIds.size === 0) return;

  for (const group of analysis.groupsByKey.values()) {
    if (![...group].some((id) => analysis.bindingIds.has(id))) continue;
    const roots = [...group].filter((id) => {
      const variable = analysis.variablesByBindingId.get(id);
      return variable?.initializer
        ? isZeroArgumentAmbientHashCollectionConstruction(variable.initializer, kind)
        : false;
    });
    if (roots.length !== 1) {
      addRustReferenceRefusal(
        refusals,
        getRustReferenceHashCollectionRefusalCode(kind, 'use'),
        `${moduleKey(module.module)}:group:${[...group].sort(compareTextCodeUnits).join(',')}`,
        `shared ${collectionName} alias group must have exactly one local zero-argument new ${collectionName} root`,
      );
    }
    for (const id of group) {
      const variable = analysis.variablesByBindingId.get(id);
      const initializer = variable?.initializer;
      const aliasInitializer =
        initializer?.kind === 'identifier' &&
        initializer.reference.kind === 'binding' &&
        group.has(initializer.reference.binding.id);
      if (
        !variable ||
        variable.mutable ||
        (!aliasInitializer && !isZeroArgumentAmbientHashCollectionConstruction(initializer, kind))
      ) {
        addRustReferenceRefusal(
          refusals,
          getRustReferenceHashCollectionRefusalCode(kind, 'use'),
          `${moduleKey(module.module)}:${id}`,
          `shared ${collectionName} binding ${variable?.binding.name ?? id} is not an initialized local const in the alias group`,
        );
      }
    }
  }

  for (const evidence of module.ownership.bindings) {
    if (!analysis.bindingIds.has(evidence.binding.id)) continue;
    const subject = `${moduleKey(module.module)}:${evidence.binding.id}`;
    const arguments_ = getRustAmbientHashCollectionTypeArguments(evidence.type, kind);
    if (!arguments_) {
      addRustReferenceRefusal(
        refusals,
        getRustReferenceHashCollectionRefusalCode(kind, 'use'),
        subject,
        `shared ${collectionName} binding ${evidence.binding.name} must retain its exact ambient ${collectionName} type in the focused Rust carrier plan`,
      );
    } else if (arguments_[0]?.kind !== 'primitive' || arguments_[0].name !== 'string') {
      addRustReferenceRefusal(
        refusals,
        kind === 'map'
          ? 'rust-reference-shared-map-key-unrepresented'
          : 'rust-reference-shared-set-element-unrepresented',
        subject,
        `shared ${collectionName} binding ${evidence.binding.name} requires an exact string ${kind === 'map' ? 'key' : 'element'}; SameValueZero and object identity are not represented by the focused Rust carrier`,
      );
    }
    if (kind === 'map' && arguments_?.[1] && !isRustSharedMapPrimitiveValueType(arguments_[1])) {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-map-value-unrepresented',
        subject,
        `shared Map binding ${evidence.binding.name} requires a primitive value-semantic value type`,
      );
    }
    if (evidence.binding.scope === 'module' || evidence.declaration !== 'immutable') {
      addRustReferenceRefusal(
        refusals,
        getRustReferenceHashCollectionRefusalCode(kind, 'use'),
        subject,
        `shared ${collectionName} binding ${evidence.binding.name} is outside the supported local const carrier`,
      );
    }
    if (evidence.mutation === 'bindingReassigned' || evidence.mutation === 'bindingAndReferent') {
      addRustReferenceRefusal(
        refusals,
        getRustReferenceHashCollectionRefusalCode(kind, 'bindingReassignment'),
        subject,
        `shared ${collectionName} binding ${evidence.binding.name} is reassigned after alias creation`,
      );
    }
    if (evidence.boundaries.includes('suspension')) {
      addRustReferenceRefusal(
        refusals,
        getRustReferenceHashCollectionRefusalCode(kind, 'suspension'),
        subject,
        `shared ${collectionName} binding ${evidence.binding.name} crosses a suspension boundary`,
      );
    }
  }

  for (const closure of analyzeIrModuleClosureEvidence(module.module).closures) {
    const captures = closure.captures.filter((capture) => analysis.bindingIds.has(capture.binding.id));
    if (captures.length === 0) continue;
    const subject = `${moduleKey(module.module)}:closure:${JSON.stringify(closure.path)}`;
    if (
      closure.async ||
      closure.suspensions.length > 0 ||
      captures.some((capture) => capture.lifetimeBoundaries.includes('suspension'))
    ) {
      addRustReferenceRefusal(
        refusals,
        getRustReferenceHashCollectionRefusalCode(kind, 'suspension'),
        subject,
        `shared ${collectionName} closure capture crosses an async or suspension boundary`,
      );
    }
    if (closure.escape === 'mayEscape') {
      addRustReferenceRefusal(
        refusals,
        getRustReferenceHashCollectionRefusalCode(kind, 'closureEscape'),
        subject,
        `shared ${collectionName} closure capture may escape into a lifetime or Send context not represented by Rc<RefCell<_>>`,
      );
    }
  }

  analyzeIrModuleTraversal(module.module, {
    expression(expression, path_) {
      if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
        if (!analysis.bindingIds.has(expression.reference.binding.id)) return;
        if (
          !isRustSharedHashCollectionIdentifierUseRepresented(
            module,
            modules,
            moduleResolution,
            expression,
            path_,
            kind,
          )
        ) {
          const callArgument = path_.at(-2) === 'arguments' && typeof path_.at(-1) === 'number';
          addRustReferenceRefusal(
            refusals,
            getRustReferenceHashCollectionRefusalCode(kind, callArgument ? 'call' : 'use'),
            `${moduleKey(module.module)}:${expression.reference.binding.id}:${JSON.stringify(path_)}`,
            callArgument
              ? `shared ${collectionName} binding ${expression.reference.binding.name} is passed to a call without an exact represented mutable ${collectionName} parameter`
              : `shared ${collectionName} binding ${expression.reference.binding.name} is used outside a proven temporary borrow scope`,
          );
        }
        return;
      }
      if (expression.kind === 'call') {
        addRustSharedHashCollectionMemberBorrowConflictRefusal(module, expression, path_, refusals, kind);
        addRustSharedHashCollectionMutatorResultRefusal(module, expression, path_, refusals, kind);
      }
    },
  });
}

function isRustSharedHashCollectionIdentifierUseRepresented(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  expression: Readonly<Extract<IrExpression, { kind: 'identifier' }>>,
  path_: CompilerIrTraversalPath,
  kind: RustSharedHashCollectionKind,
): boolean {
  const analysis = getRustSharedHashCollectionAnalysis(module, kind);
  const parent = path_.length > 0 ? getIrModuleTraversalPathValue(module.module, path_.slice(0, -1)) : undefined;
  const final = path_.at(-1);
  if (
    final === 'initializer' &&
    isRecord(parent) &&
    'binding' in parent &&
    isBindingIdentity(parent.binding) &&
    analysis.groupByBindingId.has(parent.binding.id)
  ) {
    return true;
  }
  if (final === 'object' && isIrExpressionValue(parent) && parent.kind === 'property') {
    if (parent.optional || parent.member?.receiver !== kind) return false;
    if (parent.name === 'size') return true;
    const propertyPath = path_.slice(0, -1);
    const propertyParent =
      propertyPath.length > 0 ? getIrModuleTraversalPathValue(module.module, propertyPath.slice(0, -1)) : undefined;
    return (
      propertyPath.at(-1) === 'callee' &&
      isCallExpression(propertyParent) &&
      !propertyParent.optional &&
      getRustSharedHashCollectionMethods(kind).has(parent.name)
    );
  }
  if (path_.at(-2) === 'arguments' && typeof path_.at(-1) === 'number') {
    const call = getIrModuleTraversalPathValue(module.module, path_.slice(0, -2));
    if (!isCallExpression(call) || call.optional) return false;
    const position = path_.at(-1) as number;
    if (isRustReferenceArrayOfCall(call)) return true;
    if (position === 0 && isRustReferenceArrayFromCall(call)) return true;
    const target = resolveRustReferenceCallTarget(call, module, modules, moduleResolution);
    return (
      target.kind === 'function' && getRustReferenceHashCollectionMutationPositions(target.function, kind).has(position)
    );
  }
  return false;
}

function addRustSharedHashCollectionMemberBorrowConflictRefusal(
  module: RustReferenceModuleRecord,
  call: IrCallExpression,
  path_: CompilerIrTraversalPath,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
  kind: RustSharedHashCollectionKind,
): void {
  if (
    call.callee.kind !== 'property' ||
    call.callee.member?.receiver !== kind ||
    !getRustSharedHashCollectionMutatingMethods(kind).has(call.callee.member.name) ||
    call.callee.object.kind !== 'identifier' ||
    call.callee.object.reference.kind !== 'binding'
  ) {
    return;
  }
  const receiverId = call.callee.object.reference.binding.id;
  const analysis = getRustSharedHashCollectionAnalysis(module, kind);
  const group = analysis.groupByBindingId.get(receiverId);
  if (
    !group ||
    !call.arguments.some((argument) => expressionUsesRustSharedHashCollectionGroup(argument, group, analysis))
  ) {
    return;
  }
  addRustReferenceRefusal(
    refusals,
    getRustReferenceHashCollectionRefusalCode(kind, 'borrowConflict'),
    `${moduleKey(module.module)}:${receiverId}:${JSON.stringify(path_)}`,
    `shared ${getRustReferenceHashCollectionName(kind)} mutation ${call.callee.member.name} reads the same alias group while its mutable borrow is active`,
  );
}

function addRustSharedHashCollectionMutatorResultRefusal(
  module: RustReferenceModuleRecord,
  call: IrCallExpression,
  path_: CompilerIrTraversalPath,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
  kind: RustSharedHashCollectionKind,
): void {
  const analysis = getRustSharedHashCollectionAnalysis(module, kind);
  if (
    call.callee.kind !== 'property' ||
    call.callee.member?.receiver !== kind ||
    !getRustSharedHashCollectionMutatingMethods(kind).has(call.callee.member.name) ||
    call.callee.object.kind !== 'identifier' ||
    call.callee.object.reference.kind !== 'binding' ||
    !analysis.bindingIds.has(call.callee.object.reference.binding.id) ||
    isRustExpressionResultDiscarded(module.module, path_)
  ) {
    return;
  }
  addRustReferenceRefusal(
    refusals,
    getRustReferenceHashCollectionRefusalCode(kind, 'mutatorResult'),
    `${moduleKey(module.module)}:${call.callee.object.reference.binding.id}:${JSON.stringify(path_)}`,
    `observed ${getRustReferenceHashCollectionName(kind)}.${call.callee.member.name} result is not represented by the Rust ${kind === 'map' ? 'HashMap' : 'HashSet'} method result`,
  );
}

function addRustSharedHashCollectionCallBorrowConflictRefusal(
  module: RustReferenceModuleRecord,
  call: IrCallExpression,
  borrowedPosition: number,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
  kind: RustSharedHashCollectionKind,
): void {
  const argument = call.arguments[borrowedPosition];
  if (argument?.kind !== 'identifier' || argument.reference.kind !== 'binding') return;
  const argumentId = argument.reference.binding.id;
  const analysis = getRustSharedHashCollectionAnalysis(module, kind);
  const group = analysis.groupByBindingId.get(argumentId);
  if (
    !group ||
    !call.arguments.some(
      (candidate, position) =>
        position !== borrowedPosition && expressionUsesRustSharedHashCollectionGroup(candidate, group, analysis),
    )
  ) {
    return;
  }
  addRustReferenceRefusal(
    refusals,
    getRustReferenceHashCollectionRefusalCode(kind, 'borrowConflict'),
    `${moduleKey(module.module)}:${call.callee.kind}:${call.callee.kind === 'identifier' && call.callee.reference.kind === 'binding' ? call.callee.reference.binding.id : 'call'}:${String(borrowedPosition)}`,
    `call argument ${String(borrowedPosition)} mutably borrows a shared ${getRustReferenceHashCollectionName(kind)} while another argument reads the same alias group`,
  );
}

function expressionUsesRustSharedHashCollectionGroup(
  expression: Readonly<IrExpression>,
  group: string,
  analysis: RustSharedHashCollectionAnalysis,
): boolean {
  let found = false;
  analyzeIrExpressionSubtreeTraversal(expression, {
    expression(candidate) {
      if (
        candidate.kind === 'identifier' &&
        candidate.reference.kind === 'binding' &&
        analysis.groupByBindingId.get(candidate.reference.binding.id) === group
      ) {
        found = true;
        return false;
      }
      return undefined;
    },
  });
  return found;
}

function isRustExpressionResultDiscarded(module: Readonly<IrModule>, path_: CompilerIrTraversalPath): boolean {
  if (path_.at(-1) !== 'expression' || path_.length === 0) return false;
  const parent = getIrModuleTraversalPathValue(module, path_.slice(0, -1));
  return isRecord(parent) && parent.kind === 'expression';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isIrExpressionValue(value: unknown): value is Readonly<IrExpression> {
  return isRecord(value) && typeof value.kind === 'string';
}

function isBindingIdentity(value: unknown): value is IrBindingIdentity {
  return isRecord(value) && typeof value.id === 'string';
}

function isCallExpression(value: unknown): value is IrCallExpression {
  return isRecord(value) && value.kind === 'call' && Array.isArray(value.arguments);
}

function isRustReferenceArrayIsArrayCall(call: IrCallExpression): boolean {
  return (
    !call.optional &&
    call.arguments.length === 1 &&
    call.callee.kind === 'property' &&
    !call.callee.optional &&
    call.callee.name === 'isArray' &&
    call.callee.object.kind === 'identifier' &&
    call.callee.object.reference.kind === 'ambient' &&
    call.callee.object.reference.name === 'Array'
  );
}

function isRustReferenceArrayOfCall(call: IrCallExpression): boolean {
  return (
    !call.optional &&
    call.callee.kind === 'property' &&
    !call.callee.optional &&
    call.callee.name === 'of' &&
    call.callee.object.kind === 'identifier' &&
    call.callee.object.reference.kind === 'ambient' &&
    call.callee.object.reference.name === 'Array'
  );
}

function isRustReferenceArrayFromCall(call: IrCallExpression): boolean {
  return (
    call.callee.kind === 'property' &&
    call.callee.name === 'from' &&
    call.callee.object.kind === 'identifier' &&
    call.callee.object.reference.kind === 'ambient' &&
    call.callee.object.reference.name === 'Array'
  );
}

function addRustReferenceCallablePlan(
  callables: Map<string, RustReferenceCallableDraft>,
  binding: Readonly<IrBindingIdentity>,
  positions: ReadonlySet<number>,
  representation: CompilerRustReferenceRepresentation,
): void {
  if (positions.size === 0) return;
  const existing = callables.get(binding.id);
  if (existing) {
    for (const position of positions) existing.parameters.set(position, representation);
    return;
  }
  callables.set(binding.id, {
    binding,
    parameters: new Map([...positions].map((position) => [position, representation])),
  });
}

function addRustReferenceCallableReturnPlan(
  callables: Map<string, RustReferenceCallableDraft>,
  binding: Readonly<IrBindingIdentity>,
  representation: RustSharedClassRepresentation,
): void {
  const existing = callables.get(binding.id);
  if (existing) {
    existing.returns = representation;
    return;
  }
  callables.set(binding.id, { binding, parameters: new Map(), returns: representation });
}

function addRustReferenceRefusal(
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
  code: CompilerRustReferenceRepresentationRefusal['code'],
  subject: string,
  message: string,
): void {
  refusals.set(`${code}\0${subject}`, { code, message, subject });
}

function getRustReferenceArrayMutationPositions(function_: RustReferenceFunctionRecord): ReadonlySet<number> {
  return new Set(
    [...function_.mutatedParameterPositions].filter(
      (position) => function_.declaration.parameters[position]?.type.kind === 'array',
    ),
  );
}

function getRustReferenceClassMutationPositions(
  function_: RustReferenceFunctionRecord,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): ReadonlySet<number> {
  return new Set(
    [...function_.mutatedParameterPositions].filter((position) =>
      isRustSharedClassTypeSupported(
        function_.declaration.parameters[position]?.type,
        module,
        modules,
        moduleResolution,
      ),
    ),
  );
}

function addRustSharedClassIdentityRefusals(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  analyzeIrModuleTraversal(module.module, {
    expression(expression, path_) {
      if (
        expression.kind !== 'binary' ||
        !isRustReferencePotentialClassIdentityComparison(expression, module, modules, moduleResolution) ||
        isRustReferenceClassIdentityComparisonSupported(expression, module, modules, moduleResolution)
      ) {
        return;
      }
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-identity-unrepresented',
        `${moduleKey(module.module)}:identity:${JSON.stringify(path_)}`,
        `operator ${expression.operator} does not compare two owned values of one exact supported simple class identity`,
      );
    },
  });
}

function addRustClassMethodParameterRefusals(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  for (const declaration of module.module.declarations) {
    if (declaration.kind !== 'class') continue;
    const visitingClasses = new Set([`${moduleKey(module.module)}:${declaration.binding.id}`]);
    for (const method of declaration.methods) {
      if (method.async) continue;
      if (!isRustPotentialClassParameterMethod(method, module)) continue;
      if (getRustSimpleClassMethodPlan(method, declaration, module, modules, moduleResolution, visitingClasses)) {
        continue;
      }
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-member-unrepresented',
        getRustSimpleClassMethodIdentity(module, declaration, method),
        `class method ${declaration.binding.name}.${method.name} is outside the bounded final simple-class parameter carrier`,
      );
    }
  }
  analyzeIrModuleTraversal(module.module, {
    expression(expression, path_) {
      if (
        expression.kind !== 'call' ||
        expression.callee.kind !== 'property' ||
        expression.callee.object.kind !== 'identifier'
      ) {
        return;
      }
      const location = getRustReferenceClassInstanceMethodCandidate(
        expression.callee.object,
        expression.callee.name,
        module,
        modules,
        moduleResolution,
      );
      if (!location || !isRustPotentialClassParameterMethod(location.method, location.module)) return;
      const plan = getRustSimpleClassMethodPlan(
        location.method,
        location.declaration,
        location.module,
        modules,
        moduleResolution,
        new Set([`${moduleKey(location.module.module)}:${location.declaration.binding.id}`]),
      );
      if (!plan) {
        addRustReferenceRefusal(
          refusals,
          'rust-reference-shared-class-member-unrepresented',
          `${getRustSimpleClassMethodIdentity(location.module, location.declaration, location.method)}:${JSON.stringify(path_)}`,
          `class method ${location.declaration.binding.name}.${location.method.name} is outside the bounded final simple-class parameter carrier`,
        );
        return;
      }
      if (getRustSimpleClassMethodCall(expression, module, modules, moduleResolution)) return;
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-call-unrepresented',
        `${plan.identity}:${moduleKey(module.module)}:${JSON.stringify(path_)}`,
        `class method ${location.declaration.binding.name}.${location.method.name} lacks exact arity, identity, sentinel evidence, or one matching simple-class argument carrier`,
      );
    },
  });
}

function addRustAsyncClassMethodCallRefusals(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  analyzeIrModuleTraversal(module.module, {
    expression(expression, path_) {
      if (expression.kind !== 'call' || expression.callee.kind !== 'property') return;
      const location = getRustReferenceClassInstanceMethodCandidate(
        expression.callee.object,
        expression.callee.name,
        module,
        modules,
        moduleResolution,
      );
      if (!location?.method.async) return;
      const plan = getRustSimpleClassMethodPlan(
        location.method,
        location.declaration,
        location.module,
        modules,
        moduleResolution,
        new Set([`${moduleKey(location.module.module)}:${location.declaration.binding.id}`]),
      );
      if (!plan?.async || getRustSimpleClassMethodCall(expression, module, modules, moduleResolution)) return;
      addRustReferenceRefusal(
        refusals,
        'rust-async-method-call-unrepresented',
        `${plan.identity}:${moduleKey(module.module)}:${JSON.stringify(path_)}`,
        `async method ${location.declaration.binding.name}.${location.method.name} requires one exact identifier receiver, fixed owned arguments, and direct non-optional invocation`,
      );
    },
  });
}

function addRustAsyncClassMethodDeclarationRefusals(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  for (const declaration of module.module.declarations) {
    if (declaration.kind !== 'class') continue;
    for (const method of declaration.methods) {
      if (!method.async) continue;
      const ownerSupported =
        isRustSimpleAsyncClassMethodOwnerSupported(method, declaration) &&
        isRustSimpleClassConstructionSupported(declaration, module, modules, moduleResolution, new Set());
      if (ownerSupported && isRustSimpleAsyncClassMethodBodySupported(method, declaration)) continue;
      addRustReferenceRefusal(
        refusals,
        ownerSupported ? 'rust-async-method-body-unrepresented' : 'rust-async-method-owner-carrier-unrepresented',
        getRustSimpleClassMethodIdentity(module, declaration, method),
        ownerSupported
          ? `async method ${declaration.binding.name}.${method.name} uses a body outside the short receiver-field borrow carrier`
          : `async method ${declaration.binding.name}.${method.name} lacks the exact owned simple-class receiver carrier`,
      );
    }
  }
}

function isRustReferenceExactAsyncMethodReceiverBinding(
  bindingId: string,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  let represented = false;
  analyzeIrModuleTraversal(module.module, {
    expression(expression) {
      if (expression.kind !== 'call') return;
      const call = getRustSimpleClassMethodCall(expression, module, modules, moduleResolution);
      if (
        call?.plan.async &&
        call.receiver.reference.kind === 'binding' &&
        call.receiver.reference.binding.id === bindingId
      ) {
        represented = true;
      }
    },
  });
  return represented;
}

function addRustSharedClassMethodValueRefusals(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  analyzeIrModuleTraversal(module.module, {
    expression(expression, path_) {
      if (expression.kind !== 'property') return;
      const parent = path_.length > 0 ? getIrModuleTraversalPathValue(module.module, path_.slice(0, -1)) : undefined;
      if (path_.at(-1) === 'callee' && isCallExpression(parent) && parent.callee === expression) return;
      const location = getRustReferenceClassInstanceMethod(
        expression.object,
        expression.name,
        module,
        modules,
        moduleResolution,
      );
      if (!location) return;
      addRustReferenceRefusal(
        refusals,
        location.method.async
          ? 'rust-async-method-call-unrepresented'
          : 'rust-reference-shared-class-member-unrepresented',
        `${moduleKey(module.module)}:method-value:${JSON.stringify(path_)}`,
        `instance method ${location.declaration.binding.name}.${location.method.name} is used as a value without represented Rust receiver binding`,
      );
    },
  });
}

function isRustReferenceClassIdentityComparisonSupported(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  if (
    expression.operator !== '==' &&
    expression.operator !== '===' &&
    expression.operator !== '!=' &&
    expression.operator !== '!=='
  ) {
    return false;
  }
  const left = getRustReferenceClassIdentityOperandPlan(expression.left, module, modules, moduleResolution);
  const right = getRustReferenceClassIdentityOperandPlan(expression.right, module, modules, moduleResolution);
  if (!left || !right) return false;
  if (left.kind === 'sentinel' || right.kind === 'sentinel') {
    if (expression.operator !== '===' && expression.operator !== '!==') return false;
    const sentinel = left.kind === 'sentinel' ? left.sentinel : right.kind === 'sentinel' ? right.sentinel : undefined;
    const carrier = left.kind === 'carrier' ? left : right.kind === 'carrier' ? right : undefined;
    return (
      carrier !== undefined &&
      sentinel !== undefined &&
      carrier.carrier.sentinel === sentinel &&
      isRustReferenceClassIdentityOperandSupported(
        carrier.expression,
        carrier.carrier,
        module,
        modules,
        moduleResolution,
        new Set(),
      )
    );
  }
  if (
    !isRustReferenceSameClassCarrier(left.carrier, module, right.carrier, module, modules, moduleResolution) ||
    !isRustReferenceClassIdentityOperandSupported(
      expression.left,
      left.carrier,
      module,
      modules,
      moduleResolution,
      new Set(),
    ) ||
    !isRustReferenceClassIdentityOperandSupported(
      expression.right,
      right.carrier,
      module,
      modules,
      moduleResolution,
      new Set(),
    )
  ) {
    return false;
  }
  return left.carrier.sentinel === undefined && right.carrier.sentinel === undefined
    ? true
    : expression.operator === '===' || expression.operator === '!==';
}

type RustReferenceClassIdentityOperandPlan =
  | Readonly<{ expression: Readonly<IrExpression>; kind: 'carrier'; carrier: RustSharedClassCarrierType }>
  | Readonly<{ kind: 'sentinel'; sentinel: 'null' | 'undefined' }>;

function getRustReferenceClassIdentityOperandPlan(
  expression: Readonly<IrExpression>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): RustReferenceClassIdentityOperandPlan | undefined {
  const type = getRustReferenceClassIdentityExpressionType(expression, module);
  if (type?.kind === 'null' || type?.kind === 'undefined') return { kind: 'sentinel', sentinel: type.kind };
  const carrier = getRustSharedClassCarrierType(type, module, modules, moduleResolution);
  return carrier ? { carrier, expression, kind: 'carrier' } : undefined;
}

function isRustReferenceClassIdentityOperandSupported(
  expression: Readonly<IrExpression>,
  expectedCarrier: RustSharedClassCarrierType,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  visitingBindings: ReadonlySet<string>,
): boolean {
  if (expectedCarrier.sentinel && isRustReferenceSentinelExpression(expression, expectedCarrier.sentinel)) {
    return true;
  }
  if (expression.kind === 'conditional') {
    return (
      isRustReferenceClassIdentityOperandSupported(
        expression.whenTrue,
        expectedCarrier,
        module,
        modules,
        moduleResolution,
        visitingBindings,
      ) &&
      isRustReferenceClassIdentityOperandSupported(
        expression.whenFalse,
        expectedCarrier,
        module,
        modules,
        moduleResolution,
        visitingBindings,
      )
    );
  }
  if (expression.kind === 'new') {
    return isRustSimpleClassConstruction(expression, expectedCarrier.classType, module, modules, moduleResolution);
  }
  if (expression.kind === 'call') {
    const target = resolveRustReferenceCallTarget(expression, module, modules, moduleResolution);
    if (target.kind !== 'function') return false;
    const returned = getRustReferenceClassReturnCarrier(
      target.function,
      target.module,
      modules,
      moduleResolution,
      new Set(),
    );
    return (
      returned !== undefined &&
      (returned.representation === 'shared-ref-cell-class' ||
        returned.representation === expectedCarrier.representation) &&
      isRustReferenceSameClassCarrier(returned, target.module, expectedCarrier, module, modules, moduleResolution)
    );
  }
  if (expression.kind !== 'identifier' || expression.reference.kind !== 'binding') return false;
  const bindingId = expression.reference.binding.id;
  if (visitingBindings.has(bindingId)) return false;
  const evidence = module.ownership.bindings.find((candidate) => candidate.binding.id === bindingId);
  const variable = module.sharedClasses.variablesByBindingId.get(bindingId);
  const actual = getRustSharedClassCarrierType(module.bindingTypes.get(bindingId), module, modules, moduleResolution);
  if (
    !evidence ||
    !actual ||
    !isRustReferenceSameClassCarrier(actual, module, expectedCarrier, module, modules, moduleResolution)
  ) {
    return false;
  }
  if (evidence.declaration === 'parameter') return actual.representation !== 'shared-ref-cell-class';
  return (
    evidence?.declaration === 'immutable' &&
    evidence.binding.scope !== 'module' &&
    variable?.initializer !== undefined &&
    variable.mutable === false &&
    isRustReferenceClassIdentityOperandSupported(
      variable.initializer,
      actual,
      module,
      modules,
      moduleResolution,
      new Set(visitingBindings).add(bindingId),
    )
  );
}

function isRustReferencePotentialClassIdentityComparison(
  expression: Readonly<Extract<IrExpression, { kind: 'binary' }>>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  if (
    expression.operator !== '===' &&
    expression.operator !== '!==' &&
    expression.operator !== '==' &&
    expression.operator !== '!=' &&
    expression.operator !== '<' &&
    expression.operator !== '<=' &&
    expression.operator !== '>' &&
    expression.operator !== '>='
  ) {
    return false;
  }
  const left = getRustReferenceClassIdentityExpressionType(expression.left, module);
  const right = getRustReferenceClassIdentityExpressionType(expression.right, module);
  const leftAnchor = isRustReferenceClassOrObjectIdentityType(left, module, modules, moduleResolution);
  const rightAnchor = isRustReferenceClassOrObjectIdentityType(right, module, modules, moduleResolution);
  return (
    (leftAnchor && isRustReferenceIdentityDomainType(right, module, modules, moduleResolution)) ||
    (rightAnchor && isRustReferenceIdentityDomainType(left, module, modules, moduleResolution))
  );
}

function isRustReferenceClassOrObjectIdentityType(
  type: Readonly<IrType> | undefined,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  if (!type) return false;
  if (type.kind === 'object') return true;
  if (getRustReferenceClassDeclaration(type, module, modules, moduleResolution)) return true;
  return type.kind === 'union' || type.kind === 'intersection'
    ? type.types.some((member) => isRustReferenceClassOrObjectIdentityType(member, module, modules, moduleResolution))
    : false;
}

function isRustReferenceIdentityDomainType(
  type: Readonly<IrType> | undefined,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  if (!type) return false;
  if (
    type.kind === 'unknown' ||
    type.kind === 'object' ||
    type.kind === 'literal' ||
    type.kind === 'primitive' ||
    type.kind === 'null' ||
    type.kind === 'undefined'
  ) {
    return true;
  }
  if (getRustReferenceClassDeclaration(type, module, modules, moduleResolution)) return true;
  return type.kind === 'union' || type.kind === 'intersection'
    ? type.types.some((member) => isRustReferenceIdentityDomainType(member, module, modules, moduleResolution))
    : false;
}

function getRustReferenceClassIdentityExpressionType(
  expression: Readonly<IrExpression>,
  module: RustReferenceModuleRecord,
): Readonly<IrType> | undefined {
  const primitive = getRustSimpleClassPrimitiveExpressionType(expression, module);
  if (primitive) return primitive;
  if (expression.kind === 'identifier') {
    if (expression.reference.kind === 'binding') return module.bindingTypes.get(expression.reference.binding.id);
    if (expression.reference.kind === 'ambient' && expression.reference.name === 'undefined') {
      return { kind: 'undefined' };
    }
    return undefined;
  }
  if (expression.kind === 'call') return expression.semantics.resultType;
  if (expression.kind === 'cast') return expression.type;
  if (expression.kind === 'object') return expression.type;
  if (expression.kind === 'literal' && expression.value === null) return { kind: 'null' };
  if (expression.kind === 'undefinedValue') return { kind: 'undefined' };
  if (expression.kind !== 'new' || expression.callee.kind !== 'identifier') return undefined;
  if (expression.callee.reference.kind !== 'binding') return undefined;
  return {
    kind: 'named',
    reference: { binding: expression.callee.reference.binding, kind: 'binding', path: [] },
    typeArguments: [],
  };
}

function addRustSharedClassReturnRefusals(
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  for (const function_ of module.functions) {
    if (!isRustReferencePotentialClassReturn(function_, module, modules, moduleResolution)) continue;
    if (isRustReferenceClassReturnSupported(function_, module, modules, moduleResolution, new Set())) continue;
    const subject = `${moduleKey(module.module)}:${function_.declaration.binding.id}:return`;
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-return-unrepresented',
      subject,
      `function ${function_.declaration.binding.name} does not have one exact synchronous simple-class return completion`,
    );
    const type = getRustReferenceFunctionClassReturnType(function_.declaration);
    const carrier = getRustSharedClassCarrierTypeCandidate(type, module.module, module.classBindingIds);
    const location = carrier
      ? getRustReferenceClassDeclaration(carrier.classType, module, modules, moduleResolution)
      : undefined;
    if (location) {
      addRustSimpleClassDeclarationRefusals(
        location.declaration,
        location.module,
        modules,
        moduleResolution,
        subject,
        refusals,
      );
    }
  }
}

function isRustReferencePotentialClassReturn(
  function_: RustReferenceFunctionRecord,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  visiting: ReadonlySet<string> = new Set(),
): boolean {
  const key = `${moduleKey(module.module)}:${function_.declaration.binding.id}:potential-return`;
  if (visiting.has(key)) return true;
  const type = getRustReferenceFunctionClassReturnType(function_.declaration);
  if (
    type &&
    type.kind !== 'unknown' &&
    !isRustReferencePotentialClassReturnType(type, module, modules, moduleResolution)
  ) {
    return false;
  }
  return getRustReferenceAnyClassReturnExpressions(function_).some((expression) =>
    isRustReferencePotentialClassReturnExpression(
      expression,
      module,
      modules,
      moduleResolution,
      new Set(visiting).add(key),
    ),
  );
}

function isRustReferencePotentialClassReturnType(
  type: Readonly<IrType>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  const candidate = getRustSharedClassCarrierTypeCandidate(type, module.module, module.classBindingIds);
  const location = getRustReferenceClassDeclaration(candidate?.classType ?? type, module, modules, moduleResolution);
  if (location) {
    return isRustReferenceClassReturnDeclarationInScope(
      location.declaration,
      location.module,
      modules,
      moduleResolution,
    );
  }
  return type.kind === 'union' || type.kind === 'intersection'
    ? type.types.some((member) => isRustReferencePotentialClassReturnType(member, module, modules, moduleResolution))
    : false;
}

function isRustReferenceClassReturnDeclarationInScope(
  declaration: Readonly<IrClassDeclaration>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  return (
    isRustSimpleClassDeclarationSupported(declaration, module, modules, moduleResolution, new Set()) ||
    declaration.abstract ||
    declaration.extends !== undefined ||
    declaration.implements.length > 0 ||
    declaration.typeParameters.length > 0 ||
    declaration.fields.some((field) => !isRustSimpleClassField(field)) ||
    declaration.methods.some((method) => !method.static && method.accessor !== undefined)
  );
}

function getRustReferenceAnyClassReturnExpressions(
  function_: RustReferenceFunctionRecord,
): readonly Readonly<IrExpression>[] {
  const expressions: IrExpression[] = [];
  for (const statement of function_.declaration.body) {
    analyzeIrStatementSubtreeTraversal(statement, {
      statement(candidate) {
        if (candidate.kind === 'return' && candidate.expression) expressions.push(candidate.expression);
        return undefined;
      },
    });
  }
  return expressions;
}

function getRustReferenceFunctionClassReturnType(
  declaration: Readonly<IrFunctionDeclaration>,
): Readonly<IrType> | undefined {
  if (!declaration.async) return declaration.returns;
  const type = declaration.returns;
  return type.kind === 'named' &&
    type.reference.kind === 'ambient' &&
    (type.reference.name === 'Promise' || type.reference.name === 'PromiseLike') &&
    type.typeArguments.length === 1
    ? type.typeArguments[0]
    : undefined;
}

function getRustReferenceClassReturnExpression(
  function_: RustReferenceFunctionRecord,
): Readonly<IrExpression> | undefined {
  const body = function_.declaration.body;
  const statement = body.at(-1);
  if (
    statement?.kind !== 'return' ||
    !statement.expression ||
    body.slice(0, -1).some((candidate) => candidate.kind !== 'expression' && candidate.kind !== 'variable')
  ) {
    return undefined;
  }
  return statement.expression;
}

function isRustReferenceClassReturnSupported(
  function_: RustReferenceFunctionRecord,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  visitingFunctions: ReadonlySet<string>,
): boolean {
  return (
    getRustReferenceClassReturnCarrier(function_, module, modules, moduleResolution, visitingFunctions) !== undefined
  );
}

function getRustReferenceClassReturnCarrier(
  function_: RustReferenceFunctionRecord,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  visitingFunctions: ReadonlySet<string>,
): RustSharedClassCarrierType | undefined {
  const declaration = function_.declaration;
  const type = getRustReferenceFunctionClassReturnType(declaration);
  const carrier = getRustSharedClassCarrierType(type, module, modules, moduleResolution);
  if (
    declaration.async ||
    declaration.overloads.length > 0 ||
    declaration.typeParameters.length > 0 ||
    (carrier?.representation !== 'shared-ref-cell-class' &&
      !isRustReferenceMixedFixedClassAbiShapeSupported(function_, module, modules, moduleResolution)) ||
    !carrier
  ) {
    return undefined;
  }
  const expression = getRustReferenceClassReturnExpression(function_);
  if (!expression) return undefined;
  const key = `${moduleKey(module.module)}:${declaration.binding.id}:return`;
  if (visitingFunctions.has(key)) return carrier;
  return isRustReferenceClassReturnExpressionSupported(
    expression,
    carrier,
    module,
    modules,
    moduleResolution,
    new Set(visitingFunctions).add(key),
    new Set(),
  )
    ? carrier
    : undefined;
}

function isRustReferenceClassReturnExpressionSupported(
  expression: Readonly<IrExpression>,
  returnCarrier: RustSharedClassCarrierType,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  visitingFunctions: ReadonlySet<string>,
  visitingBindings: ReadonlySet<string>,
): boolean {
  if (returnCarrier.sentinel && isRustReferenceSentinelExpression(expression, returnCarrier.sentinel)) return true;
  if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
    const bindingId = expression.reference.binding.id;
    if (visitingBindings.has(bindingId)) return false;
    const evidence = module.ownership.bindings.find((candidate) => candidate.binding.id === bindingId);
    const variable = module.sharedClasses.variablesByBindingId.get(bindingId);
    const actual = getRustSharedClassCarrierType(module.bindingTypes.get(bindingId), module, modules, moduleResolution);
    if (
      !evidence ||
      !actual ||
      !isRustReferenceSameClassCarrier(actual, module, returnCarrier, module, modules, moduleResolution) ||
      (actual.representation !== 'shared-ref-cell-class' && actual.representation !== returnCarrier.representation)
    ) {
      return false;
    }
    if (evidence.declaration === 'parameter') {
      return actual.representation !== 'shared-ref-cell-class';
    }
    return (
      evidence?.declaration === 'immutable' &&
      evidence.binding.scope !== 'module' &&
      variable?.initializer !== undefined &&
      isRustReferenceClassReturnExpressionSupported(
        variable.initializer,
        returnCarrier,
        module,
        modules,
        moduleResolution,
        visitingFunctions,
        new Set(visitingBindings).add(bindingId),
      )
    );
  }
  if (expression.kind === 'new') {
    return isRustSimpleClassConstruction(expression, returnCarrier.classType, module, modules, moduleResolution);
  }
  if (expression.kind === 'call') {
    const target = resolveRustReferenceCallTarget(expression, module, modules, moduleResolution);
    if (target.kind !== 'function') return false;
    const targetCarrier = getRustReferenceClassReturnCarrier(
      target.function,
      target.module,
      modules,
      moduleResolution,
      visitingFunctions,
    );
    return (
      targetCarrier !== undefined &&
      isRustReferenceSameClassCarrier(targetCarrier, target.module, returnCarrier, module, modules, moduleResolution) &&
      (targetCarrier.representation === 'shared-ref-cell-class' ||
        targetCarrier.representation === returnCarrier.representation)
    );
  }
  return (
    expression.kind === 'conditional' &&
    isRustReferenceClassReturnExpressionSupported(
      expression.whenTrue,
      returnCarrier,
      module,
      modules,
      moduleResolution,
      visitingFunctions,
      visitingBindings,
    ) &&
    isRustReferenceClassReturnExpressionSupported(
      expression.whenFalse,
      returnCarrier,
      module,
      modules,
      moduleResolution,
      visitingFunctions,
      visitingBindings,
    )
  );
}

function isRustReferencePotentialClassReturnExpression(
  expression: Readonly<IrExpression>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  visiting: ReadonlySet<string>,
): boolean {
  if (expression.kind === 'new') return isRustReferenceClassExpression(expression, module);
  if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
    const type = module.bindingTypes.get(expression.reference.binding.id);
    return type !== undefined && isRustReferencePotentialClassReturnType(type, module, modules, moduleResolution);
  }
  if (expression.kind === 'conditional') {
    return (
      isRustReferencePotentialClassReturnExpression(expression.whenTrue, module, modules, moduleResolution, visiting) ||
      isRustReferencePotentialClassReturnExpression(expression.whenFalse, module, modules, moduleResolution, visiting)
    );
  }
  if (expression.kind !== 'call') return false;
  const target = resolveRustReferenceCallTarget(expression, module, modules, moduleResolution);
  if (target.kind !== 'function') return false;
  const key = `${moduleKey(target.module.module)}:${target.function.declaration.binding.id}:potential-return`;
  if (visiting.has(key)) return true;
  const type = getRustReferenceFunctionClassReturnType(target.function.declaration);
  return (
    (type !== undefined && isRustReferencePotentialClassReturnType(type, target.module, modules, moduleResolution)) ||
    isRustReferencePotentialClassReturn(
      target.function,
      target.module,
      modules,
      moduleResolution,
      new Set(visiting).add(key),
    )
  );
}

function isRustReferenceSharedClassReturnCall(
  expression: Readonly<IrExpression>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  if (expression.kind !== 'call') return false;
  const target = resolveRustReferenceCallTarget(expression, module, modules, moduleResolution);
  return (
    target.kind === 'function' &&
    isRustReferenceClassReturnSupported(target.function, target.module, modules, moduleResolution, new Set())
  );
}

function getRustReferenceClassBorrowPositions(
  function_: RustReferenceFunctionRecord,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): ReadonlySet<number> {
  return new Set(
    function_.declaration.parameters.flatMap((_, position) =>
      isRustReferenceClassBorrowPositionSupported(function_, position, module, modules, moduleResolution, new Set())
        ? [position]
        : [],
    ),
  );
}

function getRustReferenceOptionalClassParameterPlans(
  function_: RustReferenceFunctionRecord,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): ReadonlyMap<
  number,
  RustSharedClassCarrierType & Readonly<{ representation: RustOptionalSharedClassRepresentation }>
> {
  const declaration = function_.declaration;
  if (!isRustReferenceMixedFixedClassAbiShapeSupported(function_, module, modules, moduleResolution)) {
    return new Map();
  }
  return new Map(
    declaration.parameters.flatMap((parameter, position) => {
      const carrier = getRustReferenceOptionalClassParameterCarrier(parameter, module, modules, moduleResolution);
      return carrier ? ([[position, carrier]] as const) : [];
    }),
  );
}

function getRustReferenceOptionalClassParameterCarrier(
  parameter: Readonly<IrFunctionDeclaration['parameters'][number]>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): (RustSharedClassCarrierType & Readonly<{ representation: RustOptionalSharedClassRepresentation }>) | undefined {
  const explicit = getRustOptionalSharedClassCarrierType(parameter.type, module, modules, moduleResolution);
  if (explicit) return explicit;
  if (!parameter.optional || parameter.initializer || parameter.rest) return undefined;
  const required = getRustSharedClassCarrierType(parameter.type, module, modules, moduleResolution);
  return required?.representation === 'shared-ref-cell-class'
    ? {
        classType: required.classType,
        representation: 'optional-undefined-shared-ref-cell-class',
        sentinel: 'undefined',
      }
    : undefined;
}

function isRustReferenceClassBorrowPositionSupported(
  function_: RustReferenceFunctionRecord,
  position: number,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  visiting: ReadonlySet<string>,
): boolean {
  const declaration = function_.declaration;
  const parameter = declaration.parameters[position];
  if (
    !parameter ||
    !isRustReferenceMixedFixedClassAbiShapeSupported(function_, module, modules, moduleResolution) ||
    getRustReferenceMixedFixedClassAbiParameterShape(parameter, module, modules, moduleResolution) !== 'fixed-class' ||
    !isRustSharedClassTypeSupported(parameter.type, module, modules, moduleResolution)
  ) {
    return false;
  }
  const key = `${moduleKey(module.module)}:${declaration.binding.id}:${String(position)}`;
  if (visiting.has(key)) return true;
  const nextVisiting = new Set(visiting).add(key);
  const evidence = module.ownership.bindings.find((candidate) => candidate.binding.id === parameter.binding.id);
  if (
    !evidence ||
    evidence.boundaries.some(
      (boundary) => boundary === 'closureCapture' || boundary === 'structuralRecord' || boundary === 'suspension',
    )
  ) {
    return false;
  }
  return evidence.uses.every((use) => {
    const expression = getIrModuleTraversalPathValue(module.module, use.path);
    if (
      !isIrExpressionValue(expression) ||
      expression.kind !== 'identifier' ||
      expression.reference.kind !== 'binding' ||
      expression.reference.binding.id !== parameter.binding.id
    ) {
      return false;
    }
    const parent = getIrModuleTraversalPathValue(module.module, use.path.slice(0, -1));
    if (use.path.at(-1) === 'object' && isIrExpressionValue(parent) && parent.kind === 'property') {
      if (parent.optional || parent.structuralAccess) return false;
      if (getRustReferenceClassField(expression, parent.name, module, modules, moduleResolution)) return true;
      const call = getIrModuleTraversalPathValue(module.module, use.path.slice(0, -2));
      return (
        isCallExpression(call) &&
        call.callee === parent &&
        getRustSimpleClassMethodCall(call, module, modules, moduleResolution) !== undefined
      );
    }
    if (use.path.at(-2) !== 'arguments' || typeof use.path.at(-1) !== 'number') return false;
    const call = getIrModuleTraversalPathValue(module.module, use.path.slice(0, -2));
    if (!isCallExpression(call) || call.optional) return false;
    const targetPosition = use.path.at(-1) as number;
    const method = getRustSimpleClassMethodCall(call, module, modules, moduleResolution);
    const methodParameter = method?.plan.requiredClassParameters.get(targetPosition);
    if (methodParameter && method) {
      return isRustReferenceSameClassType(
        parameter.type,
        module,
        methodParameter.classType,
        method.module,
        modules,
        moduleResolution,
      );
    }
    const target = resolveRustReferenceCallTarget(call, module, modules, moduleResolution);
    if (target.kind !== 'function') return false;
    const targetParameter = target.function.declaration.parameters[targetPosition];
    return (
      targetParameter !== undefined &&
      isRustReferenceSameClassType(
        parameter.type,
        module,
        targetParameter.type,
        target.module,
        modules,
        moduleResolution,
      ) &&
      isRustReferenceClassBorrowPositionSupported(
        target.function,
        targetPosition,
        target.module,
        modules,
        moduleResolution,
        nextVisiting,
      )
    );
  });
}

type RustReferenceMixedFixedClassAbiParameterShape =
  | 'fixed'
  | 'fixed-class'
  | 'optional-class'
  | 'primitive-adjunct'
  | 'unsupported';

function getRustReferenceMixedFixedClassAbiParameterShape(
  parameter: Readonly<IrFunctionDeclaration['parameters'][number]>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): RustReferenceMixedFixedClassAbiParameterShape {
  if (parameter.rest) return 'unsupported';
  if (isRustPotentialClassParameterType(parameter.type, module.module, module.classBindingIds)) {
    if (parameter.initializer) return 'unsupported';
    const carrier = getRustSharedClassCarrierType(parameter.type, module, modules, moduleResolution);
    if (!carrier || carrier.representation !== 'shared-ref-cell-class') {
      return parameter.optional ? 'unsupported' : carrier ? 'fixed-class' : 'unsupported';
    }
    return parameter.optional ? 'optional-class' : 'fixed-class';
  }
  if (!parameter.initializer && !parameter.optional) return 'fixed';
  if (!isRustSimpleClassPrimitiveType(parameter.type)) return 'unsupported';
  if (!parameter.initializer) return 'primitive-adjunct';
  const initializerType = getRustSimpleClassPrimitiveExpressionType(parameter.initializer, module);
  return initializerType?.name === parameter.type.name &&
    !hasRustReferenceClassBindingInExpression(parameter.initializer, module)
    ? 'primitive-adjunct'
    : 'unsupported';
}

function hasRustReferenceClassBindingInExpression(
  expression: Readonly<IrExpression>,
  module: RustReferenceModuleRecord,
): boolean {
  let found = false;
  analyzeIrExpressionSubtreeTraversal(expression, {
    expression(candidate) {
      const type = getRustReferenceClassIdentityExpressionType(candidate, module);
      if (type && getRustSharedClassCarrierTypeCandidate(type, module.module, module.classBindingIds)) {
        found = true;
        return false;
      }
      return undefined;
    },
  });
  return found;
}

function isRustReferenceMixedFixedClassAbiShapeSupported(
  function_: RustReferenceFunctionRecord,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  const declaration = function_.declaration;
  if (declaration.async || declaration.overloads.length > 0 || declaration.typeParameters.length > 0) return false;
  let inOptionalClassSuffix = false;
  let inPrimitiveAdjunctSuffix = false;
  for (const parameter of declaration.parameters) {
    const shape = getRustReferenceMixedFixedClassAbiParameterShape(parameter, module, modules, moduleResolution);
    if (
      shape === 'unsupported' ||
      (inPrimitiveAdjunctSuffix && shape !== 'primitive-adjunct') ||
      (inOptionalClassSuffix && shape !== 'optional-class' && shape !== 'primitive-adjunct')
    ) {
      return false;
    }
    if (shape === 'optional-class') inOptionalClassSuffix = true;
    if (shape === 'primitive-adjunct') inPrimitiveAdjunctSuffix = true;
  }
  return true;
}

function getRustReferenceAnyClassParameterPositions(
  function_: RustReferenceFunctionRecord,
  module: RustReferenceModuleRecord,
): ReadonlySet<number> {
  return new Set(
    function_.declaration.parameters.flatMap((parameter, position) =>
      isRustPotentialClassParameterType(parameter.type, module.module, module.classBindingIds) ? [position] : [],
    ),
  );
}

function isRustPotentialClassParameterType(
  type: Readonly<IrType>,
  module: Readonly<IrModule>,
  classBindingIds: ReadonlySet<string>,
): boolean {
  if (isRustClassLikeType(type, module, classBindingIds)) return true;
  return type.kind === 'union' || type.kind === 'intersection'
    ? type.types.some((member) => isRustPotentialClassParameterType(member, module, classBindingIds))
    : false;
}

function getRustReferenceAnyClassMutationPositions(
  function_: RustReferenceFunctionRecord,
  module: RustReferenceModuleRecord,
): ReadonlySet<number> {
  return new Set(
    [...function_.mutatedParameterPositions].filter((position) =>
      getRustSharedClassCarrierTypeCandidate(
        function_.declaration.parameters[position]?.type,
        module.module,
        module.classBindingIds,
      ),
    ),
  );
}

function getRustReferenceHashCollectionMutationPositions(
  function_: RustReferenceFunctionRecord,
  kind: RustSharedHashCollectionKind,
): ReadonlySet<number> {
  return new Set(
    [...function_.mutatedParameterPositions].filter((position) =>
      isRustSharedHashCollectionTypeSupported(function_.declaration.parameters[position]?.type, kind),
    ),
  );
}

function getRustReferenceAnyHashCollectionMutationPositions(
  function_: RustReferenceFunctionRecord,
  kind: RustSharedHashCollectionKind,
): ReadonlySet<number> {
  return new Set(
    [...function_.mutatedParameterPositions].filter((position) =>
      isRustAmbientHashCollectionType(function_.declaration.parameters[position]?.type, kind),
    ),
  );
}

function resolveRustReferenceCallTarget(
  call: IrCallExpression,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): RustReferenceCallTarget {
  if (call.callee.kind !== 'identifier' || call.callee.reference.kind !== 'binding') {
    return { kind: 'local-unplanned' };
  }
  const binding = call.callee.reference.binding;
  const local = module.functionsByBindingId.get(binding.id);
  if (local) return { function: local, kind: 'function', module };
  const imported = module.importsByBindingId.get(binding.id);
  if (!imported || imported.binding.imported === '*' || imported.binding.typeOnly) return { kind: 'local-unplanned' };
  const targets = resolveRustReferenceImportModules(imported, module.module, modules, moduleResolution);
  if (targets.length === 0) return { imported, kind: 'unresolved' };
  if (targets.length > 1) return { imported, kind: 'ambiguous' };
  const functions = targets[0]!.functions.filter(
    (function_) => function_.declaration.exported && function_.declaration.binding.name === imported.binding.imported,
  );
  if (functions.length === 0) return { imported, kind: 'unrepresented' };
  if (functions.length > 1) return { imported, kind: 'ambiguous' };
  return { function: functions[0]!, imported, kind: 'function', module: targets[0]! };
}

function resolveRustReferenceImportModules(
  imported: RustReferenceImportRecord,
  importer: Readonly<IrModule>,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): readonly RustReferenceModuleRecord[] {
  const matching = moduleResolution?.edges.filter((edge) => edge.specifier === imported.specifier) ?? [];
  const exact = matching.filter((edge) => edge.importer && sameModuleIdentity(edge.importer, importer));
  const scoped = exact.length > 0 ? exact : matching.filter((edge) => !edge.importer);
  const edges = scoped.filter(
    (edge) => edge.importedNames === undefined || edge.importedNames.includes(imported.binding.imported),
  );
  const planned = edges.flatMap((edge) =>
    modules.filter(
      (candidate) =>
        candidate.module.packageName === edge.target.packageName &&
        normalizePathPortable(candidate.module.source) === normalizePathPortable(edge.target.source),
    ),
  );
  const relative =
    planned.length === 0 && imported.specifier.startsWith('.')
      ? resolveRelativeRustReferenceModules(imported.specifier, importer, modules)
      : [];
  return uniqueRustReferenceModules([...planned, ...relative]);
}

function resolveRelativeRustReferenceModules(
  specifier: string,
  importer: Readonly<IrModule>,
  modules: readonly RustReferenceModuleRecord[],
): readonly RustReferenceModuleRecord[] {
  const source = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer.source), specifier.replace(/\.[cm]?js$/u, '.ts')),
  );
  const candidates = new Set([source, `${source}.ts`, `${source}/index.ts`].map(normalizePathPortable));
  return modules.filter(
    (candidate) =>
      candidate.module.packageName === importer.packageName &&
      candidates.has(normalizePathPortable(candidate.module.source)),
  );
}

function uniqueRustReferenceModules(
  modules: readonly RustReferenceModuleRecord[],
): readonly RustReferenceModuleRecord[] {
  return [...new Map(modules.map((module) => [moduleKey(module.module), module])).values()];
}

function isRustReferenceArrayExpression(
  expression: Readonly<IrExpression>,
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
): boolean {
  if (expression.kind === 'array') return true;
  if (expression.kind === 'cast') return expression.type.kind === 'array';
  return (
    expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    bindingTypes.get(expression.reference.binding.id)?.kind === 'array'
  );
}

function isRustReferenceClassExpression(
  expression: Readonly<IrExpression>,
  module: RustReferenceModuleRecord,
): boolean {
  const type = getRustReferenceClassIdentityExpressionType(expression, module);
  return (
    type !== undefined &&
    getRustSharedClassCarrierTypeCandidate(type, module.module, module.classBindingIds) !== undefined
  );
}

function isRustReferenceHashCollectionExpression(
  expression: Readonly<IrExpression>,
  bindingTypes: ReadonlyMap<string, Readonly<IrType>>,
  kind: RustSharedHashCollectionKind,
): boolean {
  if (isZeroArgumentAmbientHashCollectionConstruction(expression, kind)) return true;
  if (expression.kind === 'cast') return isRustAmbientHashCollectionType(expression.type, kind);
  return (
    expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    isRustAmbientHashCollectionType(bindingTypes.get(expression.reference.binding.id), kind)
  );
}

function getRustAmbientHashCollectionTypeArguments(
  type: Readonly<IrType> | undefined,
  kind: RustSharedHashCollectionKind,
): readonly Readonly<IrType>[] | undefined {
  if (
    type?.kind !== 'named' ||
    type.reference.kind !== 'ambient' ||
    type.reference.name !== getRustReferenceHashCollectionName(kind) ||
    type.typeArguments.length !== (kind === 'map' ? 2 : 1)
  ) {
    return undefined;
  }
  return type.typeArguments;
}

function isRustAmbientHashCollectionType(
  type: Readonly<IrType> | undefined,
  kind: RustSharedHashCollectionKind,
): boolean {
  return getRustAmbientHashCollectionTypeArguments(type, kind) !== undefined;
}

function isRustHashCollectionLikeType(
  type: Readonly<IrType> | undefined,
  module: Readonly<IrModule>,
  kind: RustSharedHashCollectionKind,
  resolving: ReadonlySet<string> = new Set(),
): boolean {
  if (isRustAmbientHashCollectionType(type, kind)) return true;
  if (
    type?.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.path.length > 0 ||
    resolving.has(type.reference.binding.id)
  ) {
    return false;
  }
  const bindingId = type.reference.binding.id;
  const declaration = module.declarations.find(
    (candidate) => candidate.kind === 'typeAlias' && candidate.binding.id === bindingId,
  );
  return declaration?.kind === 'typeAlias'
    ? isRustHashCollectionLikeType(declaration.type, module, kind, new Set(resolving).add(bindingId))
    : false;
}

function isRustClassLikeType(
  type: Readonly<IrType> | undefined,
  module: Readonly<IrModule>,
  classBindingIds: ReadonlySet<string>,
  resolving: ReadonlySet<string> = new Set(),
): boolean {
  if (
    type?.kind !== 'named' ||
    type.reference.kind !== 'binding' ||
    type.reference.path.length > 0 ||
    resolving.has(type.reference.binding.id)
  ) {
    return false;
  }
  const bindingId = type.reference.binding.id;
  if (classBindingIds.has(bindingId)) return true;
  const declaration = module.declarations.find(
    (candidate) => candidate.kind === 'typeAlias' && candidate.binding.id === bindingId,
  );
  return declaration?.kind === 'typeAlias'
    ? isRustClassLikeType(declaration.type, module, classBindingIds, new Set(resolving).add(bindingId))
    : false;
}

function getRustSharedClassCarrierTypeCandidate(
  type: Readonly<IrType> | undefined,
  module: Readonly<IrModule>,
  classBindingIds: ReadonlySet<string>,
  resolving: ReadonlySet<string> = new Set(),
): RustSharedClassCarrierType | undefined {
  if (!type) return undefined;
  if (
    type.kind === 'named' &&
    type.reference.kind === 'binding' &&
    type.reference.path.length === 0 &&
    !resolving.has(type.reference.binding.id)
  ) {
    const bindingId = type.reference.binding.id;
    const alias = module.declarations.find(
      (candidate) => candidate.kind === 'typeAlias' && candidate.binding.id === bindingId,
    );
    if (alias?.kind === 'typeAlias') {
      return getRustSharedClassCarrierTypeCandidate(
        alias.type,
        module,
        classBindingIds,
        new Set(resolving).add(bindingId),
      );
    }
  }
  if (isRustClassLikeType(type, module, classBindingIds)) {
    return { classType: type, representation: 'shared-ref-cell-class' };
  }
  if (type.kind !== 'union' || type.types.length !== 2) return undefined;
  const sentinelMembers = type.types.filter(
    (member): member is Extract<IrType, { kind: 'null' | 'undefined' }> =>
      member.kind === 'null' || member.kind === 'undefined',
  );
  if (sentinelMembers.length !== 1) return undefined;
  const classMembers = type.types.filter((member) => member !== sentinelMembers[0]);
  if (classMembers.length !== 1) return undefined;
  const classCarrier = getRustSharedClassCarrierTypeCandidate(classMembers[0], module, classBindingIds, resolving);
  if (!classCarrier || classCarrier.representation !== 'shared-ref-cell-class') return undefined;
  const sentinel = sentinelMembers[0]!.kind;
  return {
    classType: classCarrier.classType,
    representation:
      sentinel === 'null' ? 'optional-null-shared-ref-cell-class' : 'optional-undefined-shared-ref-cell-class',
    sentinel,
  };
}

function getRustReferenceClassDeclaration(
  type: Readonly<IrType> | undefined,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): Readonly<{ declaration: Readonly<IrClassDeclaration>; module: RustReferenceModuleRecord }> | undefined {
  if (type?.kind !== 'named' || type.reference.kind !== 'binding' || type.reference.path.length > 0) {
    return undefined;
  }
  const bindingId = type.reference.binding.id;
  const local = module.module.declarations.find(
    (candidate) => candidate.kind === 'class' && candidate.binding.id === bindingId,
  );
  if (local?.kind === 'class') return { declaration: local, module };
  const imported = module.importsByBindingId.get(bindingId);
  if (!imported || imported.binding.imported === '*') return undefined;
  const targets = resolveRustReferenceImportModules(imported, module.module, modules, moduleResolution);
  const matches = targets.flatMap((target) =>
    target.module.declarations.flatMap((candidate) =>
      candidate.kind === 'class' && candidate.exported && candidate.binding.name === imported.binding.imported
        ? [{ declaration: candidate, module: target }]
        : [],
    ),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function isRustReferenceSameClassType(
  left: Readonly<IrType>,
  leftModule: RustReferenceModuleRecord,
  right: Readonly<IrType>,
  rightModule: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  const leftLocation = getRustReferenceClassDeclaration(left, leftModule, modules, moduleResolution);
  const rightLocation = getRustReferenceClassDeclaration(right, rightModule, modules, moduleResolution);
  return (
    leftLocation !== undefined &&
    rightLocation !== undefined &&
    moduleKey(leftLocation.module.module) === moduleKey(rightLocation.module.module) &&
    leftLocation.declaration.binding.id === rightLocation.declaration.binding.id
  );
}

function isRustReferenceSameClassCarrier(
  left: RustSharedClassCarrierType,
  leftModule: RustReferenceModuleRecord,
  right: RustSharedClassCarrierType,
  rightModule: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  return isRustReferenceSameClassType(
    left.classType,
    leftModule,
    right.classType,
    rightModule,
    modules,
    moduleResolution,
  );
}

function isRustReferenceExactClassArgument(
  expression: Readonly<IrExpression>,
  module: RustReferenceModuleRecord,
  parameterType: Readonly<IrType>,
  parameterModule: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  let argumentType: Readonly<IrType> | undefined;
  if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
    argumentType = module.bindingTypes.get(expression.reference.binding.id);
  } else if (expression.kind === 'call') {
    argumentType = expression.semantics.resultType;
  } else if (
    expression.kind === 'new' &&
    expression.callee.kind === 'identifier' &&
    expression.callee.reference.kind === 'binding'
  ) {
    argumentType = {
      kind: 'named',
      reference: { binding: expression.callee.reference.binding, kind: 'binding', path: [] },
      typeArguments: expression.typeArguments,
    };
  }
  const argumentCarrier = getRustSharedClassCarrierType(argumentType, module, modules, moduleResolution);
  const parameterCarrier = getRustSharedClassCarrierType(parameterType, parameterModule, modules, moduleResolution);
  return Boolean(
    argumentCarrier &&
    parameterCarrier?.representation === 'shared-ref-cell-class' &&
    isRustReferenceSameClassCarrier(
      argumentCarrier,
      module,
      parameterCarrier,
      parameterModule,
      modules,
      moduleResolution,
    ) &&
    (argumentCarrier.representation === 'shared-ref-cell-class' ||
      ('presence' in expression && expression.presence === 'narrowedPresent')),
  );
}

function isRustReferenceSentinelExpression(
  expression: Readonly<IrExpression>,
  sentinel: 'null' | 'undefined',
): boolean {
  if (sentinel === 'null') return expression.kind === 'literal' && expression.value === null;
  return (
    expression.kind === 'undefinedValue' ||
    (expression.kind === 'identifier' &&
      expression.reference.kind === 'ambient' &&
      expression.reference.name === 'undefined')
  );
}

function getRustReferenceExpressionClassCarrierType(
  expression: Readonly<IrExpression>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): RustSharedClassCarrierType | undefined {
  if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
    return getRustSharedClassCarrierType(
      module.bindingTypes.get(expression.reference.binding.id),
      module,
      modules,
      moduleResolution,
    );
  }
  if (expression.kind === 'call') {
    return getRustSharedClassCarrierType(expression.semantics.resultType, module, modules, moduleResolution);
  }
  if (expression.kind === 'cast') {
    return getRustSharedClassCarrierType(expression.type, module, modules, moduleResolution);
  }
  if (expression.kind !== 'new') return undefined;
  const type = getRustReferenceClassIdentityExpressionType(expression, module);
  return getRustSharedClassCarrierType(type, module, modules, moduleResolution);
}

function isRustReferenceClassCarrierExpressionCompatible(
  expression: Readonly<IrExpression>,
  expected: RustSharedClassCarrierType,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  expectedModule: RustReferenceModuleRecord = module,
): boolean {
  if (expected.sentinel && isRustReferenceSentinelExpression(expression, expected.sentinel)) return true;
  if (expression.kind === 'conditional') {
    return (
      isRustReferenceClassCarrierExpressionCompatible(
        expression.whenTrue,
        expected,
        module,
        modules,
        moduleResolution,
        expectedModule,
      ) &&
      isRustReferenceClassCarrierExpressionCompatible(
        expression.whenFalse,
        expected,
        module,
        modules,
        moduleResolution,
        expectedModule,
      )
    );
  }
  if (expression.kind === 'call') {
    const target = resolveRustReferenceCallTarget(expression, module, modules, moduleResolution);
    const returned =
      target.kind === 'function'
        ? getRustReferenceClassReturnCarrier(target.function, target.module, modules, moduleResolution, new Set())
        : undefined;
    return Boolean(
      returned &&
      isRustReferenceSameClassCarrier(
        returned,
        target.kind === 'function' ? target.module : module,
        expected,
        expectedModule,
        modules,
        moduleResolution,
      ) &&
      (returned.representation === 'shared-ref-cell-class' ||
        returned.representation === expected.representation ||
        (expected.representation === 'shared-ref-cell-class' &&
          'presence' in expression &&
          expression.presence === 'narrowedPresent')),
    );
  }
  const actual = getRustReferenceExpressionClassCarrierType(expression, module, modules, moduleResolution);
  if (
    !actual ||
    !isRustReferenceSameClassCarrier(actual, module, expected, expectedModule, modules, moduleResolution)
  ) {
    return false;
  }
  if (actual.representation !== 'shared-ref-cell-class' && actual.representation !== expected.representation) {
    return false;
  }
  if (expected.representation === 'shared-ref-cell-class' && actual.representation !== 'shared-ref-cell-class') {
    return 'presence' in expression && expression.presence === 'narrowedPresent';
  }
  if (expression.kind === 'new') {
    return isRustSimpleClassConstruction(expression, actual.classType, module, modules, moduleResolution);
  }
  return expression.kind === 'identifier';
}

function getRustReferenceClassField(
  expression: Readonly<Extract<IrExpression, { kind: 'identifier' }>>,
  name: string,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): Readonly<IrClassField> | undefined {
  if (expression.reference.kind !== 'binding') return undefined;
  const carrier = getRustSharedClassCarrierType(
    module.bindingTypes.get(expression.reference.binding.id),
    module,
    modules,
    moduleResolution,
  );
  if (!carrier || (carrier.sentinel && expression.presence !== 'narrowedPresent')) return undefined;
  const location = getRustReferenceClassDeclaration(carrier.classType, module, modules, moduleResolution);
  return location?.declaration.fields.find((field) => !field.static && field.name === name);
}

function getRustSimpleClassMethod(
  expression: Readonly<Extract<IrExpression, { kind: 'identifier' }>>,
  name: string,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
):
  | Readonly<{
      declaration: Readonly<IrClassDeclaration>;
      method: Readonly<IrClassMethod>;
      module: RustReferenceModuleRecord;
    }>
  | undefined {
  if (expression.reference.kind !== 'binding') return undefined;
  const location = getRustReferenceClassInstanceMethod(expression, name, module, modules, moduleResolution);
  return location &&
    isRustSimpleClassDeclarationSupported(location.declaration, location.module, modules, moduleResolution, new Set())
    ? location
    : undefined;
}

function getRustReferenceClassInstanceMethod(
  expression: Readonly<IrExpression>,
  name: string,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
):
  | Readonly<{
      declaration: Readonly<IrClassDeclaration>;
      method: Readonly<IrClassMethod>;
      module: RustReferenceModuleRecord;
    }>
  | undefined {
  const location = getRustReferenceClassInstanceMethodCandidate(expression, name, module, modules, moduleResolution);
  return location &&
    isRustSimpleClassDeclarationSupported(location.declaration, location.module, modules, moduleResolution, new Set())
    ? location
    : undefined;
}

function getRustReferenceClassInstanceMethodCandidate(
  expression: Readonly<IrExpression>,
  name: string,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
):
  | Readonly<{
      declaration: Readonly<IrClassDeclaration>;
      method: Readonly<IrClassMethod>;
      module: RustReferenceModuleRecord;
    }>
  | undefined {
  const type = getRustReferenceClassIdentityExpressionType(expression, module);
  const carrier = getRustSharedClassCarrierTypeCandidate(type, module.module, module.classBindingIds);
  if (!carrier || (carrier.sentinel && (!('presence' in expression) || expression.presence !== 'narrowedPresent'))) {
    return undefined;
  }
  const location = getRustReferenceClassDeclaration(carrier.classType, module, modules, moduleResolution);
  const method = location?.declaration.methods.find(
    (candidate) => !candidate.static && candidate.accessor === undefined && candidate.name === name,
  );
  return location && method ? { declaration: location.declaration, method, module: location.module } : undefined;
}

function getRustSimpleClassMethodCall(
  call: IrCallExpression,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
):
  | Readonly<{
      declaration: Readonly<IrClassDeclaration>;
      method: Readonly<IrClassMethod>;
      module: RustReferenceModuleRecord;
      mutating: boolean;
      plan: RustSimpleClassMethodPlan;
      receiver: Readonly<Extract<IrExpression, { kind: 'identifier' }>>;
    }>
  | undefined {
  if (
    !isRustSimpleClassDirectMethodInvocation(call, true) ||
    call.callee.kind !== 'property' ||
    call.callee.optional ||
    call.callee.structuralAccess ||
    call.callee.object.kind !== 'identifier'
  ) {
    return undefined;
  }
  const receiver = call.callee.object;
  const location = getRustSimpleClassMethod(receiver, call.callee.name, module, modules, moduleResolution);
  if (!location || call.arguments.length > location.method.parameters.length) {
    return undefined;
  }
  const plan = getRustSimpleClassMethodPlan(
    location.method,
    location.declaration,
    location.module,
    modules,
    moduleResolution,
    new Set([`${moduleKey(location.module.module)}:${location.declaration.binding.id}`]),
  );
  const signature = call.semantics.signature;
  if (
    !plan ||
    (signature !== undefined &&
      (signature.parameterCount !== location.method.parameters.length ||
        signature.providedArgumentCount !== call.arguments.length))
  ) {
    return undefined;
  }
  for (const [position] of location.method.parameters.entries()) {
    const argument = call.arguments[position];
    const requiredClassParameter = plan.requiredClassParameters.get(position);
    if (requiredClassParameter) {
      if (
        !argument ||
        !isRustReferenceExactBorrowedClassArgument(
          argument,
          module,
          requiredClassParameter.classType,
          location.module,
          modules,
          moduleResolution,
        )
      ) {
        return undefined;
      }
      continue;
    }
    const carrier = plan.optionalClassParameters.get(position);
    if (carrier) {
      const parameter = location.method.parameters[position];
      if (
        parameter?.optional &&
        !hasRustReferenceOptionalParameterInvocationEvidence(call, location.method.parameters, position)
      ) {
        return undefined;
      }
      if (!argument) {
        if (parameter?.optional) continue;
        return undefined;
      }
      if (
        !isRustReferenceClassCarrierExpressionCompatible(
          argument,
          carrier,
          module,
          modules,
          moduleResolution,
          location.module,
        )
      ) {
        return undefined;
      }
      continue;
    }
    if (!argument) return undefined;
  }
  if (
    ![...plan.optionalClassParameters.keys()].some(
      (position) => location.method.parameters[position]?.optional === true,
    ) &&
    call.semantics.optionalParameters !== undefined
  ) {
    return undefined;
  }
  return {
    ...location,
    mutating: getRustSimpleClassMutatingMethodNames(location.declaration).has(location.method.name),
    plan,
    receiver,
  };
}

function isRustSimpleClassDirectMethodInvocation(call: IrCallExpression, allowOptionalParameters = false): boolean {
  return (
    !call.optional &&
    call.typeArguments.length === 0 &&
    call.semantics.defaultParameters === undefined &&
    (allowOptionalParameters || call.semantics.optionalParameters === undefined) &&
    call.semantics.overloadImplementation === undefined &&
    call.semantics.signature?.providedArgumentCount !== 'dynamic' &&
    call.semantics.signature?.restParameter === undefined
  );
}

function isRustSharedClassTypeSupported(
  type: Readonly<IrType> | undefined,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  visitingClasses: ReadonlySet<string> = new Set(),
): boolean {
  if (type?.kind !== 'named' || type.typeArguments.length > 0) return false;
  const location = getRustReferenceClassDeclaration(type, module, modules, moduleResolution);
  return (
    location !== undefined &&
    isRustSimpleClassDeclarationSupported(
      location.declaration,
      location.module,
      modules,
      moduleResolution,
      visitingClasses,
    )
  );
}

function getRustSharedClassCarrierType(
  type: Readonly<IrType> | undefined,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): RustSharedClassCarrierType | undefined {
  const carrier = getRustSharedClassCarrierTypeCandidate(type, module.module, module.classBindingIds);
  return carrier && isRustSharedClassTypeSupported(carrier.classType, module, modules, moduleResolution)
    ? carrier
    : undefined;
}

function getRustOptionalSharedClassCarrierType(
  type: Readonly<IrType> | undefined,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): (RustSharedClassCarrierType & Readonly<{ representation: RustOptionalSharedClassRepresentation }>) | undefined {
  const carrier = getRustSharedClassCarrierType(type, module, modules, moduleResolution);
  return carrier?.representation === 'optional-null-shared-ref-cell-class' ||
    carrier?.representation === 'optional-undefined-shared-ref-cell-class'
    ? (carrier as RustSharedClassCarrierType & Readonly<{ representation: RustOptionalSharedClassRepresentation }>)
    : undefined;
}

function getRustReferencePlannedClassBindingCarrier(
  bindingId: string,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): RustSharedClassCarrierType | undefined {
  if (hasRustSharedClassBinding(module.sharedClasses, bindingId)) {
    return module.sharedClasses.carrierTypesByBindingId.get(bindingId);
  }
  const carrier = getRustSharedClassCarrierType(module.bindingTypes.get(bindingId), module, modules, moduleResolution);
  if (!carrier) return undefined;
  return carrier.representation !== 'shared-ref-cell-class' ? carrier : undefined;
}

function isRustSimpleClassDeclarationSupported(
  declaration: Readonly<IrClassDeclaration>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  visitingClasses: ReadonlySet<string>,
): boolean {
  const key = `${moduleKey(module.module)}:${declaration.binding.id}`;
  if (visitingClasses.has(key)) return false;
  const nextVisiting = new Set(visitingClasses).add(key);
  return (
    !declaration.abstract &&
    declaration.extends === undefined &&
    declaration.implements.length === 0 &&
    declaration.typeParameters.length === 0 &&
    declaration.methods.every(
      (method) =>
        getRustSimpleClassMethodPlan(method, declaration, module, modules, moduleResolution, nextVisiting) !==
        undefined,
    ) &&
    declaration.fields.length > 0 &&
    declaration.fields.every(isRustSimpleClassField) &&
    isRustSimpleClassConstructionSupported(declaration, module, modules, moduleResolution, nextVisiting)
  );
}

function getRustSimpleClassMethodIdentity(
  module: RustReferenceModuleRecord,
  declaration: Readonly<IrClassDeclaration>,
  method: Readonly<IrClassMethod>,
): string {
  return `${moduleKey(module.module)}:${declaration.binding.id}:method:${method.name}`;
}

function getRustSimpleClassMethodPlan(
  method: Readonly<IrClassMethod>,
  declaration: Readonly<IrClassDeclaration>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  visitingClasses: ReadonlySet<string>,
): RustSimpleClassMethodPlan | undefined {
  if (method.async) {
    return isRustSimpleAsyncClassMethodOwnerSupported(method, declaration) &&
      isRustSimpleAsyncClassMethodBodySupported(method, declaration)
      ? {
          async: true,
          identity: getRustSimpleClassMethodIdentity(module, declaration, method),
          mutatedClassParameterPositions: new Set(),
          optionalClassParameters: new Map(),
          requiredClassParameters: new Map(),
        }
      : undefined;
  }
  if (
    method.abstract ||
    method.accessor !== undefined ||
    method.branded ||
    method.overloads.length > 0 ||
    method.static ||
    method.typeParameters.length > 0 ||
    !isRustSimpleClassMethodResultType(method.returns)
  ) {
    return undefined;
  }
  const optionalClassParameters = new Map<
    number,
    RustSharedClassCarrierType & Readonly<{ representation: RustOptionalSharedClassRepresentation }>
  >();
  const requiredClassTypes = new Map<number, Readonly<IrType>>();
  for (const [position, parameter] of method.parameters.entries()) {
    if (
      parameter.initializer === undefined &&
      !parameter.optional &&
      !parameter.rest &&
      isRustSimpleClassPrimitiveType(parameter.type)
    ) {
      continue;
    }
    if (position !== method.parameters.length - 1 || parameter.initializer !== undefined || parameter.rest) {
      return undefined;
    }
    const carrier = parameter.optional
      ? parameter.type.kind === 'named' && parameter.type.typeArguments.length === 0
        ? ({
            classType: parameter.type,
            representation: 'optional-undefined-shared-ref-cell-class',
            sentinel: 'undefined',
          } as const)
        : undefined
      : getRustSharedClassCarrierTypeCandidate(parameter.type, module.module, module.classBindingIds);
    if (!carrier) return undefined;
    const optionalCarrier =
      carrier.representation === 'optional-null-shared-ref-cell-class' ||
      carrier.representation === 'optional-undefined-shared-ref-cell-class';
    if (!optionalCarrier && carrier.representation !== 'shared-ref-cell-class') return undefined;
    const location = getRustReferenceClassDeclaration(carrier.classType, module, modules, moduleResolution);
    if (!location) return undefined;
    const selfReference =
      moduleKey(location.module.module) === moduleKey(module.module) &&
      location.declaration.binding.id === declaration.binding.id;
    if (
      !selfReference &&
      !isRustSimpleClassDeclarationSupported(
        location.declaration,
        location.module,
        modules,
        moduleResolution,
        visitingClasses,
      )
    ) {
      return undefined;
    }
    if (optionalCarrier) {
      optionalClassParameters.set(
        position,
        carrier as RustSharedClassCarrierType & Readonly<{ representation: RustOptionalSharedClassRepresentation }>,
      );
    } else {
      requiredClassTypes.set(position, carrier.classType);
    }
  }
  if (optionalClassParameters.size + requiredClassTypes.size > 1) return undefined;
  const mutatedClassParameterPositions = getRustSimpleClassMethodBodyMutationPositions(
    method,
    declaration,
    requiredClassTypes,
    optionalClassParameters,
    module,
    modules,
    moduleResolution,
  );
  if (!mutatedClassParameterPositions) return undefined;
  const requiredClassParameters = new Map(
    [...requiredClassTypes].map(([position, classType]) => [
      position,
      {
        classType,
        representation: mutatedClassParameterPositions.has(position)
          ? ('mutable-borrowed-class' as const)
          : ('borrowed-class' as const),
      },
    ]),
  );
  return {
    async: false,
    identity: getRustSimpleClassMethodIdentity(module, declaration, method),
    mutatedClassParameterPositions,
    optionalClassParameters,
    requiredClassParameters,
  };
}

function isRustSimpleAsyncClassMethodOwnerSupported(
  method: Readonly<IrClassMethod>,
  declaration: Readonly<IrClassDeclaration>,
): boolean {
  const awaited =
    method.returns.kind === 'named' &&
    method.returns.reference.kind === 'ambient' &&
    method.returns.reference.name === 'Promise' &&
    method.returns.typeArguments.length === 1
      ? method.returns.typeArguments[0]
      : undefined;
  const constructor = declaration.classConstructor;
  const constructionSupported = constructor
    ? constructor.parameters.every(
        (parameter) =>
          parameter.initializer === undefined &&
          !parameter.optional &&
          !parameter.rest &&
          isRustSimpleClassPrimitiveType(parameter.type),
      )
    : declaration.fields.every((field) => field.initializer !== undefined);
  return (
    !declaration.abstract &&
    declaration.extends === undefined &&
    declaration.implements.length === 0 &&
    declaration.typeParameters.length === 0 &&
    declaration.fields.length > 0 &&
    declaration.fields.every(isRustSimpleClassField) &&
    constructionSupported &&
    !method.abstract &&
    method.accessor === undefined &&
    method.async &&
    !method.branded &&
    method.overloads.length === 0 &&
    !method.static &&
    method.typeParameters.length === 0 &&
    awaited !== undefined &&
    isRustSimpleAsyncMethodAwaitedType(awaited) &&
    method.parameters.every(
      (parameter) =>
        parameter.initializer === undefined &&
        !parameter.optional &&
        !parameter.rest &&
        (isRustSimpleClassPrimitiveType(parameter.type) || isRustSimpleAsyncMethodTaskType(parameter.type)),
    )
  );
}

function isRustSimpleAsyncMethodTaskType(type: Readonly<IrType>): boolean {
  if (
    type.kind !== 'named' ||
    type.reference.kind !== 'ambient' ||
    type.reference.name !== 'Promise' ||
    type.typeArguments.length !== 1
  ) {
    return false;
  }
  const awaited = type.typeArguments[0];
  return awaited !== undefined && isRustSimpleAsyncMethodAwaitedType(awaited);
}

function isRustSimpleAsyncMethodAwaitedType(type: Readonly<IrType>): boolean {
  return (
    type.kind === 'primitive' &&
    (type.name === 'boolean' || type.name === 'number' || type.name === 'string' || type.name === 'void')
  );
}

function isRustSimpleAsyncClassMethodBodySupported(
  method: Readonly<IrClassMethod>,
  declaration: Readonly<IrClassDeclaration>,
): boolean {
  const fields = new Map(
    declaration.fields.filter((field) => !field.static).map((field) => [field.name, field] as const),
  );
  const allowedThisReferences = new WeakSet<object>();
  const thisReferences: object[] = [];
  let supported = true;
  for (const statement of method.body) {
    let statementHasAwait = false;
    let statementHasThis = false;
    analyzeIrStatementSubtreeTraversal(statement, {
      expression(expression) {
        if (expression.kind === 'function') {
          supported = false;
          return false;
        }
        if (expression.kind === 'await') statementHasAwait = true;
        if (
          expression.kind === 'property' &&
          !expression.optional &&
          !expression.structuralAccess &&
          expression.object.kind === 'identifier' &&
          expression.object.reference.kind === 'this' &&
          fields.has(expression.name)
        ) {
          allowedThisReferences.add(expression.object);
        }
        if (expression.kind === 'identifier' && expression.reference.kind === 'this') {
          statementHasThis = true;
          thisReferences.push(expression);
        }
        if (expression.kind === 'assignment' && hasRustSimpleAsyncMethodThisTarget(expression.left)) {
          const field = expression.left.kind === 'property' ? fields.get(expression.left.name) : undefined;
          if (!field || !isRustSimpleAsyncMethodFieldAssignmentSupported(expression.operator, field.type)) {
            supported = false;
          }
        }
        if (expression.kind === 'unary' && hasRustSimpleAsyncMethodThisTarget(expression.operand)) {
          const field = expression.operand.kind === 'property' ? fields.get(expression.operand.name) : undefined;
          if (
            (expression.operator !== '++' && expression.operator !== '--') ||
            field?.type.kind !== 'primitive' ||
            field.type.name !== 'number'
          ) {
            supported = false;
          }
        }
        return undefined;
      },
    });
    if (statementHasAwait && statementHasThis) supported = false;
  }
  return supported && thisReferences.every((reference) => allowedThisReferences.has(reference));
}

function hasRustSimpleAsyncMethodThisTarget(expression: Readonly<IrExpression>): boolean {
  return (
    expression.kind === 'property' &&
    !expression.optional &&
    !expression.structuralAccess &&
    expression.object.kind === 'identifier' &&
    expression.object.reference.kind === 'this'
  );
}

function isRustSimpleAsyncMethodFieldAssignmentSupported(
  operator: Extract<IrExpression, { kind: 'assignment' }>['operator'],
  type: Readonly<IrType>,
): boolean {
  if (operator === '=') return true;
  if (type.kind !== 'primitive') return false;
  if (type.name === 'string') return operator === '+=';
  if (type.name === 'boolean') return operator === '||=' || operator === '&&=';
  return (
    type.name === 'number' &&
    ['+=', '-=', '*=', '/=', '%=', '**=', '>>>=', '&=', '|=', '^=', '<<=', '>>='].includes(operator)
  );
}

function isRustPotentialClassParameterMethod(
  method: Readonly<IrClassMethod>,
  module: RustReferenceModuleRecord,
): boolean {
  return method.parameters.some((parameter) =>
    isRustPotentialClassParameterType(parameter.type, module.module, module.classBindingIds),
  );
}

function isRustSimpleClassMethodResultType(type: Readonly<IrType>): boolean {
  return (
    type.kind === 'primitive' &&
    (type.name === 'boolean' || type.name === 'number' || type.name === 'string' || type.name === 'void')
  );
}

function getRustSimpleClassMethodBodyMutationPositions(
  method: Readonly<IrClassMethod>,
  declaration: Readonly<IrClassDeclaration>,
  requiredClassTypes: ReadonlyMap<number, Readonly<IrType>>,
  optionalClassParameters: RustSimpleClassMethodPlan['optionalClassParameters'],
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): ReadonlySet<number> | undefined {
  const fieldNames = new Set(declaration.fields.filter((field) => !field.static).map((field) => field.name));
  const methodNames = new Set(
    declaration.methods.filter((candidate) => !candidate.static).map((candidate) => candidate.name),
  );
  const allowedThisReferences = new WeakSet<object>();
  const thisReferences: object[] = [];
  const allowedClassReferences = new WeakSet<object>();
  const classReferences: object[] = [];
  const projectedClassParameterIds = new Set<string>();
  const classParametersById = new Map(
    [
      ...[...requiredClassTypes].map(([position, classType]) => ({
        classType,
        optional: false,
        position,
        sentinel: undefined,
      })),
      ...[...optionalClassParameters].map(([position, carrier]) => ({
        classType: carrier.classType,
        optional: true,
        position,
        sentinel: carrier.sentinel,
      })),
    ].flatMap((record) => {
      const parameter = method.parameters[record.position];
      return parameter ? [[parameter.binding.id, { ...record, parameter }] as const] : [];
    }),
  );
  const classParameterPositionsById = new Map(
    [...classParametersById].map(([id, record]) => [id, record.position] as const),
  );
  const mutatedClassParameterPositions = new Set<number>();
  const mutatedOptionalParameterIds = new Set<string>();
  const sentinelCheckedOptionalParameterIds = new Set<string>();
  let supported = true;
  for (const statement of method.body) {
    analyzeIrStatementSubtreeTraversal(statement, {
      expression(expression) {
        if (expression.kind === 'await') {
          supported = false;
          return false;
        }
        if (expression.kind === 'function') {
          if (hasIrExpressionThisReferenceInPlan(expression)) supported = false;
          if ([...classParametersById].some(([id]) => irExpressionUsesBindingInPlan(expression, id))) {
            supported = false;
          }
          return false;
        }
        if (expression.kind === 'assignment') {
          const usesClassParameter = [...classParametersById].some(([id]) =>
            irExpressionUsesBindingInPlan(expression.left, id),
          );
          if (usesClassParameter) {
            const left = expression.left;
            const classTarget =
              left.kind === 'property' &&
              !left.optional &&
              left.structuralAccess === undefined &&
              left.object.kind === 'identifier' &&
              left.object.reference.kind === 'binding'
                ? { bindingId: left.object.reference.binding.id, object: left.object }
                : undefined;
            const record = classTarget ? classParametersById.get(classTarget.bindingId) : undefined;
            const location = record
              ? getRustReferenceClassDeclaration(record.classType, module, modules, moduleResolution)
              : undefined;
            const field =
              left.kind === 'property'
                ? location?.declaration.fields.find((candidate) => !candidate.static && candidate.name === left.name)
                : undefined;
            const position = record ? classParameterPositionsById.get(record.parameter.binding.id) : undefined;
            if (
              !record ||
              (record.optional && classTarget?.object.presence !== 'narrowedPresent') ||
              !field ||
              !isRustSimpleClassField(field) ||
              position === undefined
            ) {
              supported = false;
            } else {
              mutatedClassParameterPositions.add(position);
              if (record.optional) mutatedOptionalParameterIds.add(record.parameter.binding.id);
            }
          }
        }
        if (
          expression.kind === 'unary' &&
          (expression.operator === '++' || expression.operator === '--' || expression.operator === 'delete') &&
          [...classParametersById].some(([id]) => irExpressionUsesBindingInPlan(expression.operand, id))
        ) {
          supported = false;
        }
        if (expression.kind === 'binary' && (expression.operator === '===' || expression.operator === '!==')) {
          const pairs = [
            [expression.left, expression.right],
            [expression.right, expression.left],
          ] as const;
          for (const [candidate, sentinel] of pairs) {
            const record =
              candidate.kind === 'identifier' && candidate.reference.kind === 'binding'
                ? classParametersById.get(candidate.reference.binding.id)
                : undefined;
            if (
              record?.optional &&
              record.sentinel !== undefined &&
              isRustReferenceSentinelExpression(sentinel, record.sentinel)
            ) {
              allowedClassReferences.add(candidate);
              sentinelCheckedOptionalParameterIds.add(record.parameter.binding.id);
            }
          }
        }
        if (
          expression.kind === 'call' &&
          isRustSimpleClassDirectMethodInvocation(expression) &&
          expression.callee.kind === 'property' &&
          !expression.callee.optional &&
          !expression.callee.structuralAccess &&
          expression.callee.object.kind === 'identifier' &&
          expression.callee.object.reference.kind === 'this' &&
          methodNames.has(expression.callee.name)
        ) {
          allowedThisReferences.add(expression.callee.object);
        }
        if (
          expression.kind === 'property' &&
          !expression.optional &&
          !expression.structuralAccess &&
          expression.object.kind === 'identifier' &&
          expression.object.reference.kind === 'this' &&
          fieldNames.has(expression.name)
        ) {
          allowedThisReferences.add(expression.object);
        }
        if (
          expression.kind === 'property' &&
          !expression.optional &&
          expression.structuralAccess === undefined &&
          expression.object.kind === 'identifier' &&
          expression.object.reference.kind === 'binding'
        ) {
          const record = classParametersById.get(expression.object.reference.binding.id);
          const location = record
            ? getRustReferenceClassDeclaration(record.classType, module, modules, moduleResolution)
            : undefined;
          const field = location?.declaration.fields.find(
            (candidate) => !candidate.static && candidate.name === expression.name,
          );
          if (
            record &&
            (!record.optional || expression.object.presence === 'narrowedPresent') &&
            field &&
            isRustSimpleClassField(field)
          ) {
            allowedClassReferences.add(expression.object);
            projectedClassParameterIds.add(record.parameter.binding.id);
          }
        }
        if (expression.kind === 'identifier' && expression.reference.kind === 'this') {
          thisReferences.push(expression);
        }
        if (
          expression.kind === 'identifier' &&
          expression.reference.kind === 'binding' &&
          classParametersById.has(expression.reference.binding.id)
        ) {
          classReferences.push(expression);
        }
        return undefined;
      },
    });
  }
  return supported &&
    thisReferences.every((reference) => allowedThisReferences.has(reference)) &&
    classReferences.every((reference) => allowedClassReferences.has(reference)) &&
    [...classParametersById].every(([id]) => projectedClassParameterIds.has(id)) &&
    [...mutatedOptionalParameterIds].every((id) => sentinelCheckedOptionalParameterIds.has(id))
    ? mutatedClassParameterPositions
    : undefined;
}

function getRustSimpleClassMutatingMethodNames(declaration: Readonly<IrClassDeclaration>): ReadonlySet<string> {
  const mutating = new Set(
    declaration.methods.filter((method) => hasRustSimpleClassMethodThisMutation(method)).map((method) => method.name),
  );
  const calls = new Map(
    declaration.methods.map((method) => [method.name, getRustSimpleClassSelfCallNames(method)] as const),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const method of declaration.methods) {
      if (mutating.has(method.name)) continue;
      if ((calls.get(method.name) ?? []).some((name) => mutating.has(name))) {
        mutating.add(method.name);
        changed = true;
      }
    }
  }
  return mutating;
}

function getRustSimpleClassSelfCallNames(method: Readonly<IrClassMethod>): readonly string[] {
  const names: string[] = [];
  for (const statement of method.body) {
    analyzeIrStatementSubtreeTraversal(statement, {
      expression(expression) {
        if (
          expression.kind === 'call' &&
          expression.callee.kind === 'property' &&
          expression.callee.object.kind === 'identifier' &&
          expression.callee.object.reference.kind === 'this'
        ) {
          names.push(expression.callee.name);
        }
        return undefined;
      },
    });
  }
  return names;
}

function hasRustSimpleClassMethodThisMutation(method: Readonly<IrClassMethod>): boolean {
  let mutating = false;
  const reachesThis = (expression: Readonly<IrExpression>): boolean => {
    if (expression.kind === 'identifier') return expression.reference.kind === 'this';
    if (expression.kind === 'property' || expression.kind === 'element') return reachesThis(expression.object);
    return false;
  };
  for (const statement of method.body) {
    analyzeIrStatementSubtreeTraversal(statement, {
      expression(expression) {
        const target =
          expression.kind === 'assignment'
            ? expression.left
            : expression.kind === 'unary'
              ? expression.operand
              : undefined;
        if (!target || !reachesThis(target)) return undefined;
        mutating = true;
        return false;
      },
    });
  }
  return mutating;
}

function isRustSimpleClassField(field: Readonly<IrClassField>): boolean {
  return (
    !field.abstract &&
    !field.branded &&
    !field.declare &&
    !field.optional &&
    !field.static &&
    field.parameterProperty === undefined &&
    isRustSimpleClassPrimitiveType(field.type)
  );
}

function isRustSimpleClassConstructionSupported(
  declaration: Readonly<IrClassDeclaration>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  visitingClasses: ReadonlySet<string>,
): boolean {
  return (
    getRustSimpleClassConstructorBorrowPositions(declaration, module, modules, moduleResolution, visitingClasses) !==
    undefined
  );
}

function getRustSimpleClassConstructorBorrowPositions(
  declaration: Readonly<IrClassDeclaration>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  visitingClasses: ReadonlySet<string>,
): ReadonlySet<number> | undefined {
  return getRustSimpleClassConstructorPlan(declaration, module, modules, moduleResolution, visitingClasses)
    ?.borrowedPositions;
}

function getRustSimpleClassConstructorPlan(
  declaration: Readonly<IrClassDeclaration>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
  visitingClasses: ReadonlySet<string>,
): RustSimpleClassConstructorPlan | undefined {
  const fields = declaration.fields.filter((field) => !field.static);
  if (fields.length === 0) return undefined;
  const constructor = declaration.classConstructor;
  if (!constructor || (constructor.parameters.length === 0 && constructor.body.length === 0)) {
    return fields.every(
      (field) => field.initializer !== undefined && !hasIrExpressionThisReferenceInPlan(field.initializer),
    )
      ? { borrowedPositions: new Set(), optionalClassParameters: new Map() }
      : undefined;
  }
  if (constructor.overloads.length > 0 || fields.some((field) => field.initializer !== undefined)) {
    return undefined;
  }
  const parameters = constructor.parameters;
  const parameterKinds = parameters.map((parameter, position) => {
    if (
      !parameter.optional &&
      !parameter.rest &&
      parameter.initializer === undefined &&
      isRustSimpleClassPrimitiveType(parameter.type)
    ) {
      return { kind: 'primitive' as const };
    }
    if (
      parameter.rest ||
      parameter.initializer !== undefined ||
      !isRustSharedClassTypeSupported(parameter.type, module, modules, moduleResolution, visitingClasses)
    ) {
      return undefined;
    }
    if (!parameter.optional) return { kind: 'borrowedClass' as const };
    if (position !== parameters.length - 1) return undefined;
    return {
      carrier: {
        classType: parameter.type,
        representation: 'optional-undefined-shared-ref-cell-class' as const,
        sentinel: 'undefined' as const,
      },
      kind: 'optionalClass' as const,
    };
  });
  if (parameterKinds.some((kind) => kind === undefined)) return undefined;
  const optionalClassPositions = parameterKinds.flatMap((kind, position) =>
    kind?.kind === 'optionalClass' ? [position] : [],
  );
  if (optionalClassPositions.length > 1) return undefined;
  const borrowedPositions = new Set(
    parameterKinds.flatMap((kind, position) => (kind?.kind === 'borrowedClass' ? [position] : [])),
  );
  const optionalClassParameters = new Map(
    parameterKinds.flatMap((kind, position) =>
      kind?.kind === 'optionalClass' ? ([[position, kind.carrier]] as const) : [],
    ),
  );
  const assigned = new Set<string>();
  const usedParameters = new Set<string>();
  for (const statement of constructor.body) {
    if (statement.kind !== 'expression' || statement.expression.kind !== 'assignment') return undefined;
    const assignment = statement.expression;
    if (
      assignment.operator !== '=' ||
      assignment.left.kind !== 'property' ||
      assignment.left.optional ||
      assignment.left.object.kind !== 'identifier' ||
      assignment.left.object.reference.kind !== 'this' ||
      assigned.has(assignment.left.name) ||
      hasIrExpressionThisReferenceInPlan(assignment.right)
    ) {
      return undefined;
    }
    const fieldName = assignment.left.name;
    const field = fields.find((candidate) => candidate.name === fieldName);
    if (!field) return undefined;
    if (assignment.right.kind === 'identifier' && assignment.right.reference.kind === 'binding') {
      const parameterBindingId = assignment.right.reference.binding.id;
      const parameterPosition = parameters.findIndex((candidate) => candidate.binding.id === parameterBindingId);
      const parameter = parameters[parameterPosition];
      if (
        !parameter ||
        usedParameters.has(parameter.binding.id) ||
        parameterKinds[parameterPosition]?.kind !== 'primitive' ||
        !isRustSimpleClassPrimitiveType(field.type) ||
        !isRustSimpleClassPrimitiveType(parameter.type) ||
        field.type.name !== parameter.type.name
      ) {
        return undefined;
      }
      usedParameters.add(parameter.binding.id);
    } else if (assignment.right.kind === 'conditional') {
      const conditional = assignment.right;
      if (
        conditional.condition.kind !== 'binary' ||
        conditional.condition.operator !== '===' ||
        conditional.condition.left.kind !== 'identifier' ||
        conditional.condition.left.reference.kind !== 'binding' ||
        !isRustReferenceSentinelExpression(conditional.condition.right, 'undefined')
      ) {
        return undefined;
      }
      const parameterBindingId = conditional.condition.left.reference.binding.id;
      const parameterPosition = parameters.findIndex((candidate) => candidate.binding.id === parameterBindingId);
      const parameter = parameters[parameterPosition];
      const parameterKind = parameterKinds[parameterPosition];
      const projection = conditional.whenFalse;
      const fallbackType = getRustSimpleClassPrimitiveExpressionType(conditional.whenTrue, module);
      if (
        !parameter ||
        parameterKind?.kind !== 'optionalClass' ||
        projection.kind !== 'property' ||
        projection.optional ||
        projection.structuralAccess !== undefined ||
        projection.object.kind !== 'identifier' ||
        projection.object.reference.kind !== 'binding' ||
        projection.object.reference.binding.id !== parameterBindingId ||
        projection.object.presence !== 'narrowedPresent' ||
        !fallbackType ||
        !isRustSimpleClassPrimitiveType(field.type) ||
        fallbackType.name !== field.type.name ||
        irExpressionUsesBindingInPlan(conditional.whenTrue, parameterBindingId)
      ) {
        return undefined;
      }
      const ownerLocation = getRustReferenceClassDeclaration(parameter.type, module, modules, moduleResolution);
      const ownerField = ownerLocation?.declaration.fields.find(
        (candidate) => !candidate.static && candidate.name === projection.name,
      );
      if (
        !ownerField ||
        !isRustSimpleClassField(ownerField) ||
        !isRustSimpleClassPrimitiveType(ownerField.type) ||
        field.type.name !== ownerField.type.name
      ) {
        return undefined;
      }
      usedParameters.add(parameter.binding.id);
    } else if (
      assignment.right.kind === 'property' &&
      !assignment.right.optional &&
      assignment.right.structuralAccess === undefined &&
      assignment.right.object.kind === 'identifier' &&
      assignment.right.object.reference.kind === 'binding'
    ) {
      const projection = assignment.right;
      const parameterBindingId = assignment.right.object.reference.binding.id;
      const parameterPosition = parameters.findIndex((candidate) => candidate.binding.id === parameterBindingId);
      const parameter = parameters[parameterPosition];
      if (!parameter || parameterKinds[parameterPosition]?.kind !== 'borrowedClass') return undefined;
      const ownerLocation = getRustReferenceClassDeclaration(parameter.type, module, modules, moduleResolution);
      const ownerField = ownerLocation?.declaration.fields.find(
        (candidate) => !candidate.static && candidate.name === projection.name,
      );
      if (
        !ownerField ||
        !isRustSimpleClassField(ownerField) ||
        !isRustSimpleClassPrimitiveType(ownerField.type) ||
        !isRustSimpleClassPrimitiveType(field.type) ||
        field.type.name !== ownerField.type.name
      ) {
        return undefined;
      }
      usedParameters.add(parameter.binding.id);
    } else {
      return undefined;
    }
    assigned.add(fieldName);
  }
  return fields.length === assigned.size &&
    fields.every((field) => assigned.has(field.name)) &&
    parameters.length === usedParameters.size &&
    parameters.every((parameter) => usedParameters.has(parameter.binding.id))
    ? { borrowedPositions, optionalClassParameters }
    : undefined;
}

function irExpressionUsesBindingInPlan(expression: Readonly<IrExpression>, bindingId: string): boolean {
  let found = false;
  analyzeIrExpressionSubtreeTraversal(expression, {
    expression(candidate) {
      if (
        candidate.kind === 'identifier' &&
        candidate.reference.kind === 'binding' &&
        candidate.reference.binding.id === bindingId
      ) {
        found = true;
        return false;
      }
      return undefined;
    },
  });
  return found;
}

function hasIrExpressionThisReferenceInPlan(expression: Readonly<IrExpression>): boolean {
  let found = false;
  analyzeIrExpressionSubtreeTraversal(expression, {
    expression(candidate) {
      if (candidate.kind === 'identifier' && candidate.reference.kind === 'this') {
        found = true;
        return false;
      }
      return undefined;
    },
  });
  return found;
}

function isRustSimpleClassConstruction(
  expression: Readonly<IrExpression> | undefined,
  type: Readonly<IrType> | undefined,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  if (
    expression?.kind !== 'new' ||
    expression.callee.kind !== 'identifier' ||
    expression.callee.reference.kind !== 'binding' ||
    type?.kind !== 'named' ||
    type.reference.kind !== 'binding'
  ) {
    return false;
  }
  const typeLocation = getRustReferenceClassDeclaration(type, module, modules, moduleResolution);
  const constructorType: IrType = {
    kind: 'named',
    reference: {
      binding: expression.callee.reference.binding,
      kind: 'binding',
      path: [],
    },
    typeArguments: [],
  };
  const constructorLocation = getRustReferenceClassDeclaration(constructorType, module, modules, moduleResolution);
  return (
    typeLocation !== undefined &&
    constructorLocation !== undefined &&
    moduleKey(typeLocation.module.module) === moduleKey(constructorLocation.module.module) &&
    typeLocation.declaration.binding.id === constructorLocation.declaration.binding.id &&
    isRustSimpleClassDeclarationSupported(
      typeLocation.declaration,
      typeLocation.module,
      modules,
      moduleResolution,
      new Set(),
    ) &&
    isRustSimpleClassConstructorInvocationSupported(
      expression,
      typeLocation.declaration,
      typeLocation.module,
      module,
      modules,
      moduleResolution,
    )
  );
}

function isRustSimpleClassConstructorInvocationSupported(
  expression: Readonly<Extract<IrExpression, { kind: 'new' }>>,
  declaration: Readonly<IrClassDeclaration>,
  declarationModule: RustReferenceModuleRecord,
  callerModule: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  const parameters = declaration.classConstructor?.parameters ?? [];
  // Rust evaluates fixed call operands once from left to right. Keeping exact primitive arguments as
  // constructor operands therefore preserves source order; every dynamic/default/rest shape is refused here.
  if (
    expression.arguments.length > parameters.length ||
    expression.semantics.construction === 'factory' ||
    expression.semantics.defaultParameters !== undefined ||
    expression.semantics.overloadImplementation !== undefined ||
    expression.semantics.signature?.providedArgumentCount === 'dynamic' ||
    expression.semantics.signature?.restParameter !== undefined ||
    (expression.semantics.signature !== undefined &&
      (expression.semantics.signature.parameterCount !== parameters.length ||
        expression.semantics.signature.providedArgumentCount !== expression.arguments.length))
  ) {
    return false;
  }
  const constructorPlan = getRustSimpleClassConstructorPlan(
    declaration,
    declarationModule,
    modules,
    moduleResolution,
    new Set([`${moduleKey(declarationModule.module)}:${declaration.binding.id}`]),
  );
  if (!constructorPlan) return false;
  return parameters.every((parameter, position) => {
    const argument = expression.arguments[position];
    const optionalCarrier = constructorPlan.optionalClassParameters.get(position);
    if (optionalCarrier) {
      if (!hasRustReferenceOptionalParameterInvocationEvidence(expression, parameters, position)) return false;
      return (
        argument === undefined ||
        isRustReferenceClassCarrierExpressionCompatible(
          argument,
          optionalCarrier,
          callerModule,
          modules,
          moduleResolution,
          declarationModule,
        )
      );
    }
    if (!argument) return false;
    if (constructorPlan.borrowedPositions.has(position)) {
      return isRustReferenceExactBorrowedClassArgument(
        argument,
        callerModule,
        parameter.type,
        declarationModule,
        modules,
        moduleResolution,
      );
    }
    const argumentType = getRustSimpleClassPrimitiveExpressionType(argument, callerModule);
    return (
      argumentType !== undefined &&
      isRustSimpleClassPrimitiveType(parameter.type) &&
      argumentType.name === parameter.type.name
    );
  });
}

function getRustSimpleClassConstructorTarget(
  expression: Readonly<Extract<IrExpression, { kind: 'new' }>>,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): Readonly<{ declaration: Readonly<IrClassDeclaration>; module: RustReferenceModuleRecord }> | undefined {
  if (expression.callee.kind !== 'identifier' || expression.callee.reference.kind !== 'binding') return undefined;
  return getRustReferenceClassDeclaration(
    {
      kind: 'named',
      reference: { binding: expression.callee.reference.binding, kind: 'binding', path: [] },
      typeArguments: expression.typeArguments,
    },
    module,
    modules,
    moduleResolution,
  );
}

function isRustReferenceExactBorrowedClassArgument(
  expression: Readonly<IrExpression>,
  module: RustReferenceModuleRecord,
  parameterType: Readonly<IrType>,
  parameterModule: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): boolean {
  if (
    expression.kind === 'call' &&
    !isRustReferenceSharedClassReturnCall(expression, module, modules, moduleResolution)
  ) {
    return false;
  }
  if (expression.kind === 'new') {
    const argumentType = getRustReferenceClassIdentityExpressionType(expression, module);
    if (!isRustSimpleClassConstruction(expression, argumentType, module, modules, moduleResolution)) return false;
  }
  if (expression.kind !== 'identifier' && expression.kind !== 'call' && expression.kind !== 'new') return false;
  return isRustReferenceExactClassArgument(
    expression,
    module,
    parameterType,
    parameterModule,
    modules,
    moduleResolution,
  );
}

function getRustSimpleClassPrimitiveExpressionType(
  expression: Readonly<IrExpression>,
  module: RustReferenceModuleRecord,
): Readonly<Extract<IrType, { kind: 'primitive' }>> | undefined {
  if (expression.kind === 'literal') {
    if (typeof expression.value === 'boolean') return { kind: 'primitive', name: 'boolean' };
    if (typeof expression.value === 'number') return { kind: 'primitive', name: 'number' };
    if (typeof expression.value === 'string') return { kind: 'primitive', name: 'string' };
    return undefined;
  }
  if (expression.kind === 'identifier' && expression.reference.kind === 'binding') {
    const type = module.bindingTypes.get(expression.reference.binding.id);
    return type ? getRustSimpleClassPrimitiveValueType(type) : undefined;
  }
  if (expression.kind === 'cast') {
    return getRustSimpleClassPrimitiveValueType(expression.type);
  }
  if (expression.kind === 'call') {
    return getRustSimpleClassPrimitiveValueType(expression.semantics.resultType);
  }
  if (expression.kind === 'property') {
    return expression.type ? getRustSimpleClassPrimitiveValueType(expression.type) : undefined;
  }
  if (expression.kind === 'template') return { kind: 'primitive', name: 'string' };
  if (expression.kind === 'assignment' || expression.kind === 'binary' || expression.kind === 'unary') {
    const result = expression.semantics.result;
    return result === 'boolean' || result === 'number' || result === 'string'
      ? { kind: 'primitive', name: result }
      : undefined;
  }
  if (expression.kind === 'conditional') {
    const whenTrue = getRustSimpleClassPrimitiveExpressionType(expression.whenTrue, module);
    const whenFalse = getRustSimpleClassPrimitiveExpressionType(expression.whenFalse, module);
    return whenTrue?.name === whenFalse?.name ? whenTrue : undefined;
  }
  return undefined;
}

function getRustSimpleClassPrimitiveValueType(
  type: Readonly<IrType>,
): Readonly<Extract<IrType, { kind: 'primitive' }>> | undefined {
  if (isRustSimpleClassPrimitiveType(type)) return type;
  if (type.kind !== 'literal') return undefined;
  return typeof type.value === 'boolean'
    ? { kind: 'primitive', name: 'boolean' }
    : typeof type.value === 'number'
      ? { kind: 'primitive', name: 'number' }
      : { kind: 'primitive', name: 'string' };
}

function isRustSimpleClassPrimitiveType(
  type: Readonly<IrType>,
): type is Readonly<Extract<IrType, { kind: 'primitive' }>> {
  return type.kind === 'primitive' && (type.name === 'boolean' || type.name === 'number' || type.name === 'string');
}

function isRustSharedHashCollectionTypeSupported(
  type: Readonly<IrType> | undefined,
  kind: RustSharedHashCollectionKind,
): boolean {
  const arguments_ = getRustAmbientHashCollectionTypeArguments(type, kind);
  if (arguments_?.[0]?.kind !== 'primitive' || arguments_[0].name !== 'string') return false;
  return kind === 'set' || (arguments_[1] !== undefined && isRustSharedMapPrimitiveValueType(arguments_[1]));
}

function isRustSharedMapPrimitiveValueType(type: Readonly<IrType>): boolean {
  return type.kind === 'primitive' && (type.name === 'boolean' || type.name === 'number' || type.name === 'string');
}

function isZeroArgumentAmbientHashCollectionConstruction(
  expression: Readonly<IrExpression> | undefined,
  kind: RustSharedHashCollectionKind,
): boolean {
  return (
    expression?.kind === 'new' &&
    expression.callee.kind === 'identifier' &&
    expression.callee.reference.kind === 'ambient' &&
    expression.callee.reference.name === getRustReferenceHashCollectionName(kind) &&
    expression.arguments.length === 0
  );
}

function getRustSharedHashCollectionAnalysis(
  module: RustReferenceModuleRecord,
  kind: RustSharedHashCollectionKind,
): RustSharedHashCollectionAnalysis {
  return kind === 'map' ? module.sharedMaps : module.sharedSets;
}

function getRustReferenceHashCollectionName(kind: RustSharedHashCollectionKind): 'Map' | 'Set' {
  return kind === 'map' ? 'Map' : 'Set';
}

function getRustReferenceHashCollectionBorrowedRepresentation(
  kind: RustSharedHashCollectionKind,
): CompilerRustReferenceRepresentation {
  return kind === 'map' ? 'mutable-borrowed-hash-map' : 'mutable-borrowed-hash-set';
}

type RustSharedHashCollectionRefusalKind =
  | 'alias'
  | 'bindingReassignment'
  | 'borrowConflict'
  | 'call'
  | 'closureEscape'
  | 'mutatorResult'
  | 'suspension'
  | 'use';

function getRustReferenceHashCollectionRefusalCode(
  kind: RustSharedHashCollectionKind,
  refusal: RustSharedHashCollectionRefusalKind,
): CompilerRustReferenceRepresentationRefusal['code'] {
  const suffix = {
    alias: 'alias-ambiguous',
    bindingReassignment: 'binding-reassignment-unrepresented',
    borrowConflict: 'borrow-conflict',
    call: 'call-unrepresented',
    closureEscape: 'closure-escape-unrepresented',
    mutatorResult: 'mutator-result-unrepresented',
    suspension: 'suspension-unrepresented',
    use: 'use-unrepresented',
  } as const;
  return `rust-reference-shared-${kind}-${suffix[refusal]}`;
}

function getRustSharedHashCollectionMutatingMethods(kind: RustSharedHashCollectionKind): ReadonlySet<string> {
  return kind === 'map' ? RUST_SHARED_MAP_MUTATING_METHODS : RUST_SHARED_SET_MUTATING_METHODS;
}

function getRustSharedHashCollectionMethods(kind: RustSharedHashCollectionKind): ReadonlySet<string> {
  return kind === 'map' ? RUST_SHARED_MAP_METHODS : RUST_SHARED_SET_METHODS;
}

function moduleIdentity(module: Readonly<IrModule>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: normalizePathPortable(module.source) };
}

function moduleKey(module: Readonly<CompilerModuleIdentity>): string {
  return `${module.packageName}\0${normalizePathPortable(module.source)}\0${module.name}`;
}

function sameModuleIdentity(left: Readonly<CompilerModuleIdentity>, right: Readonly<CompilerModuleIdentity>): boolean {
  return moduleKey(left) === moduleKey(right);
}

function cloneAndFreezeRustReferenceRepresentationPlan(
  plan: CompilerRustReferenceRepresentationPlan,
): CompilerRustReferenceRepresentationPlan {
  const clone = structuredClone(plan);
  freezeRustReferenceRepresentationPlanValue(clone, new WeakSet());
  return clone;
}

function freezeRustReferenceRepresentationPlanValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeRustReferenceRepresentationPlanValue(child, seen);
  Object.freeze(value);
}

const RUST_SHARED_ARRAY_MUTATING_METHODS: ReadonlySet<string> = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

const RUST_SHARED_ARRAY_BORROW_CONFLICT_METHODS: ReadonlySet<string> = new Set([
  ...RUST_SHARED_ARRAY_MUTATING_METHODS,
  'concat',
  'every',
  'filter',
  'find',
  'findIndex',
  'flatMap',
  'forEach',
  'includes',
  'indexOf',
  'lastIndexOf',
  'map',
  'reduce',
  'slice',
  'some',
]);

const RUST_SHARED_ARRAY_METHODS: ReadonlySet<string> = new Set([
  ...RUST_SHARED_ARRAY_MUTATING_METHODS,
  'concat',
  'every',
  'filter',
  'find',
  'findIndex',
  'flatMap',
  'forEach',
  'includes',
  'indexOf',
  'join',
  'lastIndexOf',
  'map',
  'reduce',
  'slice',
  'some',
]);

const RUST_SHARED_MAP_MUTATING_METHODS: ReadonlySet<string> = new Set(['clear', 'delete', 'set']);

const RUST_SHARED_MAP_METHODS: ReadonlySet<string> = new Set([...RUST_SHARED_MAP_MUTATING_METHODS, 'get', 'has']);

const RUST_SHARED_SET_MUTATING_METHODS: ReadonlySet<string> = new Set(['add', 'clear', 'delete']);

const RUST_SHARED_SET_METHODS: ReadonlySet<string> = new Set([...RUST_SHARED_SET_MUTATING_METHODS, 'has']);

const RUST_SHARED_HASH_COLLECTION_KINDS: readonly RustSharedHashCollectionKind[] = ['map', 'set'];
