import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import { normalizeEmittedFile, normalizeEmittedFileContents } from '../../compiler-emission/src/index.js';
import type {
  CompilerBackendModuleFile,
  CompilerBackendModuleFileReplacement,
  CompilerBackendPackageFile,
  CompilerBackendPackageGraphFinalizationResult,
  CompilerBackendPublicBindingRefusal,
  CompilerModuleIdentity,
  CompilerRustModuleEvaluationEmissionFragment,
  CompilerRustSourceTreeFilePlan,
  CompilerRustSourceTreeUnavailableModule,
  CompilerRustSourceTreeFinalizationFailure,
  CompilerRustSourceTreeFinalizationFailureCode,
  CompilerRustSourceTreeFinalizationRequest,
  CompilerRustSourceTreeModuleReemissionRequest,
  CompilerRustSourceTreePlan,
  EmittedFile,
  IrModule,
} from '../../compiler-types/src/index.js';
import { createCompilerRustSourceTreePlan } from './rustSourceTreePlan.js';

export function createCompilerRustSourceTreeFinalization(
  request: Readonly<CompilerRustSourceTreeFinalizationRequest>,
): CompilerBackendPackageGraphFinalizationResult {
  const retainedFilesByModule = createCompilerRustRetainedFilesByModule(request.finalization.moduleFiles);
  const retainedModules = createCompilerRustRetainedSemanticModules(retainedFilesByModule, request.semanticModules);
  const placeholderModules = createCompilerRustPlaceholderModules(
    request.finalization.placeholderModules ?? [],
    retainedFilesByModule,
    createCompilerRustSuppressedPlaceholderKeys(request.finalization.refusals ?? []),
  );
  const unavailableModules = createCompilerRustUnavailableModules(
    request.finalization.refusals ?? [],
    retainedFilesByModule,
    request.semanticModules,
    new Set(placeholderModules.map(getCompilerRustSourceTreeModuleKey)),
  );
  const plan = createCompilerRustSourceTreePlan({
    facade: request.finalization.facade,
    ...(request.moduleResolution ? { moduleResolution: request.moduleResolution } : {}),
    modules: retainedModules,
    ...(placeholderModules.length === 0 ? {} : { placeholderModules }),
    ...(unavailableModules.length === 0 ? {} : { unavailableModules }),
  });
  const emissionSources = createCompilerRustSourceTreeEmissionSources(plan, request.finalizePlan?.(plan) ?? []);
  const sourceFiles = createCompilerRustSourceTreeFinalizationSourceFiles(plan, retainedFilesByModule, retainedModules);
  const moduleFileReplacements = sourceFiles
    .map(({ module, retainedFile, sourceFile }): CompilerBackendModuleFileReplacement => {
      const references = Object.freeze(
        plan.references.filter(
          (reference) =>
            getCompilerRustSourceTreeModuleKey(reference.from) === getCompilerRustSourceTreeModuleKey(module),
        ),
      );
      const reemission: CompilerRustSourceTreeModuleReemissionRequest = {
        module,
        plan,
        references,
        retainedFile,
        sourceFile,
      };
      const file = emitEmittedFileSourceFragmentRust(
        request.reemitModule(Object.freeze(reemission)),
        composeCompilerRustSourceTreeFragments(sourceFile.sourceFragment, emissionSources.get(sourceFile.filePath)),
      );
      if (file.path !== sourceFile.filePath) {
        throw createCompilerRustSourceTreeFinalizationFailure(
          'rust-source-tree-finalization-module-file-mismatch',
          [formatCompilerRustSourceTreeModule(module), file.path, sourceFile.filePath],
          `Rust source-tree re-emission for ${formatCompilerRustSourceTreeModule(module)} returned ${file.path} instead of planned path ${sourceFile.filePath}`,
        );
      }
      return {
        file,
        module: cloneCompilerRustSourceTreeModuleIdentity(module),
        retainedPath: retainedFile.file.path,
      };
    })
    .sort(compareCompilerRustSourceTreeModuleFileReplacements);
  const packageFiles = plan.files
    .flatMap((file): CompilerBackendPackageFile[] => {
      if (file.ownership.kind !== 'skeleton') return [];
      return [
        {
          file: normalizeEmittedFile({
            contents: composeCompilerRustSourceTreeFragments(file.sourceFragment, emissionSources.get(file.filePath)),
            path: file.filePath,
          }),
          owner: { kind: 'package', packageName: file.packageName },
          provenance: file.ownership.provenance
            .map(cloneCompilerRustSourceTreeModuleIdentity)
            .sort(compareCompilerRustSourceTreeModules),
        },
      ];
    })
    .sort((left, right) => compareTextCodeUnits(left.file.path, right.file.path));
  return freezeCompilerRustSourceTreeFinalizationValue(structuredClone({ moduleFileReplacements, packageFiles }));
}

