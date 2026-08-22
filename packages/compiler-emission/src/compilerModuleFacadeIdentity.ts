import {
  compareTextCodeUnits,
  normalizeCompilerStructuralValueCanonical,
  normalizePathPortable,
} from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerModuleFacadeFailure,
  CompilerModuleFacadeFailureCode,
  CompilerModuleFacadeIdentity,
  CompilerModuleFacadeLane,
  CompilerModuleFacadeSource,
  CompilerModuleIdentity,
  IrExport,
  IrModule,
} from '../../compiler-types/src/index.js';

export function createCompilerModuleFacadeIdentities(
  module: Readonly<IrModule>,
): readonly CompilerModuleFacadeIdentity[] {
  const moduleIdentity = normalizeCompilerModuleIdentity(module);
  if (!Array.isArray(module.exports)) {
    throw createCompilerModuleFacadeFailure('invalid-facade-module', 'exports', 'Module exports must be an array');
  }
  const identities = module.exports.map((exported, index) =>
    createCompilerModuleFacadeIdentity(exported, moduleIdentity, index),
  );
  const seen = new Set<string>();
  for (const identity of identities) {
    if (seen.has(identity.identity)) {
      throw createCompilerModuleFacadeFailure(
        'duplicate-facade-identity',
        identity.identity,
        `Module facade identity is duplicated: ${identity.identity}`,
      );
    }
    seen.add(identity.identity);
  }
  return Object.freeze(identities.sort((left, right) => compareTextCodeUnits(left.identity, right.identity)));
}

export function isCompilerModuleFacadeFailure(value: unknown): value is CompilerModuleFacadeFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'compiler-module-facade' &&
    'code' in value &&
    compilerModuleFacadeFailureCodes.has(value.code as CompilerModuleFacadeFailureCode) &&
    'subject' in value &&
    typeof value.subject === 'string' &&
    value.subject.length > 0
  );
}

function createCompilerModuleFacadeIdentity(
  exported: Readonly<IrExport>,
  module: Readonly<CompilerModuleIdentity>,
  index: number,
): CompilerModuleFacadeIdentity {
  if (!exported || typeof exported !== 'object' || Array.isArray(exported) || !('kind' in exported)) {
    throwInvalidIrExport(index);
  }
  let exportName: string;
  let lane: CompilerModuleFacadeLane;
  let source: CompilerModuleFacadeSource;
  switch (exported.kind) {
    case 'all':
      validateIrExportFields(exported, ['kind', 'specifier', 'typeOnly'], index);
      validateIrExportSpecifier(exported.specifier, index);
      validateIrExportTypeOnly(exported.typeOnly, index);
      exportName = '*';
      lane = exported.typeOnly ? 'type' : 'value';
      source = Object.freeze({ kind: 'module-all', specifier: exported.specifier });
      break;
    case 'default':
      validateIrExportFields(exported, ['expression', 'kind'], index);
      if (!exported.expression || typeof exported.expression !== 'object' || Array.isArray(exported.expression)) {
        throwInvalidIrExport(index);
      }
      exportName = 'default';
      lane = 'value';
      source = Object.freeze({ kind: 'local-expression' });
      break;
    case 'local':
      validateIrExportFields(exported, ['binding', 'exported', 'kind', 'typeOnly'], index);
      validateIrExportName(exported.exported, index);
      validateIrExportTypeOnly(exported.typeOnly, index);
      if (
        !exported.binding ||
        typeof exported.binding !== 'object' ||
        typeof exported.binding.id !== 'string' ||
        exported.binding.id.length === 0
      ) {
        throwInvalidIrExport(index);
      }
      exportName = exported.exported;
      lane = exported.typeOnly ? 'type' : 'value';
      source = Object.freeze({ bindingId: exported.binding.id, kind: 'local-binding' });
      break;
    case 'namespace':
      validateIrExportFields(exported, ['exported', 'kind', 'specifier', 'typeOnly'], index);
      validateIrExportName(exported.exported, index);
      validateIrExportSpecifier(exported.specifier, index);
      validateIrExportTypeOnly(exported.typeOnly, index);
      exportName = exported.exported;
      lane = exported.typeOnly ? 'type' : 'value';
      source = Object.freeze({ kind: 'module-namespace', specifier: exported.specifier });
      break;
    case 'reexport':
      validateIrExportFields(exported, ['exported', 'imported', 'kind', 'specifier', 'typeOnly'], index);
      validateIrExportName(exported.exported, index);
      validateIrExportName(exported.imported, index);
      validateIrExportSpecifier(exported.specifier, index);
      validateIrExportTypeOnly(exported.typeOnly, index);
      exportName = exported.exported;
      lane = exported.typeOnly ? 'type' : 'value';
      source = Object.freeze({ imported: exported.imported, kind: 'module-binding', specifier: exported.specifier });
      break;
    default:
      throwInvalidIrExport(index);
  }
  const identity = createCompilerModuleFacadeIdentityText(module, exportName, lane, source);
  return Object.freeze({ exportName, identity, lane, module, source });
}

