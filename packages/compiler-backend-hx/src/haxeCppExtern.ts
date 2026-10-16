import {
  compareTextCodeUnits,
  normalizeCompilerStructuralValueCanonical,
} from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerHaxeCppExternCarrier,
  CompilerHaxeCppExternDeclarationPlan,
  CompilerHaxeCppExternEmission,
  CompilerHaxeCppExternFunctionPlan,
  CompilerHaxeCppExternPlan,
  CompilerHaxeCppExternPlanInput,
  CompilerHaxeCppExternRefusal,
  CompilerHaxeCppExternTypePlan,
  CompilerHaxeDualBinding,
  EmittedFile,
  IrBindingIdentity,
  IrBindingPattern,
  IrDeclaration,
  IrFunctionDeclaration,
  IrModule,
  IrType,
  IrTypeBindingIdentity,
} from '../../compiler-types/src/index.js';

interface HaxeCppExternDeclarationRecord {
  readonly binding: Readonly<CompilerHaxeDualBinding>;
  readonly declaration: Readonly<IrDeclaration>;
}

interface HaxeCppExternTypeIndexEntry {
  readonly bindingId: string;
  readonly plan: Readonly<CompilerHaxeCppExternTypePlan>;
}

interface HaxeCppExternPlanningFailure {
  readonly code: CompilerHaxeCppExternRefusal['code'];
  readonly message: string;
}

export function createCompilerHaxeCppExternPlan(
  input: Readonly<CompilerHaxeCppExternPlanInput>,
): CompilerHaxeCppExternPlan {
  if (input.bindings.schema !== 'flight-haxe-dual-binding-plan/1') {
    throw new TypeError('Haxe C++ extern planning requires flight-haxe-dual-binding-plan/1');
  }
  const declarationsByIdentity = indexHaxeCppExternDeclarations(input.modules);
  const records: HaxeCppExternDeclarationRecord[] = [];
  const refusals: CompilerHaxeCppExternRefusal[] = [];
  for (const binding of input.bindings.bindings) {
    if (binding.cpp.availability === 'refused') {
      refusals.push(
        createHaxeCppExternRefusal(
          binding.key,
          'cpp-binding-unavailable',
          binding.cpp.refusal.message,
          'planning',
          binding.cpp.refusal.code,
        ),
      );
      continue;
    }
    const locatorFailure = validateHaxeCppExternLocator(binding.cpp.locator);
    if (locatorFailure) {
      refusals.push(createHaxeCppExternRefusal(binding.key, locatorFailure.code, locatorFailure.message, 'planning'));
      continue;
    }
    const declaration = declarationsByIdentity.get(binding.identity.declarationIdentity);
    if (!declaration) {
      refusals.push(
        createHaxeCppExternRefusal(
          binding.key,
          'declaration-missing',
          `Haxe C++ extern declaration is absent for ${binding.publicHaxe.qualifiedName}`,
          'planning',
        ),
      );
      continue;
    }
    records.push({ binding, declaration });
  }

  const typeEntries: HaxeCppExternTypeIndexEntry[] = [];
  const declarations: CompilerHaxeCppExternDeclarationPlan[] = [];
  for (const record of records) {
    if (record.binding.identity.space !== 'type') continue;
    const result = createHaxeCppExternTypePlan(record);
    if ('code' in result) {
      refusals.push(createHaxeCppExternRefusal(record.binding.key, result.code, result.message, 'planning'));
      continue;
    }
    declarations.push(result);
    typeEntries.push({ bindingId: getHaxeCppExternDeclarationBinding(record.declaration).id, plan: result });
  }
  const typesByBinding = groupHaxeCppExternTypesByBinding(typeEntries);

  for (const record of records) {
    if (record.binding.identity.space !== 'value') continue;
    if (record.declaration.kind !== 'function') {
      refusals.push(
        createHaxeCppExternRefusal(
          record.binding.key,
          'unsupported-declaration',
          `Haxe C++ extern vertical slice does not emit ${record.declaration.kind} value bindings`,
          'planning',
        ),
      );
      continue;
    }
    const result = createHaxeCppExternFunctionPlan({ ...record, declaration: record.declaration }, typesByBinding);
    if ('code' in result) {
      refusals.push(createHaxeCppExternRefusal(record.binding.key, result.code, result.message, 'planning'));
      continue;
    }
    declarations.push(result);
  }

  return cloneAndFreezeHaxeCppExternPlan({
    declarations: declarations.sort(compareHaxeCppExternDeclarations),
    refusals: refusals.sort(compareHaxeCppExternRefusals),
    schema: 'flight-haxe-cpp-extern-plan/1',
  });
}

