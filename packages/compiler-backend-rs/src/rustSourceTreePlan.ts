import path from 'node:path';

import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerModuleIdentity,
  CompilerModuleResolutionEdge,
  CompilerRustSourceTreeFilePlan,
  CompilerRustSourceTreeModuleDeclaration,
  CompilerRustSourceTreePlan,
  CompilerRustSourceTreePlanInput,
  CompilerRustSourceTreePlanningFailure,
  CompilerRustSourceTreePlanningFailureCode,
  CompilerRustSourceTreeReferencePlan,
  CompilerRustSourceTreeUnavailableModule,
  IrModule,
} from '../../compiler-types/src/index.js';
import { convertPackageNameToRustCrateName, createRustCompilerModuleLocator } from './rustCompilerIdentity.js';

export function createCompilerRustSourceTreePlan(
  input: Readonly<CompilerRustSourceTreePlanInput>,
): CompilerRustSourceTreePlan {
  if (input.facade.schema !== 'flight-compiler-module-facade/1') {
    throw new TypeError('Rust source-tree planning requires flight-compiler-module-facade/1');
  }
  if (input.moduleResolution && input.moduleResolution.schema !== 'flight-compiler-module-resolution/1') {
    throw new TypeError('Rust source-tree planning requires flight-compiler-module-resolution/1');
  }

  const packageNames = [...new Set(input.modules.map((module) => module.packageName.normalize('NFC')))].sort(
    compareTextCodeUnits,
  );
  const multiPackage = packageNames.length > 1;
  assertRustSourceTreeCratesUnique(packageNames);
  const modules = input.modules
    .map((module): RustSourceTreeModuleRecord => {
      const identity = normalizeRustSourceTreeModuleIdentity(module);
      return {
        identity,
        locator: createRustCompilerModuleLocator(identity, { multiPackage }),
        module,
        placeholder: false,
      };
    })
    .concat(
      (input.placeholderModules ?? []).map((module): RustSourceTreeModuleRecord => {
        const identity = normalizeRustSourceTreeModuleIdentity(module);
        return {
          identity,
          locator: createRustCompilerModuleLocator(identity, { multiPackage }),
          module,
          placeholder: true,
        };
      }),
    )
    .sort((left, right) =>
      compareTextCodeUnits(getRustSourceTreeModuleKey(left.identity), getRustSourceTreeModuleKey(right.identity)),
    );
  assertRustSourceTreeModulesUnique(modules);
  const nodes = createRustSourceTreeNodes(modules);
  const publicPaths = collectRustSourceTreePublicModulePaths(input, modules);
  const files = createRustSourceTreeFiles(nodes, modules, publicPaths, multiPackage);
  assertRustSourceTreeFilesUnique(files);
  const references = createRustSourceTreeReferences(input, modules, multiPackage);

  return cloneAndFreezeRustSourceTreePlan({
    files,
    modules: modules.map(({ identity, locator }) => ({
      filePath: locator.filePath,
      identity,
      modulePath: locator.modulePath,
    })),
    references,
    schema: 'flight-rust-source-tree-plan/1',
  });
}

export function isCompilerRustSourceTreePlanningFailure(
  value: unknown,
): value is CompilerRustSourceTreePlanningFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'rust-source-tree-planning' &&
    'code' in value &&
    rustSourceTreePlanningFailureCodes.has(value.code as CompilerRustSourceTreePlanningFailureCode) &&
    'subjects' in value &&
    Array.isArray(value.subjects) &&
    value.subjects.length > 0 &&
    value.subjects.every((subject) => typeof subject === 'string' && subject.length > 0)
  );
}

interface RustSourceTreeModuleRecord {
  readonly identity: CompilerModuleIdentity;
  readonly locator: Readonly<{ filePath: string; modulePath: readonly string[]; source: string }>;
  readonly module: Readonly<IrModule>;
  /** True when the run will write a refusal placeholder at this path instead of re-emitting retained output. */
  readonly placeholder: boolean;
}

interface RustSourceTreeNode {
  readonly modulePath: readonly string[];
  readonly owner?: RustSourceTreeModuleRecord | undefined;
  readonly packageName: string;
}