function createCompilerModuleFacadeIdentityText(
  module: Readonly<CompilerModuleIdentity>,
  exportName: string,
  lane: CompilerModuleFacadeLane,
  source: Readonly<CompilerModuleFacadeSource>,
): string {
  const publicSlot = {
    exportName,
    lane,
    module,
    ...(source.kind === 'module-all' ? { specifier: source.specifier } : {}),
  };
  return `module-facade:${normalizeCompilerStructuralValueCanonical(publicSlot)}`;
}

function normalizeCompilerModuleIdentity(module: Readonly<IrModule>): CompilerModuleIdentity {
  if (
    !module ||
    typeof module !== 'object' ||
    typeof module.name !== 'string' ||
    module.name.length === 0 ||
    typeof module.packageName !== 'string' ||
    module.packageName.length === 0 ||
    typeof module.source !== 'string' ||
    module.source.length === 0
  ) {
    throw createCompilerModuleFacadeFailure(
      'invalid-facade-module',
      'module',
      'Module facade identity requires nonempty module name, package name, and source',
    );
  }
  return Object.freeze({
    name: module.name,
    packageName: module.packageName,
    source: normalizePathPortable(module.source),
  });
}

function validateIrExportFields(exported: Readonly<IrExport>, fields: readonly string[], index: number): void {
  const keys = Object.keys(exported).sort(compareTextCodeUnits);
  const expected = [...fields].sort(compareTextCodeUnits);
  if (keys.length !== expected.length || keys.some((key, keyIndex) => key !== expected[keyIndex])) {
    throwInvalidIrExport(index);
  }
}

function validateIrExportName(value: string, index: number): void {
  if (typeof value !== 'string' || value.length === 0) throwInvalidIrExport(index);
}

function validateIrExportSpecifier(value: string, index: number): void {
  if (typeof value !== 'string' || value.length === 0) throwInvalidIrExport(index);
}

function validateIrExportTypeOnly(value: boolean, index: number): void {
  if (typeof value !== 'boolean') throwInvalidIrExport(index);
}

function throwInvalidIrExport(index: number): never {
  const subject = `exports[${String(index)}]`;
  throw createCompilerModuleFacadeFailure(
    'invalid-facade-export',
    subject,
    `Module facade export is malformed at ${subject}`,
  );
}

function createCompilerModuleFacadeFailure(
  code: CompilerModuleFacadeFailureCode,
  subject: string,
  message: string,
): CompilerModuleFacadeFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'compiler-module-facade' as const,
    subject,
  });
  failure.name = 'CompilerModuleFacadeError';
  return failure;
}

const compilerModuleFacadeFailureCodes = new Set<CompilerModuleFacadeFailureCode>([
  'duplicate-facade-identity',
  'invalid-facade-export',
  'invalid-facade-module',
]);