export function emitCompilerHaxeCppExternPlan(
  sourcePlan: Readonly<CompilerHaxeCppExternPlan>,
): CompilerHaxeCppExternEmission {
  if (!isHaxeCppExternPlanShape(sourcePlan)) {
    return cloneAndFreezeHaxeCppExternEmission({
      files: [],
      refusals: [
        createHaxeCppExternRefusal(
          '<plan>',
          'invalid-plan',
          'Haxe C++ extern emission requires flight-haxe-cpp-extern-plan/1',
          'emission',
        ),
      ],
      schema: 'flight-haxe-cpp-extern-emission/1',
    });
  }

  const files = new Map<string, EmittedFile>();
  const collisions = new Set<string>();
  const refusals = sourcePlan.refusals.map((refusal) => ({ ...refusal }));
  const addFile = (file: EmittedFile, key: string) => {
    if (collisions.has(file.path)) return;
    if (files.has(file.path)) {
      files.delete(file.path);
      collisions.add(file.path);
      refusals.push(
        createHaxeCppExternRefusal(
          key,
          'output-path-collision',
          `Haxe C++ extern output path is not unique: ${file.path}`,
          'emission',
        ),
      );
      return;
    }
    files.set(file.path, file);
  };

  for (const declaration of sourcePlan.declarations.filter(
    (candidate): candidate is CompilerHaxeCppExternTypePlan => candidate.kind === 'type',
  )) {
    addFile(emitHaxeCppExternType(declaration), declaration.key);
  }

  const functionGroups = new Map<string, CompilerHaxeCppExternFunctionPlan[]>();
  for (const declaration of sourcePlan.declarations.filter(
    (candidate): candidate is CompilerHaxeCppExternFunctionPlan => candidate.kind === 'function',
  )) {
    functionGroups.set(declaration.haxeOwner, [...(functionGroups.get(declaration.haxeOwner) ?? []), declaration]);
    if (declaration.adapter) addFile(emitHaxeCppExternAdapter(declaration), declaration.key);
  }
  for (const [owner, functions] of [...functionGroups].sort(([left], [right]) => compareTextCodeUnits(left, right))) {
    addFile(emitHaxeCppExternFunctionHolder(owner, functions), functions[0]!.key);
  }

  return cloneAndFreezeHaxeCppExternEmission({
    files: [...files.values()].sort((left, right) => compareTextCodeUnits(left.path, right.path)),
    refusals: refusals.sort(compareHaxeCppExternRefusals),
    schema: 'flight-haxe-cpp-extern-emission/1',
  });
}

function createHaxeCppExternTypePlan(
  record: Readonly<HaxeCppExternDeclarationRecord>,
): CompilerHaxeCppExternTypePlan | HaxeCppExternPlanningFailure {
  if (record.binding.cpp.availability !== 'available') return unsupportedHaxeCppExternCarrier('unavailable C++ type');
  const locator = record.binding.cpp.locator;
  if (record.declaration.kind !== 'enum' && record.declaration.kind !== 'interface') {
    return unsupportedHaxeCppExternCarrier(
      `Haxe C++ extern vertical slice does not represent ${record.declaration.kind} type carriers`,
      'unsupported-declaration',
    );
  }
  if (record.declaration.kind === 'interface' && record.declaration.typeParameters.length > 0) {
    return unsupportedHaxeCppExternCarrier('generic reference records are outside the Haxe C++ extern vertical slice');
  }
  const targetNativeName = getHaxeCppExternQualifiedName(locator.namespace, locator.spelling);
  const ownership = record.declaration.kind === 'enum' ? 'value' : 'reference';
  return {
    haxeName: record.binding.publicHaxe.name,
    haxePackage: getHaxeCppExternHiddenOwner(record.binding.publicHaxe.owner),
    include: locator.include,
    key: record.binding.key,
    kind: 'type',
    nativeName: ownership === 'value' ? targetNativeName : `flight::Ref<${targetNativeName}>`,
    ownership,
  };
}