function assertRustSourceTreeCratesUnique(packageNames: readonly string[]): void {
  const crates = new Map<string, string[]>();
  for (const packageName of packageNames) {
    const cargoName = convertPackageNameToRustCrateName(packageName);
    crates.set(cargoName, [...(crates.get(cargoName) ?? []), packageName]);
  }
  for (const [cargoName, packages] of crates) {
    if (packages.length < 2) continue;
    throw createRustSourceTreePlanningFailure(
      'rust-source-tree-crate-collision',
      packages,
      `Rust source-tree crate path ${cargoName} is shared by ${packages.join(', ')}`,
    );
  }
}

function assertRustSourceTreeFilesUnique(files: readonly Readonly<CompilerRustSourceTreeFilePlan>[]): void {
  const paths = new Map<string, CompilerRustSourceTreeFilePlan[]>();
  for (const file of files) {
    const key = file.filePath.normalize('NFC').toLowerCase();
    paths.set(key, [...(paths.get(key) ?? []), file]);
  }
  for (const [filePath, collisions] of paths) {
    if (collisions.length < 2) continue;
    const subjects = collisions.map((file) => formatRustSourceTreeFileOwner(file));
    throw createRustSourceTreePlanningFailure(
      'rust-source-tree-file-collision',
      subjects,
      `Rust source-tree file path ${filePath} is shared by ${subjects.join(', ')}`,
    );
  }
}

function assertRustSourceTreeModulesUnique(modules: readonly RustSourceTreeModuleRecord[]): void {
  const paths = new Map<string, RustSourceTreeModuleRecord[]>();
  for (const module of modules) {
    const key = getRustSourceTreeNodeKey(module.identity.packageName, module.locator.modulePath);
    paths.set(key, [...(paths.get(key) ?? []), module]);
  }
  for (const [modulePath, collisions] of paths) {
    if (collisions.length < 2) continue;
    const subjects = collisions.map((module) => getRustSourceTreeModuleKey(module.identity));
    throw createRustSourceTreePlanningFailure(
      'rust-source-tree-module-collision',
      subjects,
      `Rust source-tree module path ${modulePath.replaceAll('\0', '::')} is shared by ${subjects.join(', ')}`,
    );
  }
}

function cloneAndFreezeRustSourceTreePlan(plan: CompilerRustSourceTreePlan): CompilerRustSourceTreePlan {
  const clone = structuredClone(plan);
  return freezeRustSourceTreeValue(clone);
}

function collectRustSourceTreePublicModulePaths(
  input: Readonly<CompilerRustSourceTreePlanInput>,
  modules: readonly RustSourceTreeModuleRecord[],
): ReadonlyMap<string, readonly (readonly string[])[]> {
  const byIdentity = new Map(modules.map((module) => [getRustSourceTreeModuleKey(module.identity), module]));
  const publicIdentities = input.facade.modules.flatMap((facadeModule) => [
    facadeModule.module,
    ...facadeModule.slots.flatMap((slot) => (slot.route.kind === 'namespace' ? [slot.route.module] : [])),
  ]);
  const paths = new Map<string, readonly string[][]>();
  for (const identity of publicIdentities) {
    const normalized = normalizeRustSourceTreeModuleIdentity(identity);
    const module = byIdentity.get(getRustSourceTreeModuleKey(normalized));
    if (!module) {
      const subject = getRustSourceTreeModuleKey(normalized);
      throw createRustSourceTreePlanningFailure(
        'rust-source-tree-public-module-missing',
        [subject],
        `Rust source-tree public module is absent from the package graph: ${subject}`,
      );
    }
    const existing = paths.get(module.identity.packageName) ?? [];
    if (!existing.some((candidate) => isRustSourceTreeModulePathEqual(candidate, module.locator.modulePath))) {
      paths.set(module.identity.packageName, [...existing, [...module.locator.modulePath]]);
    }
  }
  return paths;
}

