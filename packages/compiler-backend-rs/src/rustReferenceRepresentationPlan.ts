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
  IrType,
} from '../../compiler-types/src/index.js';
import {
  analyzeIrModuleOwnershipEvidenceRust,
  collectIrModuleReferentMutatedParameterIdsRust,
} from './rustOwnershipEvidence.js';

type IrCallExpression = Readonly<Extract<IrExpression, { kind: 'call' }>>;

interface RustReferenceCallRecord {
  readonly call: IrCallExpression;
  readonly enclosingFunction: RustReferenceFunctionRecord;
}

interface RustReferenceCallableDraft {
  readonly binding: IrBindingIdentity;
  readonly parameters: Map<number, CompilerRustReferenceRepresentation>;
}

interface RustReferenceFunctionRecord {
  readonly declaration: Readonly<IrFunctionDeclaration>;
  readonly mutatedParameterPositions: Set<number>;
}

interface RustReferenceImportRecord {
  readonly binding: Readonly<IrImportBinding>;
  readonly specifier: string;
}

interface RustReferenceModuleRecord {
  readonly bindingTypes: ReadonlyMap<string, Readonly<IrType>>;
  readonly calls: RustReferenceCallRecord[];
  readonly functions: RustReferenceFunctionRecord[];
  readonly functionsByBindingId: Map<string, RustReferenceFunctionRecord>;
  readonly importsByBindingId: ReadonlyMap<string, RustReferenceImportRecord>;
  readonly module: Readonly<IrModule>;
  readonly ownership: ReturnType<typeof analyzeIrModuleOwnershipEvidenceRust>;
  readonly sharedArrays: RustSharedArrayAnalysis;
  readonly sharedClasses: RustSharedClassAnalysis;
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
  readonly bindingIds: Set<string>;
  readonly groupByBindingId: ReadonlyMap<string, string>;
  readonly groupsByKey: ReadonlyMap<string, ReadonlySet<string>>;
  readonly variablesByBindingId: ReadonlyMap<string, RustSharedClassVariable>;
}