function createHaxeCppExternFunctionPlan(
  record: Readonly<HaxeCppExternDeclarationRecord & { readonly declaration: IrFunctionDeclaration }>,
  typesByBinding: ReadonlyMap<string, readonly Readonly<CompilerHaxeCppExternTypePlan>[]>,
): CompilerHaxeCppExternFunctionPlan | HaxeCppExternPlanningFailure {
  const { declaration } = record;
  if (record.binding.cpp.availability !== 'available') {
    return unsupportedHaxeCppExternCarrier('unavailable C++ function');
  }
  if (declaration.async) return unsupportedHaxeCppExternCarrier('async functions require the later Task carrier');
  if (declaration.overloads.length > 0)
    return unsupportedHaxeCppExternCarrier('overloaded functions are not supported');
  if (declaration.typeParameters.length > 0)
    return unsupportedHaxeCppExternCarrier('generic functions are not supported');

  const parameters = [];
  for (const [position, parameter] of declaration.parameters.entries()) {
    if (parameter.rest) return unsupportedHaxeCppExternCarrier('rest parameters require the later Array carrier');
    if (parameter.initializer) {
      return unsupportedHaxeCppExternCarrier('defaulted parameters need an exact C++ default-argument contract');
    }
    const carrier = createHaxeCppExternCarrier(parameter.type, parameter.optional, false, typesByBinding);
    if ('code' in carrier) return carrier;
    parameters.push({
      carrier,
      haxeName: getSafeHaxeCppExternName(parameter.binding.name),
      optional: parameter.optional,
      position,
    });
  }
  const result = createHaxeCppExternCarrier(declaration.returns, false, true, typesByBinding);
  if ('code' in result) return result;
  const adapterSemantics = new Set<'copy-optional-presence' | 'copy-string-utf8'>();
  for (const carrier of [...parameters.map((parameter) => parameter.carrier), result]) {
    if (carrier.kind === 'string') adapterSemantics.add('copy-string-utf8');
    if (carrier.kind === 'optional-float') adapterSemantics.add('copy-optional-presence');
  }
  const hash = getHaxeCppExternStableHash(record.binding.key);
  const adapterName = `${getSafeHaxeCppExternName(record.binding.publicHaxe.name)}_${hash}`;
  const adapter =
    adapterSemantics.size === 0
      ? undefined
      : {
          headerPath: `flight/_cpp/adapters/${adapterName}.hpp`,
          nativeName: `flight::haxe::_cpp::${adapterName}`,
          semantics: [...adapterSemantics].sort(compareTextCodeUnits),
        };
  const locator = record.binding.cpp.locator;
  return {
    ...(adapter ? { adapter } : {}),
    haxeName: record.binding.publicHaxe.name,
    haxeOwner: getHaxeCppExternHiddenFunctionOwner(record.binding.publicHaxe.owner),
    include: locator.include,
    key: record.binding.key,
    kind: 'function',
    parameters,
    result,
    targetNativeName: getHaxeCppExternQualifiedName(locator.namespace, locator.spelling),
  };
}

function createHaxeCppExternCarrier(
  sourceType: Readonly<IrType>,
  optional: boolean,
  result: boolean,
  typesByBinding: ReadonlyMap<string, readonly Readonly<CompilerHaxeCppExternTypePlan>[]>,
): CompilerHaxeCppExternCarrier | HaxeCppExternPlanningFailure {
  const type = getHaxeCppExternOptionalValueType(sourceType);
  const isOptional = optional || type !== sourceType;
  if (isOptional) {
    if (type.kind !== 'primitive' || type.name !== 'number') {
      return unsupportedHaxeCppExternCarrier('only optional Float is supported by this Haxe C++ extern slice');
    }
    return { cppType: 'std::optional<double>', haxeType: 'Float', kind: 'optional-float', transport: 'adapter' };
  }
  if (type.kind === 'primitive') {
    if (type.name === 'boolean') return { cppType: 'bool', haxeType: 'Bool', kind: 'boolean', transport: 'direct' };
    if (type.name === 'number') return { cppType: 'double', haxeType: 'Float', kind: 'float', transport: 'direct' };
    if (type.name === 'string') {
      return { cppType: 'flight::String', haxeType: 'String', kind: 'string', transport: 'adapter' };
    }
    if (type.name === 'void' && result) {
      return { cppType: 'void', haxeType: 'Void', kind: 'void', transport: 'direct' };
    }
    return unsupportedHaxeCppExternCarrier(`primitive ${type.name} is not supported`);
  }
  if (type.kind === 'named' && type.reference.kind === 'binding' && type.reference.path.length === 0) {
    if (type.typeArguments.length > 0)
      return unsupportedHaxeCppExternCarrier('generic named carriers are not supported');
    const candidates = typesByBinding.get(type.reference.binding.id) ?? [];
    if (candidates.length !== 1) {
      return unsupportedHaxeCppExternCarrier(
        candidates.length === 0
          ? `named carrier ${type.reference.binding.name} has no unique published C++ type locator`
          : `named carrier ${type.reference.binding.name} has multiple public C++ type locators`,
      );
    }
    const declaration = candidates[0]!;
    const haxeType = `${declaration.haxePackage}.${declaration.haxeName}`;
    return declaration.ownership === 'value'
      ? { cppType: declaration.nativeName, haxeType, kind: 'value-record', transport: 'direct' }
      : { cppType: declaration.nativeName, haxeType, kind: 'reference-record', transport: 'direct' };
  }
  return unsupportedHaxeCppExternCarrier(`type family ${type.kind} is outside the Haxe C++ extern vertical slice`);
}