function createRustSourceTreeFiles(
  nodes: readonly RustSourceTreeNode[],
  modules: readonly RustSourceTreeModuleRecord[],
  publicPaths: ReadonlyMap<string, readonly (readonly string[])[]>,
  multiPackage: boolean,
): readonly CompilerRustSourceTreeFilePlan[] {
  const files = nodes.map((node): CompilerRustSourceTreeFilePlan => {
    const children = nodes
      .filter(
        (candidate) =>
          candidate.packageName === node.packageName &&
          candidate.modulePath.length === node.modulePath.length + 1 &&
          isRustSourceTreeModulePathPrefix(node.modulePath, candidate.modulePath),
      )
      .map((child): CompilerRustSourceTreeModuleDeclaration => {
        const name = child.modulePath.at(-1)!;
        const public_ = (publicPaths.get(node.packageName) ?? []).some((candidate) =>
          isRustSourceTreeModulePathPrefix(child.modulePath, candidate),
        );
        return {
          modulePath: [...child.modulePath],
          name,
          visibility: public_ ? 'public' : 'private',
        };
      })
      .sort((left, right) => compareTextCodeUnits(left.name, right.name));
    const locator = node.owner?.locator ?? createRustSourceTreeSkeletonLocator(node, multiPackage);
    const sourceFragment = children
      .map((child) => `${child.visibility === 'public' ? 'pub ' : ''}mod ${child.name};`)
      .join('\n');
    const ownership = node.owner
      ? node.owner.placeholder
        ? ({ kind: 'placeholder', module: node.owner.identity } as const)
        : ({ kind: 'source', module: node.owner.identity } as const)
      : ({
          kind: 'skeleton',
          provenance: modules
            .filter(
              (module) =>
                module.identity.packageName === node.packageName &&
                isRustSourceTreeModulePathPrefix(node.modulePath, module.locator.modulePath),
            )
            .map((module) => module.identity),
        } as const);
    return {
      declarations: children,
      filePath: locator.filePath,
      modulePath: [...node.modulePath],
      ownership,
      packageName: node.packageName,
      sourceFragment,
    };
  });
  return files.sort((left, right) => compareTextCodeUnits(left.filePath, right.filePath));
}

function createRustSourceTreeNodes(modules: readonly RustSourceTreeModuleRecord[]): readonly RustSourceTreeNode[] {
  const nodes = new Map<string, RustSourceTreeNode>();
  for (const module of modules) {
    for (let length = 0; length <= module.locator.modulePath.length; length += 1) {
      const modulePath = module.locator.modulePath.slice(0, length);
      const key = getRustSourceTreeNodeKey(module.identity.packageName, modulePath);
      const existing = nodes.get(key);
      nodes.set(key, {
        modulePath,
        ...(length === module.locator.modulePath.length
          ? { owner: module }
          : existing?.owner
            ? { owner: existing.owner }
            : {}),
        packageName: module.identity.packageName,
      });
    }
  }
  return [...nodes.values()].sort((left, right) =>
    compareTextCodeUnits(
      getRustSourceTreeNodeKey(left.packageName, left.modulePath),
      getRustSourceTreeNodeKey(right.packageName, right.modulePath),
    ),
  );
}

function createRustSourceTreePlanningFailure(
  code: CompilerRustSourceTreePlanningFailureCode,
  subjects: readonly string[],
  message: string,
): CompilerRustSourceTreePlanningFailure {
  const failure = Object.assign(new Error(message), {
    code,
    kind: 'rust-source-tree-planning' as const,
    subjects: [...subjects].sort(compareTextCodeUnits),
  });
  failure.name = 'CompilerRustSourceTreePlanningError';
  return failure;
}

function createRustSourceTreeReferences(
  input: Readonly<CompilerRustSourceTreePlanInput>,
  modules: readonly RustSourceTreeModuleRecord[],
  multiPackage: boolean,
): readonly CompilerRustSourceTreeReferencePlan[] {
  const unavailable = createRustSourceTreeUnavailableIndex(input.unavailableModules ?? []);
  const references = modules.flatMap((module) => {
    const specifiers = new Set([
      ...module.module.imports.map((imported) => imported.specifier),
      ...module.module.exports.flatMap((exported) => ('specifier' in exported ? [exported.specifier] : [])),
    ]);
    return [...specifiers].sort(compareTextCodeUnits).flatMap((specifier) => {
      const edges = getRustSourceTreeResolutionEdges(module.identity, specifier, input.moduleResolution?.edges ?? []);
      if (edges.length > 0) {
        return createRustSourceTreeEdgeReferences(module, specifier, edges, modules, multiPackage, unavailable);
      }
      if (!specifier.startsWith('.')) return [];
      const candidates = resolveRustSourceTreeRelativeModules(module, specifier, modules);
      if (candidates.length !== 1) {
        const importerSubject = formatRustSourceTreeModuleSubject(module.identity);
        if (candidates.length > 1) {
          throw createRustSourceTreePlanningFailure(
            'rust-source-tree-import-ambiguity',
            [
              getRustSourceTreeModuleKey(module.identity),
              ...candidates.map((item) => getRustSourceTreeModuleKey(item.identity)),
            ],
            `Rust source-tree relative import ${specifier} from ${importerSubject} resolved to ${String(candidates.length)} modules`,
          );
        }
        const unavailableMatches = resolveRustSourceTreeUnavailableRelativeModules(module, specifier, unavailable);
        if (unavailableMatches.length > 1) {
          throw createRustSourceTreePlanningFailure(
            'rust-source-tree-import-ambiguity',
            [
              getRustSourceTreeModuleKey(module.identity),
              ...unavailableMatches.map((entry) => getRustSourceTreeModuleKey(entry.module)),
            ],
            `Rust source-tree relative import ${specifier} from ${importerSubject} resolved to ${String(unavailableMatches.length)} unavailable modules`,
          );
        }
        assertRustSourceTreeImportTargetAvailable(specifier, module.identity, unavailableMatches[0]);
      }
      return [createRustSourceTreeReference(module, candidates[0]!, specifier, undefined, multiPackage)];
    });
  });
  return references.sort(
    (left, right) =>
      compareTextCodeUnits(getRustSourceTreeModuleKey(left.from), getRustSourceTreeModuleKey(right.from)) ||
      compareTextCodeUnits(left.specifier, right.specifier) ||
      compareTextCodeUnits(getRustSourceTreeModuleKey(left.target), getRustSourceTreeModuleKey(right.target)) ||
      compareTextCodeUnits((left.importedNames ?? []).join('\0'), (right.importedNames ?? []).join('\0')),
  );
}