export function emitEmittedFileSourceFragmentRust(file: Readonly<EmittedFile>, sourceFragment: string): EmittedFile {
  const normalized = normalizeEmittedFile(file);
  if (sourceFragment.length === 0) return normalized;
  const fragmentLines = splitCompilerRustSourceTreeLines(normalizeEmittedFileContents(sourceFragment));
  if (
    fragmentLines.some(
      (line) => isCompilerRustGeneratedFileHeader(line) || isCompilerRustCrateInnerAttributeStart(line),
    )
  ) {
    throw createCompilerRustSourceTreeFinalizationFailure(
      'rust-source-tree-finalization-invalid-fragment-placement',
      [normalized.path],
      `Rust source-tree fragment for ${normalized.path} contains a generated header or crate-level inner attribute`,
    );
  }

  const sourceLines = splitCompilerRustSourceTreeLines(normalized.contents);
  let insertionIndex = 0;
  while (isCompilerRustGeneratedFileHeader(sourceLines[insertionIndex] ?? '')) insertionIndex += 1;
  if (insertionIndex === 0) {
    throw createCompilerRustSourceTreeFinalizationFailure(
      'rust-source-tree-finalization-invalid-fragment-placement',
      [normalized.path],
      `Rust source-tree fragment for ${normalized.path} requires a leading generated-file header`,
    );
  }
  while (isCompilerRustCrateInnerAttributeStart(sourceLines[insertionIndex] ?? '')) {
    if (!isCompilerRustCrateInnerAttribute(sourceLines[insertionIndex]!)) {
      throw createCompilerRustSourceTreeFinalizationFailure(
        'rust-source-tree-finalization-invalid-fragment-placement',
        [normalized.path],
        `Rust source-tree fragment for ${normalized.path} follows an incomplete crate-level inner attribute`,
      );
    }
    insertionIndex += 1;
  }
  if (sourceLines.slice(insertionIndex).some(isCompilerRustCrateInnerAttributeStart)) {
    throw createCompilerRustSourceTreeFinalizationFailure(
      'rust-source-tree-finalization-invalid-fragment-placement',
      [normalized.path],
      `Rust source-tree fragment for ${normalized.path} would precede a misplaced crate-level inner attribute`,
    );
  }
  sourceLines.splice(insertionIndex, 0, ...fragmentLines);
  return {
    ...normalized,
    contents: normalizeEmittedFileContents(sourceLines.join('\n')),
  };
}

export function isCompilerRustSourceTreeFinalizationFailure(
  value: unknown,
): value is CompilerRustSourceTreeFinalizationFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'rust-source-tree-finalization' &&
    'code' in value &&
    compilerRustSourceTreeFinalizationFailureCodes.has(value.code as CompilerRustSourceTreeFinalizationFailureCode) &&
    'subjects' in value &&
    Array.isArray(value.subjects) &&
    value.subjects.length > 0 &&
    value.subjects.every((subject) => typeof subject === 'string' && subject.length > 0)
  );
}

interface CompilerRustSourceTreeFinalizationSourceFile {
  readonly module: Readonly<IrModule>;
  readonly retainedFile: Readonly<CompilerBackendModuleFile>;
  readonly sourceFile: Readonly<CompilerRustSourceTreeFilePlan>;
}