function emitHaxeCppExternType(plan: Readonly<CompilerHaxeCppExternTypePlan>): EmittedFile {
  const ownership =
    plan.ownership === 'reference'
      ? '// The carrier is flight::Ref<T>; copying this value retains shared ownership and never exposes a raw pointer.'
      : '// The carrier is copied by value; no heap owner or borrowed address crosses the Haxe boundary.';
  return {
    contents: [
      `package ${plan.haxePackage};`,
      '',
      '#if cpp',
      ownership,
      `@:include(${JSON.stringify(plan.include)})`,
      `@:native(${JSON.stringify(plan.nativeName)})`,
      '@:structAccess',
      `extern class ${plan.haxeName} {}`,
      '#end',
      '',
    ].join('\n'),
    dependencies: [plan.include],
    path: `${plan.haxePackage.replaceAll('.', '/')}/${plan.haxeName}.hx`,
  };
}

function emitHaxeCppExternFunctionHolder(
  owner: string,
  sourceFunctions: readonly Readonly<CompilerHaxeCppExternFunctionPlan>[],
): EmittedFile {
  const functions = [...sourceFunctions].sort((left, right) => compareTextCodeUnits(left.key, right.key));
  const segments = owner.split('.');
  const holder = segments.at(-1)!;
  const packageName = segments.slice(0, -1).join('.');
  const includes = [...new Set(functions.map((plan) => plan.adapter?.headerPath ?? plan.include))].sort(
    compareTextCodeUnits,
  );
  const lines = [`package ${packageName};`, '', '#if cpp'];
  for (const include of includes) lines.push(`@:include(${JSON.stringify(include)})`);
  lines.push(`extern class ${holder} {`);
  for (const plan of functions) {
    const parameters = plan.parameters
      .map((parameter) => `${parameter.optional ? '?' : ''}${parameter.haxeName}:${parameter.carrier.haxeType}`)
      .join(', ');
    lines.push(
      `  @:native(${JSON.stringify(plan.adapter?.nativeName ?? plan.targetNativeName)})`,
      `  public static function ${plan.haxeName}(${parameters}):${getHaxeCppExternResultType(plan.result)};`,
    );
  }
  lines.push('}', '#end', '');
  return {
    contents: lines.join('\n'),
    dependencies: includes,
    path: `${owner.replaceAll('.', '/')}.hx`,
  };
}

