import path from 'node:path';

import { normalizePathPortable } from '../../compiler-canonical-form/src/index.js';

export function convertPackageNameToHaxePackageName(packageName: string, rootPackage = 'flighthq'): string {
  if (!/^[a-z_][A-Za-z0-9_]*(?:\.[a-z_][A-Za-z0-9_]*)*$/u.test(rootPackage)) {
    throw new Error(`Cannot map invalid Haxe root package: ${rootPackage}`);
  }
  const scopeSeparator = packageName.indexOf('/');
  const bareName = packageName.startsWith('@')
    ? scopeSeparator > 1
      ? packageName.slice(scopeSeparator + 1)
      : ''
    : packageName;
  if (bareName.includes('/')) throw new Error(`Cannot map invalid npm package name: ${packageName}`);
  const parts = bareName.split(/[^A-Za-z0-9]+/u).filter(Boolean);
  if (parts.length === 0) throw new Error(`Cannot map empty npm package name: ${packageName}`);
  const converted = parts
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`,
    )
    .join('');
  const segment = /^\d/u.test(converted) ? `_${converted}` : converted;
  return `${rootPackage}.${segment}`;
}

export function convertSourcePathToHaxeModuleName(sourcePath: string): string | undefined {
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
  return pascalCase(filename);
}

function pascalCase(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean);
  const result = words.map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`).join('');
  if (result.length === 0) return '_Generated';
  return /^\d/u.test(result) ? `_${result}` : result;
}