function cloneCompilerRustSourceTreeModuleIdentity(module: Readonly<CompilerModuleIdentity>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function compareCompilerRustSourceTreeModuleFileReplacements(
  left: Readonly<CompilerBackendModuleFileReplacement>,
  right: Readonly<CompilerBackendModuleFileReplacement>,
): number {
  return (
    compareCompilerRustSourceTreeModules(left.module, right.module) ||
    compareTextCodeUnits(left.retainedPath, right.retainedPath)
  );
}

function compareCompilerRustSourceTreeModules(
  left: Readonly<CompilerModuleIdentity>,
  right: Readonly<CompilerModuleIdentity>,
): number {
  return (
    compareTextCodeUnits(left.packageName, right.packageName) ||
    compareTextCodeUnits(left.source, right.source) ||
    compareTextCodeUnits(left.name, right.name)
  );
}

function composeCompilerRustSourceTreeFragments(declarations: string, emission: string | undefined): string {
  if (emission === undefined || emission.length === 0) return declarations;
  if (declarations.length === 0) return emission;
  return `${declarations}\n${emission}`;
}

function createCompilerRustSourceTreeEmissionSources(
  plan: Readonly<CompilerRustSourceTreePlan>,
  fragments: readonly Readonly<CompilerRustModuleEvaluationEmissionFragment>[],
): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const fragment of fragments) {
    const file = resolveCompilerRustSourceTreeEmissionFile(plan, fragment);
    if (sources.has(file.filePath)) {
      throw createCompilerRustSourceTreeFinalizationFailure(
        'rust-source-tree-finalization-emission-target-duplicate',
        [file.filePath, formatCompilerRustSourceTreeEmissionLocator(fragment)],
        `Rust module-evaluation emission has more than one fragment for ${file.filePath}`,
      );
    }
    sources.set(file.filePath, fragment.source);
  }
  return sources;
}

function resolveCompilerRustSourceTreeEmissionFile(
  plan: Readonly<CompilerRustSourceTreePlan>,
  fragment: Readonly<CompilerRustModuleEvaluationEmissionFragment>,
): Readonly<CompilerRustSourceTreeFilePlan> {
  const locator = fragment.locator;
  const candidates = plan.files.filter(
    (file) =>
      file.packageName === locator.packageName &&
      isCompilerRustSourceTreeModulePathEqual(file.modulePath, locator.modulePath),
  );
  if (candidates.length === 0) {
    throw createCompilerRustSourceTreeFinalizationFailure(
      'rust-source-tree-finalization-emission-target-missing',
      [formatCompilerRustSourceTreeEmissionLocator(fragment)],
      `Rust module-evaluation emission target ${formatCompilerRustSourceTreeEmissionLocator(fragment)} is absent from the canonical source tree`,
    );
  }
  if (candidates.length > 1) {
    throw createCompilerRustSourceTreeFinalizationFailure(
      'rust-source-tree-finalization-emission-target-duplicate',
      [formatCompilerRustSourceTreeEmissionLocator(fragment), ...candidates.map(({ filePath }) => filePath)],
      `Rust module-evaluation emission target ${formatCompilerRustSourceTreeEmissionLocator(fragment)} resolves to ${String(candidates.length)} canonical files`,
    );
  }
  const file = candidates[0]!;
  if (locator.filePath !== undefined && locator.filePath !== file.filePath) {
    throw createCompilerRustSourceTreeFinalizationFailure(
      'rust-source-tree-finalization-emission-target-path-mismatch',
      [formatCompilerRustSourceTreeEmissionLocator(fragment), locator.filePath, file.filePath],
      `Rust module-evaluation emission target ${formatCompilerRustSourceTreeEmissionLocator(fragment)} names ${locator.filePath} instead of canonical path ${file.filePath}`,
    );
  }
  const requiredOwnership = locator.kind === 'module' || locator.filePath !== undefined ? 'source' : 'skeleton';
  if (file.ownership.kind !== requiredOwnership) {
    throw createCompilerRustSourceTreeFinalizationFailure(
      'rust-source-tree-finalization-emission-target-ownership-mismatch',
      [formatCompilerRustSourceTreeEmissionLocator(fragment), file.filePath, file.ownership.kind],
      `Rust module-evaluation emission target ${formatCompilerRustSourceTreeEmissionLocator(fragment)} requires ${requiredOwnership} ownership at ${file.filePath}, but found ${file.ownership.kind}`,
    );
  }
  return file;
}

function createCompilerRustRetainedFilesByModule(
  retainedFiles: readonly Readonly<CompilerBackendModuleFile>[],
): ReadonlyMap<string, readonly Readonly<CompilerBackendModuleFile>[]> {
  const retainedFilesByModule = new Map<string, readonly Readonly<CompilerBackendModuleFile>[]>();
  for (const retainedFile of retainedFiles) {
    const key = getCompilerRustSourceTreeModuleKey(retainedFile.module);
    retainedFilesByModule.set(key, [...(retainedFilesByModule.get(key) ?? []), retainedFile]);
  }
  return retainedFilesByModule;
}

