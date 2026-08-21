import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  collectExportedApiDeclarations,
  collectLocalExportNames,
  collectModuleSpecifiers,
  containsTransientWorkComment,
  isCompilerApiFunctionName,
  isDomainTypeScriptFileName,
  isExportedContractDeclaration,
} from './packageHealthAst.js';

interface PackageManifest {
  author?: string;
  dependencies?: Record<string, string>;
  description?: string;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  exports?: Record<string, { default?: string; types?: string }>;
  files?: string[];
  license?: string;
  main?: string;
  name?: string;
  private?: boolean;
  repository?: { directory?: string; type?: string; url?: string };
  scripts?: Record<string, string>;
  sideEffects?: boolean;
  type?: string;
  types?: string;
  version?: string;
}

interface PackageRule {
  dependencies: readonly string[];
  description: string;
  devDependencies?: readonly string[];
}

const packageRules: Readonly<Record<string, PackageRule>> = {
  'compiler-backend-hx': {
    dependencies: ['compiler-emission', 'compiler-lowering', 'compiler-runtime-contract', 'compiler-types'],
    description: 'Haxe lowering, naming, and source emission backend',
    devDependencies: ['compiler-semantic'],
  },
  'compiler-backend-rs': {
    dependencies: ['compiler-emission', 'compiler-lowering', 'compiler-runtime-contract', 'compiler-types'],
    description: 'Rust lowering, naming, and source emission backend',
    devDependencies: ['compiler-semantic'],
  },
  'compiler-emission': {
    dependencies: ['compiler-ordering', 'compiler-types'],
    description: 'Target-neutral source-emission infrastructure',
  },
  'compiler-inventory': {
    dependencies: ['compiler-provenance', 'compiler-types'],
    description: 'Flight package, export-lane, symbol, and runtime-value inventory',
  },
  'compiler-ir-validation': {
    dependencies: ['compiler-types'],
    description: 'Target-neutral intermediate-representation structural validation',
    devDependencies: ['compiler-semantic'],
  },
  'compiler-lowering': {
    dependencies: ['compiler-ir-validation', 'compiler-types'],
    description: 'Backend-elected target-neutral IR lowering passes',
    devDependencies: ['compiler-semantic'],
  },
  'compiler-ordering': {
    dependencies: [],
    description: 'Host-independent ordering primitives for compiler data',
  },
  'compiler-orchestration': {
    dependencies: ['compiler-emission', 'compiler-patch', 'compiler-semantic', 'compiler-types'],
    description: 'Deterministic compiler pipeline orchestration',
  },
  'compiler-patch': {
    dependencies: ['compiler-ordering', 'compiler-types'],
    description: 'Identity-based semantic patch application and auditing',
  },
  'compiler-provenance': {
    dependencies: [],
    description: 'Stable source normalization, provenance, and fingerprints',
  },
  'compiler-runtime-contract': {
    dependencies: ['compiler-ordering', 'compiler-types'],
    description: 'Target-neutral runtime binding reachability and completeness',
    devDependencies: ['compiler-semantic'],
  },
  'compiler-semantic': {
    dependencies: ['compiler-provenance', 'compiler-types'],
    description: 'TypeScript semantic analysis and target-neutral lowering',
  },
  'compiler-types': {
    dependencies: [],
    description: 'Shared compiler contracts, diagnostics, and target-neutral IR',
  },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDirectory = path.join(root, 'packages');
const errors: string[] = [];
const exportedApiHomes = new Map<string, string>();
const packageNames = Object.keys(packageRules).sort();
const publicPackageName = 'tool-compiler';
const workspaceNames = [...packageNames, publicPackageName].sort();
const discoveredPackages = readdirSync(packagesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

check(
  JSON.stringify(discoveredPackages) === JSON.stringify(workspaceNames),
  `workspace directories differ from the cultivated package set\n  expected: ${workspaceNames.join(', ')}\n  received: ${discoveredPackages.join(', ')}`,
);

const rootManifest = readJson<PackageManifest & { workspaces?: string[] }>(path.join(root, 'package.json'));
const publicPackageDirectory = path.join(packagesDirectory, publicPackageName);
const publicManifest = readJson<PackageManifest>(path.join(publicPackageDirectory, 'package.json'));
check(rootManifest?.name === 'flight-compiler', 'root package must be flight-compiler');
check(rootManifest?.private === true, 'root development workspace must remain private');
check(
  JSON.stringify(rootManifest?.workspaces) === JSON.stringify(['packages/*']),
  'root workspaces must be exactly ["packages/*"]',
);

checkPublicPackage();
for (const packageName of packageNames) checkPackage(packageName, packageRules[packageName]!);
checkTypeScriptFileNames();
checkDependencyCycles();
checkPublicFacade();

if (errors.length > 0) {
  process.stderr.write(`Package health failed with ${String(errors.length)} error(s):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exit(1);
}

process.stdout.write(
  `Package health passed for ${String(packageNames.length)} private compiler packages and @flighthq/tool-compiler.\n`,
);

function checkPublicPackage(): void {
  if (!publicManifest) {
    errors.push(`${publicPackageName}: package.json is missing or invalid`);
    return;
  }

  check(publicManifest.name === '@flighthq/tool-compiler', 'tool-compiler: public package name is invalid');
  check(publicManifest.version === '0.0.0', 'tool-compiler: initial package version must be 0.0.0');
  check(
    publicManifest.description === 'Shared compiler kernel for mechanical Flight SDK target ports',
    'tool-compiler: description differs from the cultivated contract',
  );
  check(publicManifest.author === rootManifest?.author, 'tool-compiler: author must match root');
  check(publicManifest.license === rootManifest?.license, 'tool-compiler: license must match root');
  check(publicManifest.private !== true, 'tool-compiler: public package must remain publishable');
  check(publicManifest.type === 'module', 'tool-compiler: type must be module');
  check(publicManifest.sideEffects === false, 'tool-compiler: sideEffects must be false');
  check(publicManifest.repository?.type === 'git', 'tool-compiler: repository type must be git');
  check(
    publicManifest.repository?.url === rootManifest?.repository?.url,
    'tool-compiler: repository URL must match root',
  );
  check(
    publicManifest.repository?.directory === 'packages/tool-compiler',
    'tool-compiler: repository directory must identify its workspace',
  );
  check(
    publicManifest.main === 'dist/packages/tool-compiler/src/index.js',
    'tool-compiler: main must identify the assembled JavaScript facade',
  );
  check(
    publicManifest.types === 'dist/packages/tool-compiler/src/index.d.ts',
    'tool-compiler: types must identify the assembled declaration facade',
  );
  check(
    publicManifest.exports?.['.']?.default === './dist/packages/tool-compiler/src/index.js' &&
      publicManifest.exports['.']?.types === './dist/packages/tool-compiler/src/index.d.ts',
    'tool-compiler: exports must expose the assembled facade',
  );
  check(
    JSON.stringify(publicManifest.files) === JSON.stringify(['dist', 'README.md', 'LICENSE.md']),
    'tool-compiler: files must contain only dist and package documentation',
  );
  check(publicManifest.engines?.node === '>=22', 'tool-compiler: Node.js engine must be >=22');
  check(
    publicManifest.dependencies?.typescript === rootManifest?.devDependencies?.typescript,
    'tool-compiler: TypeScript dependency must match the repository toolchain',
  );
  for (const dependency of packageNames) {
    check(
      publicManifest.dependencies?.[`@flighthq/${dependency}`] === undefined &&
        publicManifest.devDependencies?.[`@flighthq/${dependency}`] === undefined,
      `tool-compiler: assembled private package @flighthq/${dependency} must not be declared`,
    );
  }
  for (const script of ['prepack', 'test', 'test:watch', 'typecheck']) {
    check(typeof publicManifest.scripts?.[script] === 'string', `tool-compiler: missing ${script} script`);
  }
  check(existsSync(path.join(publicPackageDirectory, 'tsconfig.json')), 'tool-compiler: missing tsconfig.json');

  const sourceDirectory = path.join(publicPackageDirectory, 'src');
  check(existsSync(path.join(sourceDirectory, 'index.ts')), 'tool-compiler: missing src/index.ts');
  const sourceEntries = existsSync(sourceDirectory) ? readdirSync(sourceDirectory, { withFileTypes: true }) : [];
  for (const entry of sourceEntries) {
    check(!entry.isDirectory(), `tool-compiler: src must remain flat; found src/${entry.name}`);
  }
  check(
    sourceEntries.some((entry) => entry.isFile() && entry.name.endsWith('.test.ts')),
    'tool-compiler: at least one colocated unit test is required',
  );
  for (const fileName of ['LICENSE.md', 'README.md']) {
    const rootFile = path.join(root, fileName);
    const packageFile = path.join(publicPackageDirectory, fileName);
    check(existsSync(packageFile), `tool-compiler: missing ${fileName}`);
    if (fileName === 'LICENSE.md' && existsSync(packageFile)) {
      check(
        readFileSync(packageFile, 'utf8') === readFileSync(rootFile, 'utf8'),
        `tool-compiler: ${fileName} differs from root`,
      );
    }
  }
}

function checkPackage(packageName: string, rule: Readonly<PackageRule>): void {
  const packageDirectory = path.join(packagesDirectory, packageName);
  const sourceDirectory = path.join(packageDirectory, 'src');
  const manifest = readJson<PackageManifest>(path.join(packageDirectory, 'package.json'));
  if (!manifest) {
    errors.push(`${packageName}: package.json is missing or invalid`);
    return;
  }

  const scopedName = `@flighthq/${packageName}`;
  check(manifest.name === scopedName, `${packageName}: package name must be ${scopedName}`);
  check(manifest.version === publicManifest?.version, `${packageName}: version must match the public package`);
  check(manifest.description === rule.description, `${packageName}: description differs from the cultivated contract`);
  check(manifest.author === rootManifest?.author, `${packageName}: author must match the public package`);
  check(manifest.license === rootManifest?.license, `${packageName}: license must match the public package`);
  check(manifest.private === true, `${packageName}: internal compiler package must be private`);
  check(manifest.type === 'module', `${packageName}: type must be module`);
  check(manifest.sideEffects === false, `${packageName}: sideEffects must be false`);
  check(manifest.repository?.type === 'git', `${packageName}: repository type must be git`);
  check(manifest.repository?.url === rootManifest?.repository?.url, `${packageName}: repository URL must match root`);
  check(
    manifest.repository?.directory === `packages/${packageName}`,
    `${packageName}: repository directory must identify its workspace`,
  );
  for (const script of ['test', 'test:watch', 'typecheck']) {
    check(typeof manifest.scripts?.[script] === 'string', `${packageName}: missing ${script} script`);
  }
  const packageTypeScriptVersion = manifest.dependencies?.typescript ?? manifest.devDependencies?.typescript;
  if (packageTypeScriptVersion !== undefined) {
    check(
      packageTypeScriptVersion === rootManifest?.devDependencies?.typescript,
      `${packageName}: TypeScript version must match the repository toolchain`,
    );
  }
  check(existsSync(path.join(packageDirectory, 'tsconfig.json')), `${packageName}: missing tsconfig.json`);
  check(existsSync(path.join(sourceDirectory, 'index.ts')), `${packageName}: missing src/index.ts`);

  const sourceEntries = existsSync(sourceDirectory) ? readdirSync(sourceDirectory, { withFileTypes: true }) : [];
  for (const entry of sourceEntries) {
    check(!entry.isDirectory(), `${packageName}: src must remain flat; found src/${entry.name}`);
  }
  const sourceFiles = sourceEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(sourceDirectory, entry.name));
  const testFiles = sourceFiles.filter((file) => file.endsWith('.test.ts'));
  if (packageName !== 'compiler-types') {
    check(testFiles.length > 0, `${packageName}: at least one colocated unit test is required`);
  }

  const productionImports = new Set<string>();
  const testImports = new Set<string>();
  for (const file of sourceFiles) {
    const contents = readFileSync(file, 'utf8');
    check(
      !containsTransientWorkComment(contents),
      `${relative(file)}: transient work comments do not belong in source`,
    );
    const sourceFile = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
    visitSourceFile(sourceFile, packageName);
    const imports = file.endsWith('.test.ts') ? testImports : productionImports;
    for (const specifier of collectModuleSpecifiers(sourceFile)) {
      const importedPackage = resolveCompilerPackageImport(file, specifier);
      if (!importedPackage || importedPackage === packageName) continue;
      imports.add(importedPackage);
      check(
        specifier === `../../${importedPackage}/src/index.js`,
        `${relative(file)}: cross-package imports must use ${importedPackage}/src/index.js`,
      );
    }
  }

  const expectedDependencies = new Set(rule.dependencies);
  const expectedDevDependencies = new Set(rule.devDependencies ?? []);
  checkSet(packageName, 'production imports', productionImports, expectedDependencies);
  for (const dependency of expectedDependencies) {
    check(
      manifest.dependencies?.[`@flighthq/${dependency}`] === '*',
      `${packageName}: dependencies must declare @flighthq/${dependency} as "*"`,
    );
  }
  for (const dependency of expectedDevDependencies) {
    check(
      manifest.devDependencies?.[`@flighthq/${dependency}`] === '*',
      `${packageName}: devDependencies must declare @flighthq/${dependency} as "*"`,
    );
  }
  for (const dependency of testImports) {
    check(
      expectedDependencies.has(dependency) || expectedDevDependencies.has(dependency),
      `${packageName}: test imports undeclared @flighthq/${dependency}`,
    );
  }
}

function visitSourceFile(sourceFile: ts.SourceFile, packageName: string): void {
  const localExportNames = collectLocalExportNames(sourceFile);
  if (!sourceFile.fileName.endsWith('.test.ts') && path.basename(sourceFile.fileName) !== 'index.ts') {
    for (const declaration of collectExportedApiDeclarations(sourceFile)) {
      const existingHome = exportedApiHomes.get(declaration.name);
      check(
        existingHome === undefined,
        `${relative(sourceFile.fileName)}: exported API ${declaration.name} duplicates ${relative(existingHome ?? sourceFile.fileName)}`,
      );
      if (existingHome === undefined) exportedApiHomes.set(declaration.name, sourceFile.fileName);
      if (declaration.kind === 'value') {
        errors.push(
          `${relative(sourceFile.fileName)}: exported runtime API ${declaration.name} must be a named free function`,
        );
      } else if (declaration.kind === 'function' && !isCompilerApiFunctionName(declaration.name)) {
        errors.push(
          `${relative(sourceFile.fileName)}: exported function ${declaration.name} must be verb + full type + optional modifier`,
        );
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      errors.push(
        `${relative(sourceFile.fileName)}:${lineOf(sourceFile, node)}: compiler packages use functions and data, not classes`,
      );
    }
    if (packageName !== 'compiler-types' && isExportedContractDeclaration(node, sourceFile, localExportNames)) {
      errors.push(
        `${relative(sourceFile.fileName)}:${lineOf(sourceFile, node)}: exported contracts belong in compiler-types`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function checkTypeScriptFileNames(): void {
  const files = [
    ...workspaceNames.flatMap((workspaceName) =>
      readTypeScriptFiles(path.join(packagesDirectory, workspaceName, 'src')),
    ),
    ...readTypeScriptFiles(root),
  ];
  const fileHomes = new Map<string, string>();
  for (const file of files) {
    const fileName = path.basename(file);
    if (fileName === 'index.ts' || /^vitest\.config(?:\.[a-zA-Z0-9-]+)?\.ts$/u.test(fileName)) continue;
    const identity = fileName.toLowerCase();
    const existingHome = fileHomes.get(identity);
    check(
      existingHome === undefined,
      `${relative(file)}: TypeScript file name duplicates ${relative(existingHome ?? file)}`,
    );
    fileHomes.set(identity, file);
    check(
      isDomainTypeScriptFileName(fileName),
      `${relative(file)}: TypeScript file names must be verb-free, non-generic concept nouns`,
    );
  }
}

function resolveCompilerPackageImport(file: string, specifier: string): string | undefined {
  if (specifier.startsWith('@flighthq/compiler-')) {
    const packageName = specifier.slice('@flighthq/'.length).split('/')[0];
    return packageName && packageRules[packageName] ? packageName : undefined;
  }
  if (!specifier.startsWith('.')) return undefined;
  const resolved = path.resolve(path.dirname(file), specifier);
  const fromPackages = path.relative(packagesDirectory, resolved).split(path.sep);
  const packageName = fromPackages[0];
  return packageName && packageRules[packageName] ? packageName : undefined;
}

function checkDependencyCycles(): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (packageName: string, chain: readonly string[]): void => {
    if (visiting.has(packageName)) {
      errors.push(`runtime dependency cycle: ${[...chain, packageName].join(' -> ')}`);
      return;
    }
    if (visited.has(packageName)) return;
    visiting.add(packageName);
    for (const dependency of packageRules[packageName]?.dependencies ?? []) visit(dependency, [...chain, packageName]);
    visiting.delete(packageName);
    visited.add(packageName);
  };
  for (const packageName of packageNames) visit(packageName, []);
}

function checkPublicFacade(): void {
  const facade = path.join(publicPackageDirectory, 'src', 'index.ts');
  if (!existsSync(facade)) return;
  const sourceFile = ts.createSourceFile(facade, readFileSync(facade, 'utf8'), ts.ScriptTarget.Latest, true);
  const exportedPackages = new Set<string>();
  for (const statement of sourceFile.statements) {
    check(ts.isExportDeclaration(statement), 'tool-compiler: public facade may contain only export declarations');
  }
  for (const specifier of collectModuleSpecifiers(sourceFile)) {
    const exportedPackage = resolveCompilerPackageImport(facade, specifier);
    check(exportedPackage !== undefined, `tool-compiler: public facade contains unsupported export ${specifier}`);
    if (!exportedPackage) continue;
    exportedPackages.add(exportedPackage);
    check(
      specifier === `../../${exportedPackage}/src/index.js`,
      `tool-compiler: public facade exports must use ${exportedPackage}/src/index.js`,
    );
  }
  checkSet('public facade', 'workspace exports', exportedPackages, new Set(packageNames));
}

function checkSet(owner: string, label: string, actual: ReadonlySet<string>, expected: ReadonlySet<string>): void {
  const actualValues = [...actual].sort();
  const expectedValues = [...expected].sort();
  check(
    JSON.stringify(actualValues) === JSON.stringify(expectedValues),
    `${owner}: ${label} differ\n  expected: ${expectedValues.join(', ') || '(none)'}\n  received: ${actualValues.join(', ') || '(none)'}`,
  );
}

function check(condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function readTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(directory, entry.name));
}

function relative(file: string): string {
  return path.relative(root, file).replaceAll('\\', '/');
}
