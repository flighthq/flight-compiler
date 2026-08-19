import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

interface PackageManifest {
  author?: string;
  dependencies?: Record<string, string>;
  description?: string;
  devDependencies?: Record<string, string>;
  license?: string;
  name?: string;
  private?: boolean;
  repository?: { directory?: string; type?: string; url?: string };
  scripts?: Record<string, string>;
  sideEffects?: boolean;
  type?: string;
  version?: string;
}

interface PackageRule {
  dependencies: readonly string[];
  description: string;
  devDependencies?: readonly string[];
}

const packageRules: Readonly<Record<string, PackageRule>> = {
  'compiler-backend-hx': {
    dependencies: ['compiler-emission', 'compiler-types'],
    description: 'Haxe lowering, naming, and source emission backend',
    devDependencies: ['compiler-semantic'],
  },
  'compiler-backend-rs': {
    dependencies: ['compiler-emission', 'compiler-types'],
    description: 'Rust lowering, naming, and source emission backend',
    devDependencies: ['compiler-semantic'],
  },
  'compiler-emission': {
    dependencies: ['compiler-types'],
    description: 'Target-neutral source-emission infrastructure',
  },
  'compiler-inventory': {
    dependencies: ['compiler-provenance', 'compiler-types'],
    description: 'Flight package, export-lane, symbol, and runtime-value inventory',
  },
  'compiler-orchestration': {
    dependencies: ['compiler-emission', 'compiler-patch', 'compiler-semantic', 'compiler-types'],
    description: 'Deterministic compiler pipeline orchestration',
  },
  'compiler-patch': {
    dependencies: ['compiler-types'],
    description: 'Identity-based semantic patch application and auditing',
  },
  'compiler-provenance': {
    dependencies: [],
    description: 'Stable source normalization, provenance, and fingerprints',
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
const packageNames = Object.keys(packageRules).sort();
const discoveredPackages = readdirSync(packagesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

check(
  JSON.stringify(discoveredPackages) === JSON.stringify(packageNames),
  `workspace directories differ from the cultivated package set\n  expected: ${packageNames.join(', ')}\n  received: ${discoveredPackages.join(', ')}`,
);

const rootManifest = readJson<PackageManifest & { workspaces?: string[] }>(path.join(root, 'package.json'));
check(rootManifest?.name === '@flighthq/tool-compiler', 'root package must be @flighthq/tool-compiler');
check(rootManifest?.private !== true, 'root package must remain publishable');
check(
  JSON.stringify(rootManifest?.workspaces) === JSON.stringify(['packages/*']),
  'root workspaces must be exactly ["packages/*"]',
);

for (const packageName of packageNames) checkPackage(packageName, packageRules[packageName]!);
checkDependencyCycles();
checkPublicFacade();

if (errors.length > 0) {
  process.stderr.write(`Package health failed with ${String(errors.length)} error(s):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exit(1);
}

process.stdout.write(`Package health passed for ${String(packageNames.length)} private compiler packages.\n`);

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
  check(manifest.version === rootManifest?.version, `${packageName}: version must match the public package`);
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
  check(testFiles.length > 0, `${packageName}: at least one colocated unit test is required`);

  const productionImports = new Set<string>();
  const testImports = new Set<string>();
  for (const file of sourceFiles) {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    visitSourceFile(sourceFile, packageName);
    const imports = file.endsWith('.test.ts') ? testImports : productionImports;
    for (const specifier of moduleSpecifiers(sourceFile)) {
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
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      errors.push(
        `${relative(sourceFile.fileName)}:${lineOf(sourceFile, node)}: compiler packages use functions and data, not classes`,
      );
    }
    if (
      packageName !== 'compiler-types' &&
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      errors.push(
        `${relative(sourceFile.fileName)}:${lineOf(sourceFile, node)}: exported contracts belong in compiler-types`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier) {
      if (ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
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
  const facade = path.join(root, 'src', 'index.ts');
  const sourceFile = ts.createSourceFile(facade, readFileSync(facade, 'utf8'), ts.ScriptTarget.Latest, true);
  const exportedPackages = new Set(
    moduleSpecifiers(sourceFile)
      .map((specifier) => resolveCompilerPackageImport(facade, specifier))
      .filter((value): value is string => value !== undefined),
  );
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

function relative(file: string): string {
  return path.relative(root, file).replaceAll('\\', '/');
}
