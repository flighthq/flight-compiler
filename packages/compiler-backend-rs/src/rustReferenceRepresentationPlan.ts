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

interface RustSharedHashCollectionVariable {
  readonly binding: Readonly<IrBindingIdentity>;
  readonly initializer: Readonly<IrExpression> | undefined;
  readonly mutable: boolean;
  readonly type: Readonly<IrType> | undefined;
}

type RustSharedHashCollectionKind = 'map' | 'set';

type RustReferenceCallTarget =
  | Readonly<{ kind: 'ambiguous'; imported: RustReferenceImportRecord }>
  | Readonly<{ function: RustReferenceFunctionRecord; kind: 'function'; imported?: RustReferenceImportRecord }>
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
  propagateRustReferenceHashCollectionParameterMutation(modules, input.moduleResolution, 'map');
  propagateRustReferenceHashCollectionParameterMutation(modules, input.moduleResolution, 'set');
  activateRustSharedHashCollectionUnsupportedUses(modules, input.moduleResolution, 'map');
  activateRustSharedHashCollectionUnsupportedUses(modules, input.moduleResolution, 'set');
  activateRustSharedArrayCallMutations(modules, input.moduleResolution);
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
  addRustSharedHashCollectionRefusals(module, modules, moduleResolution, refusals, 'map');
  addRustSharedHashCollectionRefusals(module, modules, moduleResolution, refusals, 'set');

  for (const evidence of module.ownership.bindings) {
    if (
      (evidence.type.kind === 'array' ||
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
      const hashCollectionKinds = RUST_SHARED_HASH_COLLECTION_KINDS.filter((kind) =>
        call.arguments.some((argument) => isRustReferenceHashCollectionExpression(argument, module.bindingTypes, kind)),
      );
      if (!hasArray && hashCollectionKinds.length === 0) continue;
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
  if (local) return { function: local, kind: 'function' };
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
  return { function: functions[0]!, imported, kind: 'function' };
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
