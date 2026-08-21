import path from 'node:path';

import { normalizePathPortable } from '../../compiler-canonical-form/src/index.js';

export function convertPackageNameToRustCrateName(packageName: string): string {
  const scopeSeparator = packageName.indexOf('/');
  const bareName = packageName.startsWith('@')
    ? scopeSeparator > 1
      ? packageName.slice(scopeSeparator + 1)
      : ''
    : packageName;
  if (bareName.length === 0) throw new Error(`Cannot map empty npm package name: ${packageName}`);
  if (bareName.includes('/')) throw new Error(`Cannot map invalid npm package name: ${packageName}`);
  const crateName = bareName
    .replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase();
  if (crateName.length === 0) throw new Error(`Cannot map empty npm package name: ${packageName}`);
  return `flighthq-${crateName}`;
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

export function isRustCompilerKeyword(value: string): boolean {
  return rustCompilerKeywords.has(value);
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
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