function createRustSourceTreeEdgeReferences(
  from: RustSourceTreeModuleRecord,
  specifier: string,
  edges: readonly Readonly<CompilerModuleResolutionEdge>[],
  modules: readonly RustSourceTreeModuleRecord[],
  multiPackage: boolean,
  unavailable: ReadonlyMap<string, CompilerRustSourceTreeUnavailableModule>,
): readonly CompilerRustSourceTreeReferencePlan[] {
  const targetsBySource = new Map<string, RustSourceTreeModuleRecord[]>();
  for (const module of modules) {
    const key = getRustSourceTreeSourceKey(module.identity.packageName, module.identity.source);
    targetsBySource.set(key, [...(targetsBySource.get(key) ?? []), module]);
  }
  const resolved = edges.map((edge) => {
    const sourceKey = getRustSourceTreeSourceKey(edge.target.packageName, edge.target.source);
    const targets = targetsBySource.get(sourceKey) ?? [];
    if (targets.length === 0) {
      assertRustSourceTreeImportTargetAvailable(specifier, from.identity, unavailable.get(sourceKey));
    }
    if (targets.length !== 1) {
      throw createRustSourceTreePlanningFailure(
        'rust-source-tree-import-ambiguity',
        [
          getRustSourceTreeModuleKey(from.identity),
          `${edge.target.packageName}/${normalizePathPortable(edge.target.source)}`,
        ],
        `Rust source-tree import ${specifier} from ${formatRustSourceTreeModuleSubject(from.identity)} does not identify one target module`,
      );
    }
    return {
      importedNames: edge.importedNames ? [...new Set(edge.importedNames)].sort(compareTextCodeUnits) : undefined,
      target: targets[0]!,
    };
  });
  const wholeTargets = new Set(
    resolved
      .filter((item) => item.importedNames === undefined)
      .map((item) => getRustSourceTreeModuleKey(item.target.identity)),
  );
  const namedTargets = new Map<string, Set<string>>();
  for (const item of resolved) {
    for (const name of item.importedNames ?? []) {
      const targets = namedTargets.get(name) ?? new Set<string>();
      targets.add(getRustSourceTreeModuleKey(item.target.identity));
      namedTargets.set(name, targets);
    }
  }
  const wholeTarget = wholeTargets.size === 1 ? [...wholeTargets][0] : undefined;
  const namedConflictsWithWhole =
    wholeTarget !== undefined &&
    [...namedTargets.values()].some((targets) => [...targets].some((target) => target !== wholeTarget));
  if (
    wholeTargets.size > 1 ||
    namedConflictsWithWhole ||
    [...namedTargets.values()].some((targets) => targets.size > 1)
  ) {
    throw createRustSourceTreePlanningFailure(
      'rust-source-tree-import-ambiguity',
      [
        getRustSourceTreeModuleKey(from.identity),
        ...resolved.map((item) => getRustSourceTreeModuleKey(item.target.identity)),
      ],
      `Rust source-tree import ${specifier} from ${formatRustSourceTreeModuleSubject(from.identity)} resolves the same request to multiple module paths`,
    );
  }
  const unique = new Map<string, CompilerRustSourceTreeReferencePlan>();
  for (const item of resolved) {
    const reference = createRustSourceTreeReference(from, item.target, specifier, item.importedNames, multiPackage);
    unique.set(
      `${getRustSourceTreeModuleKey(reference.target)}\0${(reference.importedNames ?? []).join('\0')}`,
      reference,
    );
  }
  return [...unique.values()];
}