function emitHaxeCppExternAdapter(plan: Readonly<CompilerHaxeCppExternFunctionPlan>): EmittedFile {
  const adapter = plan.adapter!;
  const includes = ['#include <hxcpp.h>', '#include <optional>', '#include <string>', `#include <${plan.include}>`];
  const parameters = plan.parameters
    .map((parameter) => `${getHaxeCppExternAdapterBoundaryType(parameter.carrier)} argument_${parameter.position}`)
    .join(', ');
  const body: string[] = [];
  for (const parameter of plan.parameters) {
    if (parameter.carrier.kind === 'string') {
      body.push(
        `  const flight::String flight_argument_${parameter.position} = flight::String::from_utf8(argument_${parameter.position}.utf8_str());`,
      );
    } else if (parameter.carrier.kind === 'optional-float') {
      body.push(
        `  const std::optional<double> flight_argument_${parameter.position} = argument_${parameter.position}.hasValue ? std::optional<double>{argument_${parameter.position}.value} : std::optional<double>{};`,
      );
    }
  }
  const arguments_ = plan.parameters
    .map((parameter) =>
      parameter.carrier.transport === 'adapter'
        ? `flight_argument_${parameter.position}`
        : `argument_${parameter.position}`,
    )
    .join(', ');
  const call = `${plan.targetNativeName}(${arguments_})`;
  if (plan.result.kind === 'void') {
    body.push(`  ${call};`);
  } else if (plan.result.kind === 'string') {
    body.push(
      `  const flight::String flight_result = ${call};`,
      '  const std::string haxe_result_utf8 = flight_result.to_utf8();',
      '  return ::String(haxe_result_utf8.data(), haxe_result_utf8.size());',
    );
  } else if (plan.result.kind === 'optional-float') {
    body.push(
      `  const std::optional<double> flight_result = ${call};`,
      '  if (!flight_result.has_value()) return ::hx::Null<double>();',
      '  return ::hx::Null<double>(flight_result.value());',
    );
  } else {
    body.push(`  return ${call};`);
  }
  const comments = adapter.semantics.map((semantic) =>
    semantic === 'copy-string-utf8'
      ? '// String values are copied through UTF-8 in both directions; neither runtime borrows the other string storage.'
      : '// Optional Float values copy presence and payload between hxcpp Null<double> and std::optional<double>.',
  );
  const name = adapter.nativeName.slice(adapter.nativeName.lastIndexOf('::') + 2);
  return {
    contents: [
      '#pragma once',
      ...includes,
      '',
      'namespace flight::haxe::_cpp {',
      ...comments,
      `inline ${getHaxeCppExternAdapterBoundaryType(plan.result)} ${name}(${parameters}) {`,
      ...body,
      '}',
      '} // namespace flight::haxe::_cpp',
      '',
    ].join('\n'),
    dependencies: [plan.include],
    path: adapter.headerPath,
  };
}

function getHaxeCppExternAdapterBoundaryType(carrier: Readonly<CompilerHaxeCppExternCarrier>): string {
  if (carrier.kind === 'string') return '::String';
  if (carrier.kind === 'optional-float') return '::hx::Null<double>';
  return carrier.cppType;
}

function getHaxeCppExternResultType(carrier: Readonly<CompilerHaxeCppExternCarrier>): string {
  return carrier.kind === 'optional-float' ? `Null<${carrier.haxeType}>` : carrier.haxeType;
}

function getHaxeCppExternOptionalValueType(type: Readonly<IrType>): Readonly<IrType> {
  if (type.kind !== 'union') return type;
  const values = type.types.filter((candidate) => candidate.kind !== 'undefined' && candidate.kind !== 'null');
  return values.length === 1 && values.length !== type.types.length ? values[0]! : type;
}

function groupHaxeCppExternTypesByBinding(
  entries: readonly Readonly<HaxeCppExternTypeIndexEntry>[],
): ReadonlyMap<string, readonly Readonly<CompilerHaxeCppExternTypePlan>[]> {
  const result = new Map<string, CompilerHaxeCppExternTypePlan[]>();
  for (const entry of entries) result.set(entry.bindingId, [...(result.get(entry.bindingId) ?? []), entry.plan]);
  return result;
}

function indexHaxeCppExternDeclarations(
  modules: readonly Readonly<IrModule>[],
): ReadonlyMap<string, Readonly<IrDeclaration>> {
  const result = new Map<string, Readonly<IrDeclaration>>();
  for (const module of modules) {
    for (const declaration of module.declarations) {
      for (const binding of getHaxeCppExternDeclarationBindings(declaration)) {
        const identity = normalizeCompilerStructuralValueCanonical(binding);
        if (result.has(identity)) throw new TypeError(`Haxe C++ extern input duplicates declaration ${binding.id}`);
        result.set(identity, declaration);
      }
    }
  }
  return result;
}

function getHaxeCppExternDeclarationBinding(
  declaration: Readonly<IrDeclaration>,
): IrBindingIdentity | IrTypeBindingIdentity {
  if ('binding' in declaration) return declaration.binding;
  const bindings = getHaxeCppExternPatternBindings(declaration.pattern);
  if (bindings.length !== 1) throw new TypeError('Haxe C++ extern declaration requires one binding');
  return bindings[0]!;
}

function getHaxeCppExternDeclarationBindings(
  declaration: Readonly<IrDeclaration>,
): readonly (IrBindingIdentity | IrTypeBindingIdentity)[] {
  return 'binding' in declaration ? [declaration.binding] : getHaxeCppExternPatternBindings(declaration.pattern);
}

function getHaxeCppExternPatternBindings(pattern: Readonly<IrBindingPattern>): readonly IrBindingIdentity[] {
  if (pattern.kind === 'binding') return [pattern.binding];
  const children =
    pattern.kind === 'array'
      ? pattern.elements.flatMap((element) => (element ? getHaxeCppExternPatternBindings(element.pattern) : []))
      : pattern.properties.flatMap((property) => getHaxeCppExternPatternBindings(property.pattern));
  return pattern.rest ? [...children, ...getHaxeCppExternPatternBindings(pattern.rest)] : children;
}

