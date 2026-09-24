import {
  isDateArgument,
  isPlainRecord,
  isRecordArgument,
  isRejectedTaskArgument,
  isStringEnumArgument,
  isTaskArgument,
} from './behavioralOracleArgument.js';

export function inferCppValueType(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const element = value.map(inferCppValueType).find((candidate) => candidate !== undefined);
    return element ? `flight::Array<${element}>` : undefined;
  }
  if (typeof value === 'boolean') return 'bool';
  if (isDateArgument(value)) return 'flight::Date';
  if (isRecordArgument(value)) return `flight::Ref<flighthq_golden::${value.$type}>`;
  if (typeof value === 'number') return 'double';
  if (typeof value === 'string') return 'flight::String';
  if (isTaskArgument(value)) return inferCppValueType(value.task);
  if (isRejectedTaskArgument(value)) return inferCppValueType(value.rejects);
  return undefined;
}

export function renderCppValue(value: unknown, hint?: string | null): string {
  const optionalType = unwrapCppTemplateType(hint, 'std::optional');
  if (optionalType) {
    return value === null || value === undefined ? 'std::nullopt' : `${hint!}{${renderCppValue(value, optionalType)}}`;
  }
  const referenceType = unwrapCppTemplateType(hint, 'flight::Ref');
  if (referenceType && (isRecordArgument(value) || isPlainRecord(value))) {
    return renderCppRecord(value, referenceType);
  }
  const tupleType = unwrapCppTemplateType(hint, 'std::tuple');
  if (tupleType) {
    if (!Array.isArray(value)) throw new Error(`C++ oracle tuple hint ${hint!} needs an array value`);
    const itemTypes = splitCppTypes(tupleType);
    if (itemTypes.length !== value.length) {
      throw new Error(`C++ oracle tuple hint ${hint!} does not match ${JSON.stringify(value)}`);
    }
    return `std::make_tuple(${value.map((item, index) => renderCppValue(item, itemTypes[index])).join(', ')})`;
  }
  const hintedArrayType = unwrapCppTemplateType(hint, 'flight::Array');
  if (hintedArrayType) {
    if (!Array.isArray(value)) throw new Error(`C++ oracle array hint ${hint!} needs an array value`);
    return `${hint!}{${value.map((item) => renderCppValue(item, hintedArrayType)).join(', ')}}`;
  }
  if (isDateArgument(value)) return `flight::Date(${renderCppValue(value.date)})`;
  if (isStringEnumArgument(value)) {
    return `flighthq_golden::${value.$stringEnum}::${value.variant}`;
  }
  if (isRecordArgument(value)) {
    return renderCppRecord(value, `flighthq_golden::${value.$type}`);
  }
  if (isTaskArgument(value)) {
    const type = unwrapCppTaskType(hint) ?? inferCppValueType(value.task);
    if (!type) throw new Error('C++ oracle task argument needs a scalar settled type');
    return `flight::Task<${type}>::ready(${renderCppValue(value.task)})`;
  }
  if (isRejectedTaskArgument(value)) {
    const type = unwrapCppTaskType(hint) ?? inferCppValueType(value.rejects);
    if (!type) throw new Error('C++ oracle rejection argument needs a scalar rejection type');
    return `flight::Task<${type}>::reject(${renderCppValue(value.rejects)})`;
  }
  if (Array.isArray(value)) {
    const arrayType = inferCppValueType(value) ?? hint;
    if (!arrayType?.startsWith('flight::Array<')) {
      throw new Error('C++ oracle empty array needs a same-call nonempty type example');
    }
    const elementType = arrayType.slice('flight::Array<'.length, -1);
    return `${arrayType}{${value.map((item) => renderCppValue(item, elementType)).join(', ')}}`;
  }
  if (typeof value === 'string') return `flight::String(${JSON.stringify(value)})`;
  if (typeof value === 'number') return Number.isInteger(value) ? `${String(value)}.0` : String(value);
  if (typeof value === 'boolean') return String(value);
  throw new Error(`C++ oracle cannot render ${JSON.stringify(value)}`);
}

export function toCppName(value: string): string {
  const name = value.replaceAll(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
  return cppKeywords.has(name) ? `${name}_` : name;
}

function renderCppRecord(value: Readonly<Record<string, unknown>>, type: string): string {
  const fields = Object.entries(value)
    .filter(([key]) => key !== '$type')
    .map(([key, fieldValue]) => `.${toCppName(key)} = ${renderCppValue(fieldValue)}`);
  return `flight::make_ref<${type}>(${type}{${fields.join(', ')}})`;
}

function splitCppTypes(value: string): readonly string[] {
  const types: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '<' || character === '(' || character === '[') depth += 1;
    else if (character === '>' || character === ')' || character === ']') depth -= 1;
    else if (character === ',' && depth === 0) {
      types.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  types.push(value.slice(start).trim());
  return types;
}

function unwrapCppTaskType(type: string | null | undefined): string | undefined {
  return unwrapCppTemplateType(type, 'flight::Task');
}

function unwrapCppTemplateType(type: string | null | undefined, template: string): string | undefined {
  const prefix = `${template}<`;
  return type?.startsWith(prefix) && type.endsWith('>') ? type.slice(prefix.length, -1) : undefined;
}

const cppKeywords = new Set([
  'alignas',
  'alignof',
  'and',
  'and_eq',
  'asm',
  'auto',
  'bitand',
  'bitor',
  'bool',
  'break',
  'case',
  'catch',
  'char',
  'char8_t',
  'char16_t',
  'char32_t',
  'class',
  'co_await',
  'co_return',
  'co_yield',
  'compl',
  'concept',
  'const',
  'const_cast',
  'consteval',
  'constexpr',
  'constinit',
  'continue',
  'decltype',
  'default',
  'delete',
  'do',
  'double',
  'dynamic_cast',
  'else',
  'enum',
  'explicit',
  'export',
  'extern',
  'false',
  'float',
  'for',
  'friend',
  'goto',
  'if',
  'inline',
  'int',
  'long',
  'mutable',
  'namespace',
  'new',
  'noexcept',
  'not',
  'not_eq',
  'nullptr',
  'operator',
  'or',
  'or_eq',
  'private',
  'protected',
  'public',
  'register',
  'reinterpret_cast',
  'requires',
  'return',
  'short',
  'signed',
  'sizeof',
  'static',
  'static_assert',
  'static_cast',
  'struct',
  'switch',
  'template',
  'this',
  'thread_local',
  'throw',
  'true',
  'try',
  'typedef',
  'typeid',
  'typename',
  'union',
  'unsigned',
  'using',
  'virtual',
  'void',
  'volatile',
  'wchar_t',
  'while',
  'xor',
  'xor_eq',
]);
