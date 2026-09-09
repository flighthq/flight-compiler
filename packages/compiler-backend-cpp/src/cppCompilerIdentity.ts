import path from 'node:path';

import { normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import type { CppCompilerPackageTarget } from '../../compiler-types/src/index.js';

export function convertPackageNameToCppNamespace(packageName: string): string {
  const scopeSeparator = packageName.indexOf('/');
  const bareName = packageName.startsWith('@')
    ? scopeSeparator > 1
      ? packageName.slice(scopeSeparator + 1)
      : ''
    : packageName;
  if (bareName.length === 0) throw new Error(`Cannot map empty npm package name: ${packageName}`);
  if (bareName.includes('/')) throw new Error(`Cannot map invalid npm package name: ${packageName}`);
  const namespaceName = bareName
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
  if (namespaceName.length === 0) throw new Error(`Cannot map empty npm package name: ${packageName}`);
  return `flighthq_${namespaceName}`;
}

export function convertSourcePathToCppFileName(sourcePath: string): string | undefined {
  const portableSourcePath = normalizePathPortable(sourcePath);
  const basename = path.posix.basename(portableSourcePath);
  if (!/\.tsx?$/u.test(basename)) throw new Error(`Cannot map non-TypeScript source path: ${sourcePath}`);
  const filename = basename.replace(/\.tsx?$/u, '');
  if (filename.length === 0 || /\.d$/iu.test(filename)) {
    throw new Error(`Cannot map non-runtime TypeScript source path: ${sourcePath}`);
  }
  if (
    filename.toLowerCase() === 'index' ||
    filename.toLowerCase() === 'internal' ||
    /(?:^|[._-])(?:spec|test)(?:$|[._-])/iu.test(filename) ||
    /test(?:helper|util)/iu.test(filename)
  ) {
    return undefined;
  }
  const moduleName = snakeCase(filename);
  if (moduleName.length === 0) throw new Error(`Cannot map empty TypeScript source name: ${sourcePath}`);
  if (/^\d/u.test(moduleName)) return `_${moduleName}`;
  return isCppCompilerKeyword(moduleName) ? `${moduleName}_` : moduleName;
}

export function getCppCompilerPackageIncludePrefix(
  packageName: string,
  packageTargets: Readonly<Record<string, Readonly<CppCompilerPackageTarget>>> = {},
): string | undefined {
  const target = packageTargets[packageName];
  if (!target) return undefined;
  if (!isCppCompilerIncludePrefix(target.includePrefix)) {
    throw new TypeError(`Invalid C++ include prefix for ${packageName}: ${target.includePrefix}`);
  }
  return target.includePrefix;
}

export function getCppCompilerPackageNamespace(
  packageName: string,
  packageTargets: Readonly<Record<string, Readonly<CppCompilerPackageTarget>>> = {},
): string {
  const target = packageTargets[packageName];
  if (!target) return convertPackageNameToCppNamespace(packageName);
  const components = target.namespace.split('::');
  if (
    components.length === 0 ||
    components.some((component) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(component) || isCppCompilerKeyword(component))
  ) {
    throw new TypeError(`Invalid C++ namespace for ${packageName}: ${target.namespace}`);
  }
  return target.namespace;
}

export function isCppCompilerKeyword(value: string): boolean {
  return cppCompilerKeywords.has(value);
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
}

function isCppCompilerIncludePrefix(value: string): boolean {
  return (
    value.length > 0 &&
    value === normalizePathPortable(value) &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !/[<>"\r\n]/u.test(value) &&
    value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

const cppCompilerKeywords = new Set([
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
