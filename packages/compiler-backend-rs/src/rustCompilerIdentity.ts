import path from 'node:path';

import { normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import type { IrBindingIdentity, IrModule, IrTypeBindingIdentity } from '../../compiler-types/src/index.js';

export function convertPackageNameToRustCrateName(packageName: string): string {
  const scopeSeparator = packageName.indexOf('/');
  const scoped = packageName.startsWith('@');
  const scope = scoped && scopeSeparator > 1 ? packageName.slice(1, scopeSeparator) : '';
  const bareName = scoped ? (scopeSeparator > 1 ? packageName.slice(scopeSeparator + 1) : '') : packageName;
  if (bareName.length === 0) throw new Error(`Cannot map empty npm package name: ${packageName}`);
  if (bareName.includes('/')) throw new Error(`Cannot map invalid npm package name: ${packageName}`);
  const normalizedScope = normalizeRustCrateNamePart(scoped ? scope : 'flighthq');
  const normalizedBareName = normalizeRustCrateNamePart(bareName);
  if (normalizedScope.length === 0 || normalizedBareName.length === 0) {
    throw new Error(`Cannot map empty npm package name: ${packageName}`);
  }
  return `${normalizedScope}-${normalizedBareName}`;
}

function normalizeRustCrateNamePart(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase();
}

export function convertSourcePathToRustModuleName(sourcePath: string): string | undefined {
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
  return isRustCompilerKeyword(moduleName) ? `${moduleName}_` : moduleName;
}

// The spelling rules one Rust binding name follows. One record, so the emitter and the public-binding
// plan cannot disagree about a name that is later collision-suffixed: a constant is screaming snake, a
// type, class, enum, or uppercase import is type-shaped, and everything else is a value name.
export function createRustBindingNameRules(): Readonly<{
  pascalCase: (value: string) => string;
  safeRustTypeName: (name: string) => string;
  safeRustValueName: (name: string) => string;
  snakeCase: (value: string) => string;
}> {
  return { pascalCase, safeRustTypeName, safeRustValueName, snakeCase: bindingNameSnakeCase };
}

export function createRustCompilerModuleLocator(
  identity: Readonly<{ packageName: string; source: string }>,
  options: Readonly<{ multiPackage: boolean }>,
): RustCompilerModuleLocator {
  const source = normalizePathPortable(identity.source);
  const segments = source.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  const packageLeaf = identity.packageName.startsWith('@')
    ? identity.packageName.slice(identity.packageName.indexOf('/') + 1)
    : identity.packageName;
  const packageRoot = segments.findIndex(
    (segment, index) => segment === 'packages' && segments[index + 1] === packageLeaf && segments[index + 2] === 'src',
  );
  const sourceRoot = packageRoot >= 0 ? packageRoot + 2 : segments.indexOf('src');
  const relative = sourceRoot >= 0 && sourceRoot < segments.length - 1 ? segments.slice(sourceRoot + 1) : segments;
  const filename = relative.at(-1);
  if (!filename || !/\.tsx?$/u.test(filename) || /\.d\.tsx?$/u.test(filename)) {
    throw new TypeError(`Rust module locator requires a runtime TypeScript source: ${identity.source}`);
  }
  const stem = filename.replace(/\.tsx?$/u, '');
  const directories = relative.slice(0, -1).map(convertRustCompilerModuleSegment);
  const index = stem.toLowerCase() === 'index';
  const modulePath = index ? directories : [...directories, convertRustCompilerModuleSegment(stem)];
  const crateSourcePrefix = options.multiPackage
    ? `${convertPackageNameToRustCrateName(identity.packageName)}/src/`
    : '';
  const moduleFilePath = modulePath.join('/');
  const filePath =
    modulePath.length === 0
      ? `${crateSourcePrefix}lib.rs`
      : index
        ? `${crateSourcePrefix}${moduleFilePath}/mod.rs`
        : `${crateSourcePrefix}${moduleFilePath}.rs`;
  return { filePath, modulePath, source };
}

export function getRustConstantBindingIds(module: Readonly<IrModule>): ReadonlySet<string> {
  return new Set(
    module.declarations.flatMap((declaration) =>
      declaration.kind === 'variable' && !declaration.mutable && !('pattern' in declaration)
        ? [declaration.binding.id]
        : [],
    ),
  );
}

// The preferred name a binding starts from before collision suffixes are applied. This is the single
// rule both the emitter allocation and the public-binding-plan allocation call.
export function getRustPreferredBindingName(
  binding: Readonly<IrBindingIdentity | IrTypeBindingIdentity>,
  constants: ReadonlySet<string>,
): string {
  if (constants.has(binding.id)) return screamingSnakeCase(binding.name);
  return binding.space === 'type' ||
    binding.kind === 'class' ||
    binding.kind === 'enum' ||
    (binding.kind === 'import' && /^[A-Z]/u.test(binding.name))
    ? safeRustTypeName(binding.name)
    : safeRustValueName(binding.name);
}

export function isRustCompilerKeyword(value: string): boolean {
  return rustCompilerKeywords.has(value);
}

interface RustCompilerModuleLocator {
  readonly filePath: string;
  readonly modulePath: readonly string[];
  readonly source: string;
}

function convertRustCompilerModuleSegment(segment: string): string {
  const normalized = snakeCase(segment.normalize('NFC'));
  if (normalized.length === 0) throw new TypeError(`Rust module path segment is empty after normalization: ${segment}`);
  const identifier = /^\d/u.test(normalized) ? `_${normalized}` : normalized;
  return isRustCompilerKeyword(identifier) ? `${identifier}_` : identifier;
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
}

function screamingSnakeCase(value: string): string {
  return bindingNameSnakeCase(value).toUpperCase();
}

// Binding-name casing splits acronym boundaries, unlike the source-path casing above: `HTTPServer` is
// `http_server`, where a module segment is a path word.
function bindingNameSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .replace(/[-\s]+/gu, '_')
    .toLowerCase();
}

function pascalCase(value: string): string {
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
}

function safeRustTypeName(name: string): string {
  const stripped = name.startsWith('#') ? name.slice(1) : name;
  const value = stripped
    .split('.')
    .map((segment) => pascalCase(segment))
    .join('::');
  return isRustCompilerKeyword(value) ? `${value}_` : value;
}

function safeRustValueName(name: string): string {
  if (name === 'this') return 'self';
  const stripped = name.startsWith('#') ? name.slice(1) : name;
  const value = bindingNameSnakeCase(stripped);
  return isRustCompilerKeyword(value) ? `${value}_` : value;
}

const rustCompilerKeywords = new Set([
  '_',
  'abstract',
  'as',
  'async',
  'await',
  'become',
  'box',
  'break',
  'const',
  'continue',
  'crate',
  'do',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'final',
  'fn',
  'for',
  'gen',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'macro',
  'macro_rules',
  'match',
  'mod',
  'move',
  'mut',
  'override',
  'priv',
  'pub',
  'raw',
  'ref',
  'return',
  'safe',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'try',
  'type',
  'typeof',
  'union',
  'unsafe',
  'unsized',
  'use',
  'virtual',
  'where',
  'while',
  'yield',
]);
