import type {
  CompilerRuntimeCapabilityName,
  CompilerRuntimeExternalMemberBinding,
  CompilerRuntimeExternalSymbolBinding,
  CompilerRuntimeExternalSymbolBindingPlan,
  CompilerRuntimeExternalSymbolSpace,
  CppCompilerExternalBinding,
  CppCompilerExternalBindingConstruction,
  CppCompilerExternalBindingManifest,
  CppCompilerRuntimeProfile,
} from '../../compiler-types/src/index.js';

type CppRuntimeExternalSymbolBinding =
  | Readonly<{
      kind: Extract<CompilerRuntimeExternalSymbolBinding, { kind: 'native' }>['kind'];
      members?: readonly CompilerRuntimeExternalMemberBinding[] | undefined;
      sourceName: string;
      space: CompilerRuntimeExternalSymbolSpace;
      targetName: string;
      headers?: readonly string[] | undefined;
      construction?: CppCompilerExternalBindingConstruction | undefined;
    }>
  | Readonly<{
      capability: CompilerRuntimeCapabilityName;
      kind: Extract<CompilerRuntimeExternalSymbolBinding, { kind: 'runtime' }>['kind'];
      members?: readonly CompilerRuntimeExternalMemberBinding[] | undefined;
      sourceName: string;
      space: CompilerRuntimeExternalSymbolSpace;
      targetName: string;
      headers?: readonly string[] | undefined;
      construction?: CppCompilerExternalBindingConstruction | undefined;
    }>;

export function createCompilerRuntimeExternalSymbolBindingPlanCpp(
  runtimeProfile: CppCompilerRuntimeProfile = 'standard-library',
  externalBindings?: Readonly<CppCompilerExternalBindingManifest> | undefined,
): CompilerRuntimeExternalSymbolBindingPlan {
  return {
    bindings: getCppRuntimeExternalSymbolBindings(runtimeProfile, externalBindings).map((binding) =>
      binding.kind === 'runtime'
        ? {
            capability: binding.capability,
            externalSymbol: { sourceName: binding.sourceName, space: binding.space },
            kind: binding.kind,
          }
        : {
            externalSymbol: { sourceName: binding.sourceName, space: binding.space },
            kind: binding.kind,
          },
    ),
    contract: 'flight-runtime-contract/2',
  };
}

export function getCompilerExternalBindingConstructionCpp(
  sourceName: string,
  externalBindings?: Readonly<CppCompilerExternalBindingManifest> | undefined,
): CppCompilerExternalBindingConstruction | undefined {
  return getCppCompilerExternalBindings(externalBindings).find(
    (binding) => binding.sourceName === sourceName.normalize('NFC') && binding.space === 'value',
  )?.construction;
}

export function getCompilerExternalBindingHeadersCpp(
  sourceName: string,
  space: CompilerRuntimeExternalSymbolSpace,
  externalBindings?: Readonly<CppCompilerExternalBindingManifest> | undefined,
  runtimeProfile: CppCompilerRuntimeProfile = 'standard-library',
): readonly string[] {
  return (
    getCppRuntimeExternalSymbolBindings(runtimeProfile, externalBindings).find(
      (binding) => binding.sourceName === sourceName.normalize('NFC') && binding.space === space,
    )?.headers ?? []
  );
}

export function getCompilerRuntimeExternalMemberTargetCpp(
  sourceName: string,
  member: string,
  runtimeProfile: CppCompilerRuntimeProfile = 'standard-library',
  externalBindings?: Readonly<CppCompilerExternalBindingManifest> | undefined,
): string | undefined {
  const normalized = sourceName.normalize('NFC');
  const binding: CppRuntimeExternalSymbolBinding | undefined = getCppRuntimeExternalSymbolBindings(
    runtimeProfile,
    externalBindings,
  ).find((candidate) => candidate.sourceName === normalized && candidate.space === 'value');
  if (!binding) return undefined;
  return binding.members?.find((candidate) => candidate.sourceMember === member.normalize('NFC'))?.targetName;
}

export function getCompilerRuntimeExternalSymbolTargetCpp(
  sourceName: string,
  space: CompilerRuntimeExternalSymbolSpace,
  runtimeProfile: CppCompilerRuntimeProfile = 'standard-library',
  externalBindings?: Readonly<CppCompilerExternalBindingManifest> | undefined,
): string | undefined {
  const normalized = sourceName.normalize('NFC');
  return getCppRuntimeExternalSymbolBindings(runtimeProfile, externalBindings).find(
    (candidate) => candidate.sourceName === normalized && candidate.space === space,
  )?.targetName;
}