function createRustSourceTreeReference(
  from: RustSourceTreeModuleRecord,
  target: RustSourceTreeModuleRecord,
  specifier: string,
  importedNames: readonly string[] | undefined,
  multiPackage: boolean,
): CompilerRustSourceTreeReferencePlan {
  const base =
    from.identity.packageName === target.identity.packageName
      ? 'crate'
      : convertPackageNameToRustCrateName(target.identity.packageName).replaceAll('-', '_');
  const targetLocator = createRustCompilerModuleLocator(target.identity, { multiPackage });
  return {
    from: from.identity,
    ...(importedNames === undefined ? {} : { importedNames }),
    rustPath: [base, ...targetLocator.modulePath].join('::'),
    specifier,
    target: target.identity,
  };
}

function createRustSourceTreeSkeletonLocator(
  node: Readonly<RustSourceTreeNode>,
  multiPackage: boolean,
): Readonly<{ filePath: string; modulePath: readonly string[]; source: string }> {
  const source = node.modulePath.length === 0 ? 'src/index.ts' : `src/${node.modulePath.join('/')}/index.ts`;
  return createRustCompilerModuleLocator({ packageName: node.packageName, source }, { multiPackage });
}

function formatRustSourceTreeFileOwner(file: Readonly<CompilerRustSourceTreeFilePlan>): string {
  return file.ownership.kind === 'source'
    ? getRustSourceTreeModuleKey(file.ownership.module)
    : `${file.packageName}/${file.modulePath.join('/') || '<root>'}`;
}

function freezeRustSourceTreeValue<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) freezeRustSourceTreeValue(member);
  }
  return value;
}

function getRustSourceTreeModuleKey(identity: Readonly<CompilerModuleIdentity>): string {
  return `${identity.packageName}\0${normalizePathPortable(identity.source)}\0${identity.name}`;
}

// The same identity a person reads in a diagnostic; the key above is a machine key with NUL boundaries.
function formatRustSourceTreeModuleSubject(identity: Readonly<CompilerModuleIdentity>): string {
  return `${identity.packageName}/${normalizePathPortable(identity.source)}#${identity.name}`;
}

function getRustSourceTreeNodeKey(packageName: string, modulePath: readonly string[]): string {
  return `${packageName}\0${modulePath.join('\0')}`;
}

function getRustSourceTreeResolutionEdges(
  importer: Readonly<CompilerModuleIdentity>,
  specifier: string,
  edges: readonly Readonly<CompilerModuleResolutionEdge>[],
): readonly Readonly<CompilerModuleResolutionEdge>[] {
  const matching = edges.filter((edge) => edge.specifier === specifier);
  const exact = matching.filter(
    (edge) => edge.importer && getRustSourceTreeModuleKey(edge.importer) === getRustSourceTreeModuleKey(importer),
  );
  return exact.length > 0 ? exact : matching.filter((edge) => edge.importer === undefined);
}

function getRustSourceTreeSourceKey(packageName: string, source: string): string {
  return `${packageName.normalize('NFC')}\0${normalizePathPortable(source)}`;
}

function isRustSourceTreeModulePathEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function isRustSourceTreeModulePathPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((segment, index) => segment === value[index]);
}

function normalizeRustSourceTreeModuleIdentity(
  module: Readonly<{ name: string; packageName: string; source: string }>,
): CompilerModuleIdentity {
  return {
    name: module.name.normalize('NFC'),
    packageName: module.packageName.normalize('NFC'),
    source: normalizePathPortable(module.source),
  };
}

function resolveRustSourceTreeRelativeModules(
  importer: RustSourceTreeModuleRecord,
  specifier: string,
  modules: readonly RustSourceTreeModuleRecord[],
): readonly RustSourceTreeModuleRecord[] {
  const candidates = getRustSourceTreeRelativeCandidateSources(importer.identity.source, specifier);
  return modules.filter(
    (module) => module.identity.packageName === importer.identity.packageName && candidates.has(module.identity.source),
  );
}