function validateHaxeCppExternLocator(
  locator: Readonly<{ include: string; namespace: string; spelling: string }>,
): HaxeCppExternPlanningFailure | undefined {
  if (!locator.include.trim() || /[\r\n"<>]/u.test(locator.include)) {
    return { code: 'invalid-locator', message: 'Haxe C++ extern include locator is not a safe header spelling' };
  }
  if (!isHaxeCppExternQualifiedName(locator.namespace) || !isHaxeCppExternIdentifier(locator.spelling)) {
    return { code: 'invalid-locator', message: 'Haxe C++ extern native locator is not a qualified C++ name' };
  }
  return undefined;
}

function getHaxeCppExternQualifiedName(namespace: string, spelling: string): string {
  return namespace ? `${namespace}::${spelling}` : spelling;
}

function isHaxeCppExternQualifiedName(value: string): boolean {
  return value === '' || value.split('::').every(isHaxeCppExternIdentifier);
}

function isHaxeCppExternIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function getHaxeCppExternHiddenOwner(owner: string): string {
  const segments = owner.split('.');
  return [segments[0]!, '_cpp', ...segments.slice(1)].join('.');
}

function getHaxeCppExternHiddenFunctionOwner(owner: string): string {
  const segments = owner.split('.');
  return [segments[0]!, '_cpp', '_fn', ...segments.slice(1)].join('.');
}

function getSafeHaxeCppExternName(name: string): string {
  const escaped = [...name]
    .map((character, index) =>
      (index === 0 ? /[A-Za-z_]/u : /[A-Za-z0-9_]/u).test(character)
        ? character
        : `_u${character.codePointAt(0)!.toString(16).padStart(4, '0')}_`,
    )
    .join('');
  const identifier = escaped || '_';
  return haxeCppExternKeywords.has(identifier) ? `${identifier}_` : identifier;
}

function getHaxeCppExternStableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function unsupportedHaxeCppExternCarrier(
  message: string,
  code: CompilerHaxeCppExternRefusal['code'] = 'unsupported-carrier',
): HaxeCppExternPlanningFailure {
  return { code, message };
}

function createHaxeCppExternRefusal(
  key: string,
  code: CompilerHaxeCppExternRefusal['code'],
  message: string,
  phase: CompilerHaxeCppExternRefusal['phase'],
  detailCode?: string,
): CompilerHaxeCppExternRefusal {
  return { code, ...(detailCode ? { detailCode } : {}), key, message, phase };
}

function compareHaxeCppExternDeclarations(
  left: Readonly<CompilerHaxeCppExternDeclarationPlan>,
  right: Readonly<CompilerHaxeCppExternDeclarationPlan>,
): number {
  return compareTextCodeUnits(left.key, right.key);
}

function compareHaxeCppExternRefusals(
  left: Readonly<CompilerHaxeCppExternRefusal>,
  right: Readonly<CompilerHaxeCppExternRefusal>,
): number {
  return compareTextCodeUnits(
    `${left.key}\0${left.phase}\0${left.code}`,
    `${right.key}\0${right.phase}\0${right.code}`,
  );
}

function isHaxeCppExternPlanShape(value: unknown): value is Readonly<CompilerHaxeCppExternPlan> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CompilerHaxeCppExternPlan>;
  return (
    candidate.schema === 'flight-haxe-cpp-extern-plan/1' &&
    Array.isArray(candidate.declarations) &&
    Array.isArray(candidate.refusals)
  );
}

function cloneAndFreezeHaxeCppExternPlan(plan: CompilerHaxeCppExternPlan): CompilerHaxeCppExternPlan {
  const clone = structuredClone(plan);
  freezeHaxeCppExternValue(clone, new WeakSet());
  return clone;
}

function cloneAndFreezeHaxeCppExternEmission(emission: CompilerHaxeCppExternEmission): CompilerHaxeCppExternEmission {
  const clone = structuredClone(emission);
  freezeHaxeCppExternValue(clone, new WeakSet());
  return clone;
}

function freezeHaxeCppExternValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeHaxeCppExternValue(child, seen);
  Object.freeze(value);
}

const haxeCppExternKeywords = new Set([
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
  'private',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'trace',
  'true',
  'try',
  'typedef',
  'untyped',
  'using',
  'var',
  'while',
]);