export function isCompilerRuntimeExternalSymbolProvidedCpp(
  sourceName: string,
  space: CompilerRuntimeExternalSymbolSpace,
  runtimeProfile: CppCompilerRuntimeProfile = 'standard-library',
  externalBindings?: Readonly<CppCompilerExternalBindingManifest> | undefined,
): boolean {
  const normalized = sourceName.normalize('NFC');
  return (
    getCppRuntimeExternalSymbolBindings(runtimeProfile, externalBindings).find(
      (candidate) => candidate.sourceName === normalized && candidate.space === space,
    )?.kind === 'runtime'
  );
}

function getCppRuntimeExternalSymbolBindings(
  runtimeProfile: CppCompilerRuntimeProfile,
  externalBindings?: Readonly<CppCompilerExternalBindingManifest> | undefined,
): readonly CppRuntimeExternalSymbolBinding[] {
  const runtime =
    runtimeProfile === 'flight-cpp' ? cppFlightRuntimeExternalSymbolBindings : cppRuntimeExternalSymbolBindings;
  return [...runtime, ...getCppCompilerExternalBindings(externalBindings)];
}

function getCppCompilerExternalBindings(
  manifest?: Readonly<CppCompilerExternalBindingManifest> | undefined,
): readonly CppRuntimeExternalSymbolBinding[] {
  if (!manifest) return [];
  if (manifest.schema !== 'flight-cpp-external-bindings/1' || !Array.isArray(manifest.bindings)) {
    throw new TypeError('C++ external bindings require flight-cpp-external-bindings/1');
  }
  return manifest.bindings.map((binding: Readonly<CppCompilerExternalBinding>, index: number) => {
    const subject = `C++ external binding ${String(index)}`;
    if (
      !binding ||
      typeof binding.sourceName !== 'string' ||
      binding.sourceName.length === 0 ||
      (binding.space !== 'type' && binding.space !== 'value') ||
      typeof binding.targetName !== 'string' ||
      binding.targetName.length === 0 ||
      !Array.isArray(binding.headers) ||
      binding.headers.some((header: unknown) => !isCppExternalBindingHeader(header)) ||
      (binding.nullability !== 'non-null' && binding.nullability !== 'nullable') ||
      !cppExternalBindingOwnerships.has(binding.ownership)
    ) {
      throw new TypeError(`${subject} is malformed`);
    }
    if (
      binding.members?.some(
        (member: Readonly<{ sourceMember: string; targetName: string }>) =>
          !member ||
          typeof member.sourceMember !== 'string' ||
          member.sourceMember.length === 0 ||
          typeof member.targetName !== 'string' ||
          member.targetName.length === 0,
      )
    ) {
      throw new TypeError(`${subject} has malformed static-member mappings`);
    }
    if (
      binding.construction &&
      (binding.space !== 'value' ||
        (binding.construction.kind !== 'constructor' && binding.construction.kind !== 'factory') ||
        typeof binding.construction.targetName !== 'string' ||
        binding.construction.targetName.length === 0)
    ) {
      throw new TypeError(`${subject} has a malformed construction mapping`);
    }
    return {
      ...(binding.construction ? { construction: { ...binding.construction } } : {}),
      headers: [...binding.headers],
      kind: 'native' as const,
      ...(binding.members
        ? {
            members: binding.members.map((member: Readonly<{ sourceMember: string; targetName: string }>) => ({
              ...member,
            })),
          }
        : {}),
      sourceName: binding.sourceName.normalize('NFC'),
      space: binding.space,
      targetName: binding.targetName,
    };
  });
}