interface RustSharedClassVariable {
  readonly binding: Readonly<IrBindingIdentity>;
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
  const modules = createRustReferenceModuleRecords(input.modules);
  propagateRustReferenceArrayParameterMutation(modules, input.moduleResolution);
  propagateRustReferenceClassParameterMutation(modules, input.moduleResolution);
  propagateRustReferenceHashCollectionParameterMutation(modules, input.moduleResolution, 'map');
  propagateRustReferenceHashCollectionParameterMutation(modules, input.moduleResolution, 'set');
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

function createRustReferenceModuleRecords(
  modules: readonly Readonly<IrModule>[],
): readonly RustReferenceModuleRecord[] {
  const records: RustReferenceModuleRecord[] = [];
  for (const module of modules) {
    const ownership = analyzeIrModuleOwnershipEvidenceRust(module);
    const bindingTypes = new Map(ownership.bindings.map((binding) => [binding.binding.id, binding.type]));
    const mutatedParameters = collectIrModuleReferentMutatedParameterIdsRust(module);
    const sharedArrays = createRustSharedArrayAnalysis(module, ownership, bindingTypes);
    const sharedClasses = createRustSharedClassAnalysis(module, ownership, bindingTypes);
    const sharedMaps = createRustSharedHashCollectionAnalysis(module, ownership, bindingTypes, 'map');
    const sharedSets = createRustSharedHashCollectionAnalysis(module, ownership, bindingTypes, 'set');
    const record: RustReferenceModuleRecord = {
      bindingTypes,
      calls: [],
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
        for (const position of getRustReferenceClassMutationPositions(
          target.function,
          target.module,
          modules,
          moduleResolution,
        )) {
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
            !isRustSharedClassTypeSupported(callerParameter.type, module, modules, moduleResolution)
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

  addRustSharedArrayRefusals(module, modules, moduleResolution, refusals);
  addRustSharedClassRefusals(module, modules, moduleResolution, refusals);
  addRustSharedHashCollectionRefusals(module, modules, moduleResolution, refusals, 'map');
  addRustSharedHashCollectionRefusals(module, modules, moduleResolution, refusals, 'set');

  for (const evidence of module.ownership.bindings) {
    if (
      (evidence.type.kind === 'array' ||
        isRustSharedClassTypeSupported(evidence.type, module, modules, moduleResolution) ||
        isRustSharedHashCollectionTypeSupported(evidence.type, 'map') ||
        isRustSharedHashCollectionTypeSupported(evidence.type, 'set')) &&
      (evidence.mutation === 'referentMutated' || evidence.mutation === 'bindingAndReferent')
    ) {
      mutatedBindings.set(evidence.binding.id, evidence.binding);
    }
  }

  for (const function_ of module.functions) {
    addRustReferenceCallablePlan(
      callables,
      function_.declaration.binding,
      getRustReferenceArrayMutationPositions(function_),
      'mutable-borrowed-vec',
    );
    addRustReferenceCallablePlan(
      callables,
      function_.declaration.binding,
      getRustReferenceClassMutationPositions(function_, module, modules, moduleResolution),
      'mutable-borrowed-class',
    );
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
        !isRustSharedClassTypeSupported(type, target.module, modules, moduleResolution) &&
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
        ({ binding, parameters }): CompilerRustReferenceCallablePlan => ({
          binding,
          parameters: [...parameters]
            .sort(([left], [right]) => left - right)
            .map(([position, representation]) => ({ position, representation })),
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
    sharedClassBindings: [...module.sharedClasses.bindingIds]
      .map((id) => ({
        binding: module.ownership.bindings.find((evidence) => evidence.binding.id === id)!.binding,
        representation: 'shared-ref-cell-class' as const,
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
  const positions = getRustReferenceClassMutationPositions(target, targetModule, modules, moduleResolution);
  const callableBinding =
    call.callee.kind === 'identifier' && call.callee.reference.kind === 'binding'
      ? call.callee.reference.binding
      : target.declaration.binding;
  addRustReferenceCallablePlan(callables, callableBinding, positions, 'mutable-borrowed-class');
  for (const position of positions) {
    const argument = call.arguments[position];
    if (
      argument?.kind === 'identifier' &&
      argument.reference.kind === 'binding' &&
      isRustSharedClassTypeSupported(
        module.bindingTypes.get(argument.reference.binding.id),
        module,
        modules,
        moduleResolution,
      )
    ) {
      mutatedBindings.set(argument.reference.binding.id, argument.reference.binding);
      addRustSharedClassCallBorrowConflictRefusal(module, call, position, refusals);
      continue;
    }
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-call-unrepresented',
      `${moduleKey(module.module)}:${callableBinding.id}:${String(position)}`,
      `argument ${String(position)} to ${target.declaration.binding.name} lacks an exact represented simple-class binding`,
    );
  }
  for (const position of getRustReferenceAnyClassMutationPositions(target, targetModule)) {
    if (positions.has(position)) continue;
    const argument = call.arguments[position];
    if (!argument || !isRustReferenceClassExpression(argument, module)) continue;
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-call-unrepresented',
      `${moduleKey(module.module)}:${callableBinding.id}:${String(position)}`,
      `argument ${String(position)} to ${target.declaration.binding.name} uses a class outside the exact represented simple-class plan`,
    );
  }
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
      if (
        !('binding' in variable) ||
        bindingTypes.get(variable.binding.id)?.kind !== 'array' ||
        variable.initializer?.kind !== 'identifier' ||
        variable.initializer.reference.kind !== 'binding' ||
        bindingTypes.get(variable.initializer.reference.binding.id)?.kind !== 'array'
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
): RustSharedClassAnalysis {
  const parents = new Map<string, string>();
  const aliasEdges: Array<readonly [string, string]> = [];
  const ambiguousBindingIds = new Set<string>();
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
      if (!isRustClassLikeType(type, module)) return;
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
            isRustClassLikeType(bindingTypes.get(alternative.reference.binding.id), module)
              ? [alternative.reference.binding.id]
              : [],
          ),
        );
        if (alternatives.size > 1) ambiguousBindingIds.add(variable.binding.id);
      }
      if (
        variable.initializer?.kind !== 'identifier' ||
        variable.initializer.reference.kind !== 'binding' ||
        !isRustClassLikeType(bindingTypes.get(variable.initializer.reference.binding.id), module)
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
  return { ambiguousBindingIds, bindingIds, groupByBindingId, groupsByKey, variablesByBindingId };
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
        for (const argument of call.arguments) activateRustSharedClassGroupsUsedInExpression(module, argument);
        continue;
      }
      for (const position of getRustReferenceClassMutationPositions(
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
          module.sharedClasses.bindingIds.add(id);
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
      if (!method?.mutating) continue;
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
      const groupKey = module.sharedClasses.groupByBindingId.get(candidate.reference.binding.id);
      if (groupKey) groupKeys.add(groupKey);
      return undefined;
    },
  });
  for (const groupKey of groupKeys) {
    for (const id of module.sharedClasses.groupsByKey.get(groupKey) ?? []) {
      module.sharedClasses.bindingIds.add(id);
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
    !RUST_SHARED_ARRAY_MUTATING_METHODS.has(call.callee.member.name) ||
    call.callee.object.kind !== 'identifier' ||
    call.callee.object.reference.kind !== 'binding'
  ) {
    return;
  }
  const receiverId = call.callee.object.reference.binding.id;
  const group = module.sharedArrays.groupByBindingId.get(receiverId);
  if (!group || !call.arguments.some((argument) => expressionUsesRustSharedArrayGroup(argument, group, module))) {
    return;
  }
  addRustReferenceRefusal(
    refusals,
    'rust-reference-shared-array-borrow-conflict',
    `${moduleKey(module.module)}:${receiverId}:${JSON.stringify(path_)}`,
    `shared array mutation ${call.callee.member.name} reads the same alias group while its mutable borrow is active`,
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
  analyzeIrExpressionSubtreeTraversal(expression, {
    expression(candidate) {
      if (
        candidate.kind === 'identifier' &&
        candidate.reference.kind === 'binding' &&
        module.sharedArrays.groupByBindingId.get(candidate.reference.binding.id) === group
      ) {
        found = true;
        return false;
      }
      return undefined;
    },
  });
  return found;
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
    if (
      !evidence ||
      (!mutatedByCall && evidence.mutation !== 'referentMutated' && evidence.mutation !== 'bindingAndReferent')
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
  if (module.sharedClasses.bindingIds.size === 0) return;

  for (const group of module.sharedClasses.groupsByKey.values()) {
    if (![...group].some((id) => module.sharedClasses.bindingIds.has(id))) continue;
    const roots = [...group].filter((id) => {
      const variable = module.sharedClasses.variablesByBindingId.get(id);
      return isRustSimpleClassConstruction(variable?.initializer, variable?.type, module, modules, moduleResolution);
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
      const initializer = variable?.initializer;
      const aliasInitializer =
        initializer?.kind === 'identifier' &&
        initializer.reference.kind === 'binding' &&
        group.has(initializer.reference.binding.id);
      if (!variable || variable.mutable || (!aliasInitializer && initializer?.kind !== 'new')) {
        addRustReferenceRefusal(
          refusals,
          'rust-reference-shared-class-use-unrepresented',
          `${moduleKey(module.module)}:${id}`,
          `shared class binding ${variable?.binding.name ?? id} is not an initialized local const in the alias group`,
        );
      }
      const location = getRustReferenceClassDeclaration(variable?.type, module, modules, moduleResolution);
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
    if (!module.sharedClasses.bindingIds.has(evidence.binding.id)) continue;
    const subject = `${moduleKey(module.module)}:${evidence.binding.id}`;
    const location = getRustReferenceClassDeclaration(evidence.type, module, modules, moduleResolution);
    if (!location || evidence.type.kind !== 'named' || evidence.type.typeArguments.length > 0) {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-type-unrepresented',
        subject,
        `shared class binding ${evidence.binding.name} must retain one exact non-generic named class type`,
      );
    } else {
      addRustSimpleClassDeclarationRefusals(location.declaration, subject, refusals);
    }
    if (evidence.binding.scope === 'module' || evidence.declaration !== 'immutable') {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-use-unrepresented',
        subject,
        `shared class binding ${evidence.binding.name} is outside the supported local const carrier`,
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
    if (evidence.boundaries.includes('suspension')) {
      addRustReferenceRefusal(
        refusals,
        'rust-reference-shared-class-suspension-unrepresented',
        subject,
        `shared class binding ${evidence.binding.name} crosses a suspension boundary`,
      );
    }
  }

  for (const closure of analyzeIrModuleClosureEvidence(module.module).closures) {
    const captures = closure.captures.filter((capture) => module.sharedClasses.bindingIds.has(capture.binding.id));
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
        if (!module.sharedClasses.bindingIds.has(expression.reference.binding.id)) return;
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
        addRustSharedClassMutatorResultRefusal(module, expression, path_, refusals);
        return;
      }
      if (expression.kind === 'call') {
        addRustSharedClassMethodBorrowConflictRefusal(module, modules, moduleResolution, expression, path_, refusals);
      }
    },
  });
}

function addRustSimpleClassDeclarationRefusals(
  declaration: Readonly<IrClassDeclaration>,
  subject: string,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
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
  if (declaration.methods.some((method) => !isRustSimpleClassMethodSupported(method, declaration))) {
    addRustReferenceRefusal(
      refusals,
      'rust-reference-shared-class-member-unrepresented',
      subject,
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
  if (!isRustSimpleClassConstructionSupported(declaration)) {
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
    return (
      isCallExpression(call) &&
      call.callee === parent &&
      getRustSimpleClassMethodCall(call, module, modules, moduleResolution) !== undefined
    );
  }
  if (path_.at(-2) === 'arguments' && typeof path_.at(-1) === 'number') {
    const call = getIrModuleTraversalPathValue(module.module, path_.slice(0, -2));
    if (!isCallExpression(call) || call.optional) return false;
    const position = path_.at(-1) as number;
    const target = resolveRustReferenceCallTarget(call, module, modules, moduleResolution);
    return (
      target.kind === 'function' &&
      getRustReferenceClassMutationPositions(target.function, target.module, modules, moduleResolution).has(position)
    );
  }
  return false;
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
  if (!group || !expressionUsesRustSharedClassGroup(assignment.right, group, module)) return;
  addRustReferenceRefusal(
    refusals,
    'rust-reference-shared-class-borrow-conflict',
    `${moduleKey(module.module)}:${receiverId}:${JSON.stringify(path_)}`,
    'shared class field mutation reads the same alias group while its mutable borrow is active',
  );
}

function addRustSharedClassMutatorResultRefusal(
  module: RustReferenceModuleRecord,
  assignment: Readonly<Extract<IrExpression, { kind: 'assignment' }>>,
  path_: CompilerIrTraversalPath,
  refusals: Map<string, CompilerRustReferenceRepresentationRefusal>,
): void {
  if (
    assignment.left.kind !== 'property' ||
    assignment.left.object.kind !== 'identifier' ||
    assignment.left.object.reference.kind !== 'binding' ||
    !module.sharedClasses.bindingIds.has(assignment.left.object.reference.binding.id)
  ) {
    return;
  }
  const receiverId = assignment.left.object.reference.binding.id;
  if (assignment.operator !== '=') {
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
  const receiver = method?.receiver;
  if (
    !receiver ||
    receiver.reference.kind !== 'binding' ||
    !module.sharedClasses.bindingIds.has(receiver.reference.binding.id)
  ) {
    return;
  }
  const group = module.sharedClasses.groupByBindingId.get(receiver.reference.binding.id);
  if (!group || !call.arguments.some((argument) => expressionUsesRustSharedClassGroup(argument, group, module))) {
    return;
  }
  addRustReferenceRefusal(
    refusals,
    'rust-reference-shared-class-borrow-conflict',
    `${moduleKey(module.module)}:${receiver.reference.binding.id}:${JSON.stringify(path_)}`,
    `class method ${method.method.name} borrows a shared receiver while an argument reads the same alias group`,
  );
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

function getRustReferenceAnyClassMutationPositions(
  function_: RustReferenceFunctionRecord,
  module: RustReferenceModuleRecord,
): ReadonlySet<number> {
  return new Set(
    [...function_.mutatedParameterPositions].filter((position) =>
      isRustClassLikeType(function_.declaration.parameters[position]?.type, module.module),
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
  if (
    expression.kind === 'new' &&
    expression.callee.kind === 'identifier' &&
    expression.callee.reference.kind === 'binding'
  ) {
    return true;
  }
  if (expression.kind === 'cast') return isRustClassLikeType(expression.type, module.module);
  return (
    expression.kind === 'identifier' &&
    expression.reference.kind === 'binding' &&
    isRustClassLikeType(module.bindingTypes.get(expression.reference.binding.id), module.module)
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
  if (module.declarations.some((candidate) => candidate.kind === 'class' && candidate.binding.id === bindingId)) {
    return true;
  }
  if (module.imports.some((item) => item.bindings.some((binding) => binding.binding.id === bindingId))) return true;
  const declaration = module.declarations.find(
    (candidate) => candidate.kind === 'typeAlias' && candidate.binding.id === bindingId,
  );
  return declaration?.kind === 'typeAlias'
    ? isRustClassLikeType(declaration.type, module, new Set(resolving).add(bindingId))
    : false;
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

function getRustReferenceClassField(
  expression: Readonly<Extract<IrExpression, { kind: 'identifier' }>>,
  name: string,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): Readonly<IrClassField> | undefined {
  if (expression.reference.kind !== 'binding') return undefined;
  const location = getRustReferenceClassDeclaration(
    module.bindingTypes.get(expression.reference.binding.id),
    module,
    modules,
    moduleResolution,
  );
  return location?.declaration.fields.find((field) => !field.static && field.name === name);
}

function getRustSimpleClassMethod(
  expression: Readonly<Extract<IrExpression, { kind: 'identifier' }>>,
  name: string,
  module: RustReferenceModuleRecord,
  modules: readonly RustReferenceModuleRecord[],
  moduleResolution: CompilerRustReferenceRepresentationPlanInput['moduleResolution'],
): Readonly<{ declaration: Readonly<IrClassDeclaration>; method: Readonly<IrClassMethod> }> | undefined {
  if (expression.reference.kind !== 'binding') return undefined;
  const location = getRustReferenceClassDeclaration(
    module.bindingTypes.get(expression.reference.binding.id),
    module,
    modules,
    moduleResolution,
  );
  if (!location || !isRustSimpleClassDeclarationSupported(location.declaration)) return undefined;
  const methods = location.declaration.methods.filter((method) => !method.static && method.name === name);
  const method = methods.length === 1 ? methods[0] : undefined;
  return method ? { declaration: location.declaration, method } : undefined;
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
      mutating: boolean;
      receiver: Readonly<Extract<IrExpression, { kind: 'identifier' }>>;
    }>
  | undefined {
  if (
    !isRustSimpleClassDirectMethodInvocation(call) ||
    call.callee.kind !== 'property' ||
    call.callee.optional ||
    call.callee.structuralAccess ||
    call.callee.object.kind !== 'identifier'
  ) {
    return undefined;
  }
  const receiver = call.callee.object;
  const location = getRustSimpleClassMethod(receiver, call.callee.name, module, modules, moduleResolution);
  if (!location || call.arguments.length !== location.method.parameters.length) {
    return undefined;
  }
  return {
    ...location,
    mutating: getRustSimpleClassMutatingMethodNames(location.declaration).has(location.method.name),
    receiver,
  };
}

function isRustSimpleClassDirectMethodInvocation(call: IrCallExpression): boolean {
  return (
    !call.optional &&
    call.typeArguments.length === 0 &&
    call.semantics.defaultParameters === undefined &&
    call.semantics.optionalParameters === undefined &&
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
): boolean {
  if (type?.kind !== 'named' || type.typeArguments.length > 0) return false;
  const location = getRustReferenceClassDeclaration(type, module, modules, moduleResolution);
  return location !== undefined && isRustSimpleClassDeclarationSupported(location.declaration);
}

function isRustSimpleClassDeclarationSupported(declaration: Readonly<IrClassDeclaration>): boolean {
  return (
    !declaration.abstract &&
    declaration.extends === undefined &&
    declaration.implements.length === 0 &&
    declaration.typeParameters.length === 0 &&
    declaration.methods.every((method) => isRustSimpleClassMethodSupported(method, declaration)) &&
    declaration.fields.length > 0 &&
    declaration.fields.every(isRustSimpleClassField) &&
    isRustSimpleClassConstructionSupported(declaration)
  );
}

function isRustSimpleClassMethodSupported(
  method: Readonly<IrClassMethod>,
  declaration: Readonly<IrClassDeclaration>,
): boolean {
  if (
    method.abstract ||
    method.accessor !== undefined ||
    method.async ||
    method.branded ||
    method.overloads.length > 0 ||
    method.static ||
    method.typeParameters.length > 0 ||
    method.parameters.some(
      (parameter) =>
        parameter.initializer !== undefined ||
        parameter.optional ||
        parameter.rest ||
        !isRustSimpleClassPrimitiveType(parameter.type),
    ) ||
    !isRustSimpleClassMethodResultType(method.returns)
  ) {
    return false;
  }
  return isRustSimpleClassMethodBodySupported(method, declaration);
}

function isRustSimpleClassMethodResultType(type: Readonly<IrType>): boolean {
  return (
    type.kind === 'primitive' &&
    (type.name === 'boolean' || type.name === 'number' || type.name === 'string' || type.name === 'void')
  );
}

function isRustSimpleClassMethodBodySupported(
  method: Readonly<IrClassMethod>,
  declaration: Readonly<IrClassDeclaration>,
): boolean {
  const fieldNames = new Set(declaration.fields.filter((field) => !field.static).map((field) => field.name));
  const methodNames = new Set(
    declaration.methods.filter((candidate) => !candidate.static).map((candidate) => candidate.name),
  );
  const allowedThisReferences = new WeakSet<object>();
  const thisReferences: object[] = [];
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
          return false;
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
        if (expression.kind === 'identifier' && expression.reference.kind === 'this') {
          thisReferences.push(expression);
        }
        return undefined;
      },
    });
  }
  return supported && thisReferences.every((reference) => allowedThisReferences.has(reference));
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

function isRustSimpleClassConstructionSupported(declaration: Readonly<IrClassDeclaration>): boolean {
  const fields = declaration.fields.filter((field) => !field.static);
  if (fields.length === 0) return false;
  const constructor = declaration.classConstructor;
  if (!constructor || (constructor.parameters.length === 0 && constructor.body.length === 0)) {
    return fields.every(
      (field) => field.initializer !== undefined && !hasIrExpressionThisReferenceInPlan(field.initializer),
    );
  }
  if (constructor.overloads.length > 0 || fields.some((field) => field.initializer !== undefined)) {
    return false;
  }
  const parameters = constructor.parameters;
  if (
    parameters.some(
      (parameter) =>
        parameter.optional ||
        parameter.rest ||
        parameter.initializer !== undefined ||
        !isRustSimpleClassPrimitiveType(parameter.type),
    )
  ) {
    return false;
  }
  const assigned = new Set<string>();
  const usedParameters = new Set<string>();
  for (const statement of constructor.body) {
    if (statement.kind !== 'expression' || statement.expression.kind !== 'assignment') return false;
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
      return false;
    }
    const fieldName = assignment.left.name;
    const field = fields.find((candidate) => candidate.name === fieldName);
    if (!field) return false;
    if (parameters.length > 0) {
      if (assignment.right.kind !== 'identifier' || assignment.right.reference.kind !== 'binding') return false;
      const parameterBindingId = assignment.right.reference.binding.id;
      const parameter = parameters.find((candidate) => candidate.binding.id === parameterBindingId);
      if (
        !parameter ||
        usedParameters.has(parameter.binding.id) ||
        !isRustSimpleClassPrimitiveType(field.type) ||
        !isRustSimpleClassPrimitiveType(parameter.type) ||
        field.type.name !== parameter.type.name
      ) {
        return false;
      }
      usedParameters.add(parameter.binding.id);
    }
    assigned.add(fieldName);
  }
  return (
    fields.length === assigned.size &&
    fields.every((field) => assigned.has(field.name)) &&
    (parameters.length === 0 ||
      (parameters.length === usedParameters.size &&
        parameters.every((parameter) => usedParameters.has(parameter.binding.id))))
  );
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
    isRustSimpleClassDeclarationSupported(typeLocation.declaration) &&
    isRustSimpleClassConstructorInvocationSupported(expression, typeLocation.declaration, module)
  );
}

function isRustSimpleClassConstructorInvocationSupported(
  expression: Readonly<Extract<IrExpression, { kind: 'new' }>>,
  declaration: Readonly<IrClassDeclaration>,
  module: RustReferenceModuleRecord,
): boolean {
  const parameters = declaration.classConstructor?.parameters ?? [];
  // Rust evaluates fixed call operands once from left to right. Keeping exact primitive arguments as
  // constructor operands therefore preserves source order; every dynamic/default/rest shape is refused here.
  if (
    expression.arguments.length !== parameters.length ||
    expression.semantics.construction === 'factory' ||
    expression.semantics.defaultParameters !== undefined ||
    expression.semantics.optionalParameters !== undefined ||
    expression.semantics.overloadImplementation !== undefined ||
    expression.semantics.signature?.providedArgumentCount === 'dynamic' ||
    expression.semantics.signature?.restParameter !== undefined ||
    (expression.semantics.signature !== undefined &&
      (expression.semantics.signature.parameterCount !== parameters.length ||
        expression.semantics.signature.providedArgumentCount !== expression.arguments.length))
  ) {
    return false;
  }
  return parameters.every((parameter, position) => {
    const argument = expression.arguments[position];
    const argumentType = argument ? getRustSimpleClassPrimitiveExpressionType(argument, module) : undefined;
    return (
      argumentType !== undefined &&
      isRustSimpleClassPrimitiveType(parameter.type) &&
      argumentType.name === parameter.type.name
    );
  });
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

const RUST_SHARED_ARRAY_MUTATING_METHODS: ReadonlySet<string> = new Set(['pop', 'push', 'reverse', 'shift', 'unshift']);

const RUST_SHARED_ARRAY_METHODS: ReadonlySet<string> = new Set([
  ...RUST_SHARED_ARRAY_MUTATING_METHODS,
  'includes',
  'indexOf',
  'join',
  'lastIndexOf',
  'slice',
]);

const RUST_SHARED_MAP_MUTATING_METHODS: ReadonlySet<string> = new Set(['clear', 'delete', 'set']);

const RUST_SHARED_MAP_METHODS: ReadonlySet<string> = new Set([...RUST_SHARED_MAP_MUTATING_METHODS, 'get', 'has']);

const RUST_SHARED_SET_MUTATING_METHODS: ReadonlySet<string> = new Set(['add', 'clear', 'delete']);

const RUST_SHARED_SET_METHODS: ReadonlySet<string> = new Set([...RUST_SHARED_SET_MUTATING_METHODS, 'has']);

const RUST_SHARED_HASH_COLLECTION_KINDS: readonly RustSharedHashCollectionKind[] = ['map', 'set'];