function getRustSourceTreeRelativeCandidateSources(importerSource: string, specifier: string): ReadonlySet<string> {
  const unresolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importerSource), normalizePathPortable(specifier)),
  );
  const candidates = new Set([unresolved]);
  for (const [emitted, source] of [
    ['.cjs', '.cts'],
    ['.js', '.ts'],
    ['.jsx', '.tsx'],
    ['.mjs', '.mts'],
  ] as const) {
    if (unresolved.endsWith(emitted)) candidates.add(`${unresolved.slice(0, -emitted.length)}${source}`);
  }
  if (!/\.[^/]+$/u.test(unresolved)) {
    candidates.add(`${unresolved}.ts`);
    candidates.add(`${unresolved}.tsx`);
    candidates.add(`${unresolved}/index.ts`);
    candidates.add(`${unresolved}/index.tsx`);
  }
  return candidates;
}

// A module the run left out, indexed by the package and source an import request names. Sorted first so
// two runs over the same evidence answer with the same entry even when the caller built the list differently.
function createRustSourceTreeUnavailableIndex(
  modules: readonly CompilerRustSourceTreeUnavailableModule[],
): ReadonlyMap<string, CompilerRustSourceTreeUnavailableModule> {
  const index = new Map<string, CompilerRustSourceTreeUnavailableModule>();
  const sorted = [...modules].sort((left, right) =>
    compareTextCodeUnits(getRustSourceTreeModuleKey(left.module), getRustSourceTreeModuleKey(right.module)),
  );
  for (const entry of sorted) {
    const key = getRustSourceTreeSourceKey(entry.module.packageName, entry.module.source);
    if (!index.has(key)) index.set(key, entry);
  }
  return index;
}

function resolveRustSourceTreeUnavailableRelativeModules(
  importer: RustSourceTreeModuleRecord,
  specifier: string,
  unavailable: ReadonlyMap<string, CompilerRustSourceTreeUnavailableModule>,
): readonly CompilerRustSourceTreeUnavailableModule[] {
  const candidates = getRustSourceTreeRelativeCandidateSources(importer.identity.source, specifier);
  return [...unavailable.values()].filter(
    (entry) =>
      entry.module.packageName === importer.identity.packageName &&
      candidates.has(normalizePathPortable(entry.module.source)),
  );
}

// An import that names no retained module is one of four facts, and the caller has to be able to tell them
// apart: the target was refused (and why), the target exists but was not selected for this output, the
// request resolves to several modules, or nothing in the compilation answers it.
function assertRustSourceTreeImportTargetAvailable(
  specifier: string,
  importer: Readonly<CompilerModuleIdentity>,
  unavailable: CompilerRustSourceTreeUnavailableModule | undefined,
): never {
  const importerSubject = formatRustSourceTreeModuleSubject(importer);
  if (unavailable !== undefined) {
    const targetSubject = formatRustSourceTreeModuleSubject(unavailable.module);
    const subjects = [getRustSourceTreeModuleKey(importer), getRustSourceTreeModuleKey(unavailable.module)].sort(
      compareTextCodeUnits,
    );
    if (unavailable.disposition === 'refused') {
      throw createRustSourceTreePlanningFailure(
        'rust-source-tree-import-target-refused',
        subjects,
        `Rust source-tree import ${specifier} from ${importerSubject} targets ${targetSubject}, which was refused: ${unavailable.code}: ${unavailable.message}`,
      );
    }
    throw createRustSourceTreePlanningFailure(
      'rust-source-tree-import-target-unselected',
      subjects,
      `Rust source-tree import ${specifier} from ${importerSubject} targets ${targetSubject}, which is not selected for this output`,
    );
  }
  throw createRustSourceTreePlanningFailure(
    'rust-source-tree-import-target-absent',
    [getRustSourceTreeModuleKey(importer)],
    `Rust source-tree import ${specifier} from ${importerSubject} has no target module in this compilation`,
  );
}

const rustSourceTreePlanningFailureCodes: ReadonlySet<CompilerRustSourceTreePlanningFailureCode> = new Set([
  'rust-source-tree-crate-collision',
  'rust-source-tree-file-collision',
  'rust-source-tree-import-ambiguity',
  'rust-source-tree-import-target-absent',
  'rust-source-tree-import-target-refused',
  'rust-source-tree-import-target-unselected',
  'rust-source-tree-module-collision',
  'rust-source-tree-public-module-missing',
]);