function isCppExternalBindingHeader(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/[<>"\r\n]/u.test(value) &&
    value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

const cppExternalBindingOwnerships = new Set(['borrowed', 'owned', 'shared', 'value']);

const cppMathImulTarget =
  '([](double left, double right) noexcept { const auto to_uint32 = [](double value) noexcept { if (!std::isfinite(value) || value == 0.0) return std::uint32_t{0}; constexpr double modulus = 4294967296.0; double remainder = std::fmod(std::trunc(value), modulus); if (remainder < 0.0) remainder += modulus; return static_cast<std::uint32_t>(remainder); }; const std::uint32_t product = to_uint32(left) * to_uint32(right); return product < 0x80000000U ? static_cast<double>(product) : static_cast<double>(static_cast<std::int64_t>(product) - 0x100000000LL); })';

const cppMathRandomTarget =
  '([]() { static thread_local std::mt19937_64 engine(std::random_device{}()); return std::generate_canonical<double, 53>(engine); })';

const cppObjectIsTarget =
  '([](const auto& left, const auto& right) { using Left = std::remove_cvref_t<decltype(left)>; using Right = std::remove_cvref_t<decltype(right)>; if constexpr (!std::is_same_v<Left, Right>) { return false; } else if constexpr (std::is_floating_point_v<Left>) { if (std::isnan(left) && std::isnan(right)) return true; if (left == 0.0 && right == 0.0) return std::signbit(left) == std::signbit(right); return left == right; } else { return left == right; } })';

const cppObjectKeysTarget =
  '([](const auto& value) { using Key = std::remove_cvref_t<decltype(value.begin()->first)>; std::vector<Key> keys; keys.reserve(value.size()); for (const auto& entry : value) keys.push_back(entry.first); return keys; })';

const cppIntlRuntimeTypeTargets = [
  ['Intl.Collator', 'flight::IntlCollator'],
  ['Intl.CollatorOptions', 'flight::IntlCollatorOptions'],
  ['Intl.DateTimeFormat', 'flight::IntlDateTimeFormat'],
  ['Intl.DateTimeFormatOptions', 'flight::IntlDateTimeFormatOptions'],
  ['Intl.LDMLPluralRule', 'flight::IntlPluralRule'],
  ['Intl.ListFormat', 'flight::IntlListFormat'],
  ['Intl.ListFormatOptions', 'flight::IntlListFormatOptions'],
  ['Intl.NumberFormat', 'flight::IntlNumberFormat'],
  ['Intl.NumberFormatOptions', 'flight::IntlNumberFormatOptions'],
  ['Intl.PluralRules', 'flight::IntlPluralRules'],
  ['Intl.PluralRulesOptions', 'flight::IntlPluralRulesOptions'],
  ['Intl.RelativeTimeFormat', 'flight::IntlRelativeTimeFormat'],
  ['Intl.RelativeTimeFormatOptions', 'flight::IntlRelativeTimeFormatOptions'],
  ['Intl.RelativeTimeFormatUnit', 'flight::IntlRelativeTimeFormatUnit'],
] as const;

const cppFlightRuntimeExternalSymbolBindings = [
  {
    headers: ['cmath', 'cstdint', 'random'],
    kind: 'native',
    members: [
      { sourceMember: 'E', targetName: 'flight::e' },
      { sourceMember: 'PI', targetName: 'flight::pi' },
      { sourceMember: 'abs', targetName: 'std::abs' },
      { sourceMember: 'acos', targetName: 'std::acos' },
      { sourceMember: 'asin', targetName: 'std::asin' },
      { sourceMember: 'atan', targetName: 'std::atan' },
      { sourceMember: 'atan2', targetName: 'std::atan2' },
      { sourceMember: 'cbrt', targetName: 'std::cbrt' },
      { sourceMember: 'ceil', targetName: 'std::ceil' },
      { sourceMember: 'cos', targetName: 'std::cos' },
      { sourceMember: 'exp', targetName: 'std::exp' },
      { sourceMember: 'floor', targetName: 'std::floor' },
      { sourceMember: 'hypot', targetName: 'std::hypot' },
      { sourceMember: 'imul', targetName: cppMathImulTarget },
      { sourceMember: 'log', targetName: 'std::log' },
      { sourceMember: 'log10', targetName: 'std::log10' },
      { sourceMember: 'log2', targetName: 'std::log2' },
      { sourceMember: 'max', targetName: 'flight::maximum' },
      { sourceMember: 'min', targetName: 'flight::minimum' },
      { sourceMember: 'pow', targetName: 'flight::power' },
      { sourceMember: 'random', targetName: cppMathRandomTarget },
      { sourceMember: 'round', targetName: 'flight::round' },
      { sourceMember: 'sign', targetName: 'flight::sign' },
      { sourceMember: 'sin', targetName: 'std::sin' },
      { sourceMember: 'sqrt', targetName: 'std::sqrt' },
      { sourceMember: 'tan', targetName: 'std::tan' },
      { sourceMember: 'trunc', targetName: 'std::trunc' },
    ],
    sourceName: 'Math',
    space: 'value',
    targetName: 'cmath',
  },
  { capability: 'array', kind: 'runtime', sourceName: 'Array', space: 'type', targetName: 'flight::Array' },
  {
    capability: 'array',
    kind: 'runtime',
    members: [{ sourceMember: 'isArray', targetName: 'flight::is_array' }],
    sourceName: 'Array',
    space: 'value',
    targetName: 'flight::Array',
  },
  {
    capability: 'array-buffer',
    headers: ['flight/array_buffer.hpp'],
    kind: 'runtime',
    sourceName: 'ArrayBuffer',
    space: 'type',
    targetName: 'flight::ArrayBuffer',
  },
  {
    capability: 'array-buffer',
    headers: ['flight/array_buffer.hpp'],
    kind: 'runtime',
    sourceName: 'ArrayBuffer',
    space: 'value',
    targetName: 'flight::ArrayBuffer',
  },
  { kind: 'native', sourceName: 'Boolean', space: 'type', targetName: 'bool' },
  { capability: 'date', kind: 'runtime', sourceName: 'Date', space: 'type', targetName: 'flight::Date' },
  {
    capability: 'date',
    kind: 'runtime',
    members: [{ sourceMember: 'now', targetName: 'flight::Date::now' }],
    sourceName: 'Date',
    space: 'value',
    targetName: 'flight::Date',
  },
  {
    capability: 'data-view',
    headers: ['flight/data_view.hpp'],
    kind: 'runtime',
    sourceName: 'DataView',
    space: 'type',
    targetName: 'flight::DataView',
  },
  {
    capability: 'data-view',
    headers: ['flight/data_view.hpp'],
    kind: 'runtime',
    sourceName: 'DataView',
    space: 'value',
    targetName: 'flight::DataView',
  },
  { capability: 'error', kind: 'runtime', sourceName: 'Error', space: 'type', targetName: 'flight::Error' },
  { capability: 'error', kind: 'runtime', sourceName: 'Error', space: 'value', targetName: 'flight::Error' },
  {
    capability: 'float32-array',
    kind: 'runtime',
    sourceName: 'Float32Array',
    space: 'type',
    targetName: 'flight::Float32Array',
  },
  {
    capability: 'float32-array',
    kind: 'runtime',
    sourceName: 'Float32Array',
    space: 'value',
    targetName: 'flight::Float32Array',
  },
  {
    capability: 'float64-array',
    kind: 'runtime',
    sourceName: 'Float64Array',
    space: 'type',
    targetName: 'flight::Float64Array',
  },
  {
    capability: 'float64-array',
    kind: 'runtime',
    sourceName: 'Float64Array',
    space: 'value',
    targetName: 'flight::Float64Array',
  },
  {
    kind: 'native',
    sourceName: 'Infinity',
    space: 'value',
    targetName: 'std::numeric_limits<double>::infinity()',
  },
  {
    capability: 'int16-array',
    kind: 'runtime',
    sourceName: 'Int16Array',
    space: 'type',
    targetName: 'flight::Int16Array',
  },
  {
    capability: 'int16-array',
    kind: 'runtime',
    sourceName: 'Int16Array',
    space: 'value',
    targetName: 'flight::Int16Array',
  },
  {
    capability: 'int32-array',
    kind: 'runtime',
    sourceName: 'Int32Array',
    space: 'type',
    targetName: 'flight::Int32Array',
  },
  {
    capability: 'int32-array',
    kind: 'runtime',
    sourceName: 'Int32Array',
    space: 'value',
    targetName: 'flight::Int32Array',
  },
  {
    capability: 'int8-array',
    kind: 'runtime',
    sourceName: 'Int8Array',
    space: 'type',
    targetName: 'flight::Int8Array',
  },
  {
    capability: 'int8-array',
    kind: 'runtime',
    sourceName: 'Int8Array',
    space: 'value',
    targetName: 'flight::Int8Array',
  },
  {
    capability: 'internationalization',
    headers: ['flight/intl.hpp'],
    kind: 'runtime',
    members: [
      { sourceMember: 'Collator', targetName: 'flight::IntlCollator' },
      { sourceMember: 'DateTimeFormat', targetName: 'flight::IntlDateTimeFormat' },
      { sourceMember: 'ListFormat', targetName: 'flight::IntlListFormat' },
      { sourceMember: 'NumberFormat', targetName: 'flight::IntlNumberFormat' },
      { sourceMember: 'PluralRules', targetName: 'flight::IntlPluralRules' },
      { sourceMember: 'RelativeTimeFormat', targetName: 'flight::IntlRelativeTimeFormat' },
    ],
    sourceName: 'Intl',
    space: 'value',
    targetName: 'flight::Intl',
  },
  ...cppIntlRuntimeTypeTargets.map(([sourceName, targetName]) => ({
    capability: 'internationalization' as const,
    headers: ['flight/intl.hpp'],
    kind: 'runtime' as const,
    sourceName,
    space: 'type' as const,
    targetName,
  })),
  {
    capability: 'json',
    headers: ['flight/json.hpp'],
    kind: 'runtime',
    members: [
      { sourceMember: 'parse', targetName: 'flight::Json::parse' },
      { sourceMember: 'stringify', targetName: 'flight::Json::stringify' },
    ],
    sourceName: 'JSON',
    space: 'value',
    targetName: 'flight::Json',
  },
  { capability: 'map', kind: 'runtime', sourceName: 'Map', space: 'type', targetName: 'flight::Map' },
  { capability: 'map', kind: 'runtime', sourceName: 'Map', space: 'value', targetName: 'flight::Map' },
  {
    kind: 'native',
    sourceName: 'NaN',
    space: 'value',
    targetName: 'std::numeric_limits<double>::quiet_NaN()',
  },
  { kind: 'native', sourceName: 'Number', space: 'type', targetName: 'double' },
  {
    headers: ['cmath'],
    kind: 'native',
    sourceName: 'isNaN',
    space: 'value',
    targetName: 'std::isnan',
  },
  {
    capability: 'number-parsing',
    headers: ['flight/number.hpp'],
    kind: 'runtime',
    members: [
      { sourceMember: 'EPSILON', targetName: 'std::numeric_limits<double>::epsilon()' },
      { sourceMember: 'MAX_SAFE_INTEGER', targetName: '9007199254740991.0' },
      { sourceMember: 'MAX_VALUE', targetName: 'std::numeric_limits<double>::max()' },
      { sourceMember: 'MIN_VALUE', targetName: 'std::numeric_limits<double>::denorm_min()' },
      { sourceMember: 'NEGATIVE_INFINITY', targetName: '-std::numeric_limits<double>::infinity()' },
      { sourceMember: 'POSITIVE_INFINITY', targetName: 'std::numeric_limits<double>::infinity()' },
      { sourceMember: 'isFinite', targetName: 'std::isfinite' },
      { sourceMember: 'isInteger', targetName: 'flight::is_integer' },
      { sourceMember: 'isNaN', targetName: 'std::isnan' },
    ],
    sourceName: 'Number',
    space: 'value',
    targetName: 'flight::to_number',
  },
  {
    capability: 'object',
    headers: ['cmath', 'flight/object.hpp', 'type_traits'],
    kind: 'runtime',
    members: [
      { sourceMember: 'is', targetName: cppObjectIsTarget },
      { sourceMember: 'keys', targetName: 'flight::object_keys' },
    ],
    sourceName: 'Object',
    space: 'value',
    targetName: 'flight::Object',
  },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', space: 'type', targetName: 'flight::Task' },
  {
    capability: 'task',
    kind: 'runtime',
    members: [
      { sourceMember: 'all', targetName: 'flight::all_tasks' },
      { sourceMember: 'reject', targetName: 'flight::reject_task' },
      { sourceMember: 'resolve', targetName: 'flight::resolve_task' },
    ],
    sourceName: 'Promise',
    space: 'value',
    targetName: 'flight::Task',
  },
  { kind: 'native', sourceName: 'RangeError', space: 'type', targetName: 'std::range_error' },
  { kind: 'native', sourceName: 'RangeError', space: 'value', targetName: 'std::range_error' },
  {
    capability: 'regexp',
    headers: ['flight/regexp.hpp'],
    kind: 'runtime',
    sourceName: 'RegExp',
    space: 'type',
    targetName: 'flight::RegExp',
  },
  {
    capability: 'regexp',
    headers: ['flight/regexp.hpp'],
    kind: 'runtime',
    sourceName: 'RegExp',
    space: 'value',
    targetName: 'flight::RegExp',
  },
  {
    capability: 'regexp',
    headers: ['flight/regexp.hpp'],
    kind: 'runtime',
    sourceName: 'RegExpExecArray',
    space: 'type',
    targetName: 'flight::RegExpExecArray',
  },
  {
    capability: 'map',
    headers: ['flight/map.hpp'],
    kind: 'runtime',
    sourceName: 'ReadonlyMap',
    space: 'type',
    targetName: 'flight::Map',
  },
  {
    capability: 'set',
    kind: 'runtime',
    sourceName: 'ReadonlySet',
    space: 'type',
    targetName: 'flight::Set',
  },
  {
    headers: ['unordered_map'],
    kind: 'native',
    sourceName: 'Record',
    space: 'type',
    targetName: 'std::unordered_map',
  },
  { capability: 'set', kind: 'runtime', sourceName: 'Set', space: 'type', targetName: 'flight::Set' },
  { capability: 'set', kind: 'runtime', sourceName: 'Set', space: 'value', targetName: 'flight::Set' },
  { capability: 'string', kind: 'runtime', sourceName: 'String', space: 'type', targetName: 'flight::String' },
  {
    capability: 'string',
    kind: 'runtime',
    members: [
      { sourceMember: 'fromCharCode', targetName: 'flight::String::from_char_code' },
      { sourceMember: 'fromCodePoint', targetName: 'flight::String::from_code_point' },
    ],
    sourceName: 'String',
    space: 'value',
    targetName: 'flight::String',
  },
  {
    capability: 'symbol',
    headers: ['flight/symbol.hpp'],
    kind: 'runtime',
    members: [{ sourceMember: 'for', targetName: 'flight::Symbol::for_key' }],
    sourceName: 'Symbol',
    space: 'value',
    targetName: 'flight::Symbol',
  },
  {
    capability: 'text-decoder',
    headers: ['flight/text_decoder.hpp'],
    kind: 'runtime',
    sourceName: 'TextDecoder',
    space: 'type',
    targetName: 'flight::TextDecoder',
  },
  {
    capability: 'text-decoder',
    headers: ['flight/text_decoder.hpp'],
    kind: 'runtime',
    sourceName: 'TextDecoder',
    space: 'value',
    targetName: 'flight::TextDecoder',
  },
  { kind: 'native', sourceName: 'TypeError', space: 'type', targetName: 'std::runtime_error' },
  { kind: 'native', sourceName: 'TypeError', space: 'value', targetName: 'std::runtime_error' },
  {
    capability: 'uint16-array',
    kind: 'runtime',
    sourceName: 'Uint16Array',
    space: 'type',
    targetName: 'flight::Uint16Array',
  },
  {
    capability: 'uint16-array',
    kind: 'runtime',
    sourceName: 'Uint16Array',
    space: 'value',
    targetName: 'flight::Uint16Array',
  },
  {
    capability: 'uint32-array',
    kind: 'runtime',
    sourceName: 'Uint32Array',
    space: 'type',
    targetName: 'flight::Uint32Array',
  },
  {
    capability: 'uint32-array',
    kind: 'runtime',
    sourceName: 'Uint32Array',
    space: 'value',
    targetName: 'flight::Uint32Array',
  },
  {
    capability: 'uint8-array',
    kind: 'runtime',
    sourceName: 'Uint8Array',
    space: 'type',
    targetName: 'flight::Uint8Array',
  },
  {
    capability: 'uint8-array',
    kind: 'runtime',
    sourceName: 'Uint8Array',
    space: 'value',
    targetName: 'flight::Uint8Array',
  },
  {
    capability: 'uint8-clamped-array',
    kind: 'runtime',
    sourceName: 'Uint8ClampedArray',
    space: 'type',
    targetName: 'flight::Uint8ClampedArray',
  },
  {
    capability: 'url',
    headers: ['flight/url.hpp'],
    kind: 'runtime',
    sourceName: 'URL',
    space: 'type',
    targetName: 'flight::Url',
  },
  {
    capability: 'url',
    headers: ['flight/url.hpp'],
    kind: 'runtime',
    sourceName: 'URL',
    space: 'value',
    targetName: 'flight::Url',
  },
  {
    capability: 'uint8-clamped-array',
    kind: 'runtime',
    sourceName: 'Uint8ClampedArray',
    space: 'value',
    targetName: 'flight::Uint8ClampedArray',
  },
  {
    headers: ['unordered_map'],
    kind: 'native',
    sourceName: 'WeakMap',
    space: 'type',
    targetName: 'std::unordered_map',
  },
  {
    headers: ['unordered_map'],
    kind: 'native',
    sourceName: 'WeakMap',
    space: 'value',
    targetName: 'std::unordered_map',
  },
  {
    capability: 'number-parsing',
    headers: ['flight/number.hpp'],
    kind: 'runtime',
    sourceName: 'parseInt',
    space: 'value',
    targetName: 'flight::parse_int',
  },
] as const satisfies readonly CppRuntimeExternalSymbolBinding[];

const cppRuntimeExternalSymbolBindings = [
  {
    headers: ['cmath', 'cstdint', 'random'],
    kind: 'native',
    members: [
      { sourceMember: 'E', targetName: 'M_E' },
      { sourceMember: 'PI', targetName: 'M_PI' },
      { sourceMember: 'abs', targetName: 'std::abs' },
      { sourceMember: 'acos', targetName: 'std::acos' },
      { sourceMember: 'asin', targetName: 'std::asin' },
      { sourceMember: 'atan', targetName: 'std::atan' },
      { sourceMember: 'atan2', targetName: 'std::atan2' },
      { sourceMember: 'cbrt', targetName: 'std::cbrt' },
      { sourceMember: 'ceil', targetName: 'std::ceil' },
      { sourceMember: 'cos', targetName: 'std::cos' },
      { sourceMember: 'exp', targetName: 'std::exp' },
      { sourceMember: 'floor', targetName: 'std::floor' },
      { sourceMember: 'hypot', targetName: 'std::hypot' },
      { sourceMember: 'imul', targetName: cppMathImulTarget },
      { sourceMember: 'log', targetName: 'std::log' },
      { sourceMember: 'log10', targetName: 'std::log10' },
      { sourceMember: 'log2', targetName: 'std::log2' },
      { sourceMember: 'max', targetName: 'std::max' },
      { sourceMember: 'min', targetName: 'std::min' },
      { sourceMember: 'pow', targetName: 'std::pow' },
      { sourceMember: 'random', targetName: cppMathRandomTarget },
      { sourceMember: 'round', targetName: 'std::round' },
      { sourceMember: 'sign', targetName: 'flight::sign' },
      { sourceMember: 'sin', targetName: 'std::sin' },
      { sourceMember: 'sqrt', targetName: 'std::sqrt' },
      { sourceMember: 'tan', targetName: 'std::tan' },
      { sourceMember: 'trunc', targetName: 'std::trunc' },
    ],
    sourceName: 'Math',
    space: 'value',
    targetName: 'cmath',
  },
  { kind: 'native', sourceName: 'Array', space: 'type', targetName: 'std::vector' },
  { kind: 'native', sourceName: 'Array', space: 'value', targetName: 'std::vector' },
  {
    headers: ['cstdint', 'vector'],
    kind: 'native',
    sourceName: 'ArrayBuffer',
    space: 'type',
    targetName: 'std::vector<uint8_t>',
  },
  { kind: 'native', sourceName: 'Boolean', space: 'type', targetName: 'bool' },
  { capability: 'date', kind: 'runtime', sourceName: 'Date', space: 'type', targetName: 'FlightDate' },
  { capability: 'date', kind: 'runtime', sourceName: 'Date', space: 'value', targetName: 'FlightDate' },
  { kind: 'native', sourceName: 'Error', space: 'type', targetName: 'std::runtime_error' },
  { kind: 'native', sourceName: 'Error', space: 'value', targetName: 'std::runtime_error' },
  { kind: 'native', sourceName: 'Float32Array', space: 'type', targetName: 'std::vector<float>' },
  { kind: 'native', sourceName: 'Float32Array', space: 'value', targetName: 'std::vector<float>' },
  { kind: 'native', sourceName: 'Float64Array', space: 'type', targetName: 'std::vector<double>' },
  { kind: 'native', sourceName: 'Float64Array', space: 'value', targetName: 'std::vector<double>' },
  {
    headers: ['cmath'],
    kind: 'native',
    sourceName: 'isNaN',
    space: 'value',
    targetName: 'std::isnan',
  },
  {
    kind: 'native',
    sourceName: 'Infinity',
    space: 'value',
    targetName: 'std::numeric_limits<double>::infinity()',
  },
  { kind: 'native', sourceName: 'Int16Array', space: 'type', targetName: 'std::vector<int16_t>' },
  { kind: 'native', sourceName: 'Int16Array', space: 'value', targetName: 'std::vector<int16_t>' },
  { kind: 'native', sourceName: 'Int32Array', space: 'type', targetName: 'std::vector<int32_t>' },
  { kind: 'native', sourceName: 'Int32Array', space: 'value', targetName: 'std::vector<int32_t>' },
  { kind: 'native', sourceName: 'Int8Array', space: 'type', targetName: 'std::vector<int8_t>' },
  { kind: 'native', sourceName: 'Int8Array', space: 'value', targetName: 'std::vector<int8_t>' },
  { kind: 'native', sourceName: 'Map', space: 'type', targetName: 'std::unordered_map' },
  { kind: 'native', sourceName: 'Map', space: 'value', targetName: 'std::unordered_map' },
  {
    kind: 'native',
    sourceName: 'NaN',
    space: 'value',
    targetName: 'std::numeric_limits<double>::quiet_NaN()',
  },
  { kind: 'native', sourceName: 'Number', space: 'type', targetName: 'double' },
  {
    kind: 'native',
    members: [
      { sourceMember: 'EPSILON', targetName: 'std::numeric_limits<double>::epsilon()' },
      { sourceMember: 'MAX_SAFE_INTEGER', targetName: '9007199254740991.0' },
      { sourceMember: 'MAX_VALUE', targetName: 'std::numeric_limits<double>::max()' },
      { sourceMember: 'MIN_VALUE', targetName: 'std::numeric_limits<double>::denorm_min()' },
      { sourceMember: 'NEGATIVE_INFINITY', targetName: '-std::numeric_limits<double>::infinity()' },
      { sourceMember: 'POSITIVE_INFINITY', targetName: 'std::numeric_limits<double>::infinity()' },
      { sourceMember: 'isFinite', targetName: 'std::isfinite' },
      {
        sourceMember: 'isInteger',
        targetName: '[](double value) noexcept { return std::isfinite(value) && std::trunc(value) == value; }',
      },
      { sourceMember: 'isNaN', targetName: 'std::isnan' },
    ],
    sourceName: 'Number',
    space: 'value',
    targetName: 'double',
  },
  {
    headers: ['cmath', 'type_traits', 'vector'],
    kind: 'native',
    members: [
      { sourceMember: 'is', targetName: cppObjectIsTarget },
      { sourceMember: 'keys', targetName: cppObjectKeysTarget },
    ],
    sourceName: 'Object',
    space: 'value',
    targetName: cppObjectIsTarget,
  },
  { capability: 'task', kind: 'runtime', sourceName: 'Promise', space: 'type', targetName: 'FlightTask' },
  {
    capability: 'task',
    kind: 'runtime',
    members: [
      { sourceMember: 'all', targetName: 'FlightTask::all' },
      { sourceMember: 'reject', targetName: 'FlightTask::reject' },
      { sourceMember: 'resolve', targetName: 'FlightTask::resolve' },
    ],
    sourceName: 'Promise',
    space: 'value',
    targetName: 'FlightTask',
  },
  { kind: 'native', sourceName: 'RangeError', space: 'type', targetName: 'std::range_error' },
  { kind: 'native', sourceName: 'RangeError', space: 'value', targetName: 'std::range_error' },
  {
    headers: ['unordered_map'],
    kind: 'native',
    sourceName: 'ReadonlyMap',
    space: 'type',
    targetName: 'std::unordered_map',
  },
  {
    headers: ['unordered_set'],
    kind: 'native',
    sourceName: 'ReadonlySet',
    space: 'type',
    targetName: 'std::unordered_set',
  },
  {
    headers: ['unordered_map'],
    kind: 'native',
    sourceName: 'Record',
    space: 'type',
    targetName: 'std::unordered_map',
  },
  { kind: 'native', sourceName: 'Set', space: 'type', targetName: 'std::unordered_set' },
  { kind: 'native', sourceName: 'Set', space: 'value', targetName: 'std::unordered_set' },
  { kind: 'native', sourceName: 'String', space: 'type', targetName: 'std::string' },
  { kind: 'native', sourceName: 'String', space: 'value', targetName: 'std::string' },
  { kind: 'native', sourceName: 'TypeError', space: 'type', targetName: 'std::runtime_error' },
  { kind: 'native', sourceName: 'TypeError', space: 'value', targetName: 'std::runtime_error' },
  { kind: 'native', sourceName: 'Uint16Array', space: 'type', targetName: 'std::vector<uint16_t>' },
  { kind: 'native', sourceName: 'Uint16Array', space: 'value', targetName: 'std::vector<uint16_t>' },
  { kind: 'native', sourceName: 'Uint32Array', space: 'type', targetName: 'std::vector<uint32_t>' },
  { kind: 'native', sourceName: 'Uint32Array', space: 'value', targetName: 'std::vector<uint32_t>' },
  { kind: 'native', sourceName: 'Uint8Array', space: 'type', targetName: 'std::vector<uint8_t>' },
  { kind: 'native', sourceName: 'Uint8Array', space: 'value', targetName: 'std::vector<uint8_t>' },
  { kind: 'native', sourceName: 'Uint8ClampedArray', space: 'type', targetName: 'std::vector<uint8_t>' },
  { kind: 'native', sourceName: 'Uint8ClampedArray', space: 'value', targetName: 'std::vector<uint8_t>' },
  {
    headers: ['unordered_map'],
    kind: 'native',
    sourceName: 'WeakMap',
    space: 'type',
    targetName: 'std::unordered_map',
  },
  {
    headers: ['unordered_map'],
    kind: 'native',
    sourceName: 'WeakMap',
    space: 'value',
    targetName: 'std::unordered_map',
  },
] as const satisfies readonly CppRuntimeExternalSymbolBinding[];