function createCompilerRustRetainedSemanticModules(
  retainedFilesByModule: ReadonlyMap<string, readonly Readonly<CompilerBackendModuleFile>[]>,
  semanticModules: readonly Readonly<IrModule>[],
): readonly Readonly<IrModule>[] {
  const candidates = new Map<string, readonly Readonly<IrModule>[]>();
  for (const module of semanticModules) {
    const key = getCompilerRustSourceTreeModuleKey(module);
    if (!retainedFilesByModule.has(key)) continue;
    candidates.set(key, [...(candidates.get(key) ?? []), module]);
  }
  return [...retainedFilesByModule.keys()].sort(compareTextCodeUnits).map((key) => {
    const matches = candidates.get(key) ?? [];
    if (matches.length === 0) {
      throw createCompilerRustSourceTreeFinalizationFailure(
        'rust-source-tree-finalization-missing-retained-module',
        [key],
        `Rust source-tree finalization has no semantic module for retained identity ${key}`,
      );
    }
    if (matches.length > 1) {
      throw createCompilerRustSourceTreeFinalizationFailure(
        'rust-source-tree-finalization-duplicate-retained-module',
        [key],
        `Rust source-tree finalization has ${String(matches.length)} semantic modules for retained identity ${key}`,
      );
    }
    return matches[0]!;
  });
}

// What the plan may say about a module it was not given: why it is missing, never how to emit it. A refusal
// outranks selection because the refusal is the reason the module cannot be part of any output.
function createCompilerRustPlaceholderModules(
  modules: readonly Readonly<IrModule>[],
  retainedFilesByModule: ReadonlyMap<string, readonly Readonly<CompilerBackendModuleFile>[]>,
  suppressedKeys: ReadonlySet<string>,
): readonly Readonly<IrModule>[] {
  const byKey = new Map<string, Readonly<IrModule>>();
  for (const module of modules) {
    const key = getCompilerRustSourceTreeModuleKey(module);
    if (retainedFilesByModule.has(key)) {
      throw createCompilerRustSourceTreeFinalizationFailure(
        'rust-source-tree-finalization-placeholder-retained',
        [key],
        `Rust source-tree finalization was asked to place a refusal placeholder for ${key}, but that module retained output`,
      );
    }
    // A duplicate-path refusal means another module owns the same emitted path, so this module cannot
    // own a placeholder file there. It stays reported as refused; the plan simply does not declare a
    // file for it, which keeps the module tree collision-free without inventing a second path.
    if (suppressedKeys.has(key)) continue;
    byKey.set(key, module);
  }
  return [...byKey.entries()].sort(([left], [right]) => compareTextCodeUnits(left, right)).map(([, module]) => module);
}

function createCompilerRustSuppressedPlaceholderKeys(
  refusals: readonly Readonly<CompilerBackendPublicBindingRefusal>[],
): ReadonlySet<string> {
  return new Set(
    refusals
      .filter((refusal) => refusal.code === 'duplicate-emitted-path')
      .map((refusal) => getCompilerRustSourceTreeModuleKey(refusal.module)),
  );
}

function createCompilerRustUnavailableModules(
  refusals: readonly Readonly<CompilerBackendPublicBindingRefusal>[],
  retainedFilesByModule: ReadonlyMap<string, readonly Readonly<CompilerBackendModuleFile>[]>,
  semanticModules: readonly Readonly<IrModule>[],
  placeholderKeys: ReadonlySet<string>,
): readonly CompilerRustSourceTreeUnavailableModule[] {
  const unavailable = new Map<string, CompilerRustSourceTreeUnavailableModule>();
  for (const refusal of refusals) {
    const key = getCompilerRustSourceTreeModuleKey(refusal.module);
    if (placeholderKeys.has(key)) continue;
    unavailable.set(key, {
      code: refusal.code,
      disposition: 'refused',
      message: refusal.message,
      module: cloneCompilerRustSourceTreeModuleIdentity(refusal.module),
    });
  }
  for (const module of semanticModules) {
    const key = getCompilerRustSourceTreeModuleKey(module);
    if (retainedFilesByModule.has(key) || unavailable.has(key) || placeholderKeys.has(key)) continue;
    unavailable.set(key, {
      disposition: 'unselected',
      module: cloneCompilerRustSourceTreeModuleIdentity(module),
    });
  }
  return [...unavailable.entries()]
    .sort(([left], [right]) => compareTextCodeUnits(left, right))
    .map(([, entry]) => entry);
}

function createCompilerRustSourceTreeFinalizationFailure(
  code: CompilerRustSourceTreeFinalizationFailureCode,
  subjects: readonly string[],
  message: string,
): CompilerRustSourceTreeFinalizationFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'rust-source-tree-finalization' as const,
    subjects: [...new Set(subjects)].sort(compareTextCodeUnits),
  });
  failure.name = 'CompilerRustSourceTreeFinalizationError';
  return failure;
}

function createCompilerRustSourceTreeFinalizationSourceFiles(
  plan: Readonly<CompilerRustSourceTreePlan>,
  retainedFilesByModule: ReadonlyMap<string, readonly Readonly<CompilerBackendModuleFile>[]>,
  retainedModules: readonly Readonly<IrModule>[],
): readonly CompilerRustSourceTreeFinalizationSourceFile[] {
  const modulesByIdentity = new Map(
    plan.modules.map((module) => [getCompilerRustSourceTreeModuleKey(module.identity), module] as const),
  );
  const semanticModulesByIdentity = new Map(
    retainedModules.map((module) => [getCompilerRustSourceTreeModuleKey(module), module] as const),
  );
  const sourceOwnerKeys = new Set<string>();
  for (const file of plan.files) {
    if (file.ownership.kind !== 'source') continue;
    const key = getCompilerRustSourceTreeModuleKey(file.ownership.module);
    const retainedFiles = retainedFilesByModule.get(key) ?? [];
    const plannedModule = modulesByIdentity.get(key);
    if (retainedFiles.length !== 1 || plannedModule?.filePath !== file.filePath) {
      throw createCompilerRustSourceTreeFinalizationFailure(
        'rust-source-tree-finalization-module-file-mismatch',
        [key, file.filePath, ...retainedFiles.map((retained) => retained.file.path)],
        `Rust source-tree plan expected one retained file for ${key} at ${file.filePath}, but found ${String(retainedFiles.length)}`,
      );
    }
    sourceOwnerKeys.add(key);
  }
  if (sourceOwnerKeys.size !== retainedFilesByModule.size) {
    const missing = [...retainedFilesByModule.keys()].find((key) => !sourceOwnerKeys.has(key))!;
    throw createCompilerRustSourceTreeFinalizationFailure(
      'rust-source-tree-finalization-module-file-mismatch',
      [missing],
      `Rust source-tree plan has no source-owned file for retained identity ${missing}`,
    );
  }

  return plan.files.flatMap((sourceFile) => {
    if (sourceFile.ownership.kind !== 'source') return [];
    const key = getCompilerRustSourceTreeModuleKey(sourceFile.ownership.module);
    return [
      {
        module: semanticModulesByIdentity.get(key)!,
        retainedFile: retainedFilesByModule.get(key)![0]!,
        sourceFile,
      },
    ];
  });
}

function formatCompilerRustSourceTreeModule(module: Readonly<CompilerModuleIdentity>): string {
  return `${module.packageName}/${module.source}#${module.name}`;
}

function formatCompilerRustSourceTreeEmissionLocator(
  fragment: Readonly<CompilerRustModuleEvaluationEmissionFragment>,
): string {
  const locator = fragment.locator;
  return `${locator.packageName}:${locator.modulePath.length === 0 ? '<root>' : locator.modulePath.join('::')}`;
}

function freezeCompilerRustSourceTreeFinalizationValue<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) freezeCompilerRustSourceTreeFinalizationValue(member);
  }
  return value;
}

function getCompilerRustSourceTreeModuleKey(module: Readonly<CompilerModuleIdentity>): string {
  return JSON.stringify([module.packageName, module.source, module.name]);
}

function isCompilerRustSourceTreeModulePathEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function isCompilerRustCrateInnerAttribute(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('#![') && trimmed.endsWith(']') && trimmed.length > 4;
}

function isCompilerRustCrateInnerAttributeStart(line: string): boolean {
  return line.trim().startsWith('#![');
}

function isCompilerRustGeneratedFileHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('// Generated by @flighthq/tool-compiler from ') && trimmed.endsWith('. Do not edit.');
}

function splitCompilerRustSourceTreeLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

const compilerRustSourceTreeFinalizationFailureCodes: ReadonlySet<CompilerRustSourceTreeFinalizationFailureCode> =
  new Set([
    'rust-source-tree-finalization-duplicate-retained-module',
    'rust-source-tree-finalization-emission-target-duplicate',
    'rust-source-tree-finalization-emission-target-missing',
    'rust-source-tree-finalization-emission-target-ownership-mismatch',
    'rust-source-tree-finalization-emission-target-path-mismatch',
    'rust-source-tree-finalization-invalid-fragment-placement',
    'rust-source-tree-finalization-missing-retained-module',
    'rust-source-tree-finalization-module-file-mismatch',
    'rust-source-tree-finalization-placeholder-retained',
  ]);
