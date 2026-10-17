import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { createCppCompilerPublicBindingPlan } from '../../compiler-backend-cpp/src/index.js';
import {
  createCompilerHaxeCppExternPlan,
  createCompilerHaxeDualBindingPlan,
  createHaxeCompilerBackend,
  emitCompilerHaxeCppExternPlan,
} from '../../compiler-backend-hx/src/index.js';
import {
  createCompilerModuleEvaluationPlan,
  createCompilerModuleFacadePlanForEntries,
} from '../../compiler-module/src/index.js';
import { lowerTypeScriptSource } from '../../compiler-semantic/src/index.js';
import type {
  CompilerHaxeCppExternRefusal,
  CompilerHaxeDualBindingPlan,
  CompilerModuleIdentity,
  CompilerPublicBindingModuleRefusal,
  EmittedFile,
  IrModule,
} from '../../compiler-types/src/index.js';

const healthySources = [
  {
    cppIncludePrefix: 'flight/types',
    cppNamespace: 'flight::types',
    esmFile: 'flighthq-types.mjs',
    packageName: '@flighthq/types',
    source: 'packages/types/src/BatchBarrier.ts',
  },
  {
    cppIncludePrefix: 'flight/color',
    cppNamespace: 'flight::color',
    esmFile: 'flighthq-color.mjs',
    packageName: '@flighthq/color',
    source: 'packages/color/src/colorFromKelvin.ts',
  },
] as const;

const refusedSource = {
  cppIncludePrefix: 'flight/encoding',
  cppNamespace: 'flight::encoding',
  esmFile: 'flighthq-encoding.mjs',
  packageName: '@flighthq/encoding',
  source: 'packages/encoding/src/utf8.ts',
} as const;

interface FlightCppRefusalArtifact {
  readonly refusals: readonly FlightCppRefusalEntry[];
  readonly schema: string;
}

interface FlightCppRefusalEntry {
  readonly code: string;
  readonly module: string;
  readonly package: string;
  readonly reason: string;
  readonly stage: string;
}

export interface CompilerHaxeBindingCheckpointOptions {
  readonly cppDirectory: string;
  readonly flightDirectory: string;
  readonly outputDirectory: string;
}

export interface CompilerHaxeBindingCheckpointResult {
  readonly cppIncludeDirectories: readonly string[];
  readonly cppSlicePaths: readonly string[];
  readonly haxeDirectory: string;
  readonly haxeRefusals: readonly CompilerHaxeCppExternRefusal[];
  readonly javascriptModuleDirectory: string;
  readonly plan: CompilerHaxeDualBindingPlan;
  readonly planArtifactDirectory: string;
  readonly refusalArtifactDirectory: string;
}

// This producer is intentionally above both emitters. It asks the real public C++ and Haxe planners for
// their versioned plans, writes their output files, and never derives a second identity or locator schema.
// The selected source files are a tiny cut from the pinned Flight tree: a runtime enum, a scalar function,
// and one genuinely refused module used to prove that the fold preserves an upstream refusal verbatim.
export function produceCompilerHaxeBindingCheckpoint(
  options: Readonly<CompilerHaxeBindingCheckpointOptions>,
): CompilerHaxeBindingCheckpointResult {
  const outputDirectory = resetCompilerHaxeBindingCheckpointOutput(options.outputDirectory);
  const planArtifactDirectory = path.join(outputDirectory, 'plans');
  const refusalArtifactDirectory = path.join(outputDirectory, 'refusals');
  const javascriptModuleDirectory = path.join(outputDirectory, 'modules');
  const haxeDirectory = path.join(outputDirectory, 'haxe');
  const consumerDirectory = path.join(outputDirectory, 'consumer');
  for (const directory of [
    planArtifactDirectory,
    refusalArtifactDirectory,
    javascriptModuleDirectory,
    haxeDirectory,
    consumerDirectory,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  const healthy = healthySources.map((source) => lowerCompilerHaxeBindingCheckpointSource(options, source));
  const refused = lowerCompilerHaxeBindingCheckpointSource(options, refusedSource);
  const modules = healthy.map((source) => source.module);
  const moduleRefusal = readCompilerHaxeBindingCheckpointRefusal(options.cppDirectory, refused.module);
  const moduleEvaluation = createCompilerModuleEvaluationPlan({ dependencies: [], entries: modules, modules });
  const facade = createCompilerModuleFacadePlanForEntries(
    { evaluation: moduleEvaluation, modules },
    moduleEvaluation.entries,
  );
  const cppOptions = {
    packageTargets: Object.fromEntries(
      healthySources.map((source) => [
        source.packageName,
        { includePrefix: source.cppIncludePrefix, namespace: source.cppNamespace },
      ]),
    ),
    runtimeProfile: 'flight-cpp' as const,
  };
  const cpp = createCppCompilerPublicBindingPlan({
    facade,
    modules,
    options: cppOptions,
    refusals: [moduleRefusal],
  });
  const packageSpecifiers = Object.fromEntries(
    healthySources.map((source) => [source.packageName, `./${source.esmFile}`]),
  );
  const plan = createCompilerHaxeDualBindingPlan({
    cpp,
    facade,
    javascriptRefusals: [],
    modules,
    options: { emissionMode: 'extern', rootPackage: 'flight' },
    packageSpecifiers,
  });
  assertCompilerHaxeBindingCheckpointPlan(plan);

  const laneA = createHaxeCompilerBackend().createEmissionSession?.({
    moduleEvaluation,
    modules,
    options: { dualBindingPlan: plan, emissionMode: 'extern', rootPackage: 'flight' },
  });
  if (!laneA) throw new Error('Haxe checkpoint requires an extern emission session');
  const publicFiles = modules.flatMap((module) => laneA.emitModule(module));
  const cppExternPlan = createCompilerHaxeCppExternPlan({ bindings: plan, modules });
  const cppExtern = emitCompilerHaxeCppExternPlan(cppExternPlan);
  assertCompilerHaxeBindingCheckpointEmission(publicFiles, cppExtern.files, cppExtern.refusals);
  writeCompilerHaxeBindingCheckpointFiles(haxeDirectory, [...publicFiles, ...cppExtern.files]);

  for (const source of [...healthy, refused]) {
    writeFileSync(
      path.join(javascriptModuleDirectory, source.spec.esmFile),
      transpileCompilerHaxeBindingCheckpointEsm(source.text, source.absolutePath),
      'utf8',
    );
  }
  writeFileSync(path.join(planArtifactDirectory, 'flight-folded.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

  const refusedEvaluation = createCompilerModuleEvaluationPlan({
    dependencies: [],
    entries: [refused.module],
    modules: [refused.module],
  });
  const refusedFacade = createCompilerModuleFacadePlanForEntries(
    { evaluation: refusedEvaluation, modules: [refused.module] },
    refusedEvaluation.entries,
  );
  const refusedCpp = createCppCompilerPublicBindingPlan({
    facade: refusedFacade,
    modules: [refused.module],
    options: {
      packageTargets: {
        [refusedSource.packageName]: {
          includePrefix: refusedSource.cppIncludePrefix,
          namespace: refusedSource.cppNamespace,
        },
      },
      runtimeProfile: 'flight-cpp',
    },
    refusals: [moduleRefusal],
  });
  const refusedPlan = createCompilerHaxeDualBindingPlan({
    cpp: refusedCpp,
    facade: refusedFacade,
    javascriptRefusals: [],
    modules: [refused.module],
    options: { emissionMode: 'extern', rootPackage: 'flight' },
    packageSpecifiers: { [refusedSource.packageName]: `./${refusedSource.esmFile}` },
  });
  if (!refusedPlan.bindings.some((binding) => binding.cpp.availability === 'refused')) {
    throw new Error('The real flight-cpp refusal was not selected by the refusal checkpoint plan');
  }
  writeFileSync(
    path.join(refusalArtifactDirectory, 'flight-refused.json'),
    `${JSON.stringify(refusedPlan, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(path.join(consumerDirectory, 'Checkpoint.hx'), createCompilerHaxeBindingCheckpointConsumer(), 'utf8');

  const cppIncludeDirectories = [
    path.join(options.cppDirectory, 'include'),
    path.join(options.cppDirectory, 'generated', 'include'),
  ];
  const cppSlicePaths = [path.join(options.cppDirectory, 'src', 'c_runtime.cpp')];
  for (const required of [...cppIncludeDirectories, ...cppSlicePaths]) {
    if (!existsSync(required)) throw new Error(`Haxe checkpoint requires the pinned flight-cpp path ${required}`);
  }
  for (const binding of plan.bindings) {
    if (binding.cpp.availability !== 'available') continue;
    const locator = binding.cpp.locator;
    if (!cppIncludeDirectories.some((directory) => existsSync(path.join(directory, locator.include)))) {
      throw new Error(`Pinned flight-cpp publishes no header ${locator.include}`);
    }
  }

  return {
    cppIncludeDirectories,
    cppSlicePaths,
    haxeDirectory,
    haxeRefusals: cppExtern.refusals,
    javascriptModuleDirectory,
    plan,
    planArtifactDirectory,
    refusalArtifactDirectory,
  };
}

type CompilerHaxeBindingCheckpointSourceSpec = (typeof healthySources)[number] | typeof refusedSource;

interface CompilerHaxeBindingCheckpointSource {
  readonly absolutePath: string;
  readonly module: IrModule;
  readonly spec: CompilerHaxeBindingCheckpointSourceSpec;
  readonly text: string;
}

function lowerCompilerHaxeBindingCheckpointSource(
  options: Readonly<CompilerHaxeBindingCheckpointOptions>,
  spec: CompilerHaxeBindingCheckpointSourceSpec,
): CompilerHaxeBindingCheckpointSource {
  const absolutePath = path.join(options.flightDirectory, spec.source);
  const text = readFileSync(absolutePath, 'utf8');
  const sourceFile = ts.createSourceFile(absolutePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result = lowerTypeScriptSource(sourceFile, {
    packageName: spec.packageName,
    upstreamDirectory: options.flightDirectory,
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `Haxe checkpoint could not lower ${spec.source}: ${errors.map((diagnostic) => diagnostic.message).join('; ')}`,
    );
  }
  return { absolutePath, module: result.module, spec, text };
}

function getCompilerHaxeBindingCheckpointModuleIdentity(module: Readonly<IrModule>): CompilerModuleIdentity {
  return { name: module.name, packageName: module.packageName, source: module.source };
}

function readCompilerHaxeBindingCheckpointRefusal(
  cppDirectory: string,
  module: Readonly<IrModule>,
): CompilerPublicBindingModuleRefusal {
  const file = path.join(cppDirectory, 'generated', 'refusals.json');
  const artifact = JSON.parse(readFileSync(file, 'utf8')) as FlightCppRefusalArtifact;
  if (artifact.schema !== 'flight-generated-sdk-refusals/2' || !Array.isArray(artifact.refusals)) {
    throw new Error(`${file} is not a flight-generated-sdk-refusals/2 artifact`);
  }
  const selected = artifact.refusals.find(
    (entry) => entry.package === module.packageName && entry.module === refusedSource.source,
  );
  if (!selected) throw new Error(`${file} contains no real refusal for ${refusedSource.source}`);
  return {
    code: selected.code,
    message: selected.reason,
    module: getCompilerHaxeBindingCheckpointModuleIdentity(module),
  };
}

function assertCompilerHaxeBindingCheckpointPlan(plan: Readonly<CompilerHaxeDualBindingPlan>): void {
  const batchBarrier = plan.bindings.filter(
    (binding) => binding.identity.packageName === '@flighthq/types' && binding.publicHaxe.name === 'BatchBarrier',
  );
  const colorFromKelvin = plan.bindings.filter(
    (binding) => binding.identity.packageName === '@flighthq/color' && binding.publicHaxe.name === 'colorFromKelvin',
  );
  if (batchBarrier.length !== 1 || colorFromKelvin.length !== 1 || plan.bindings.length !== 2) {
    throw new Error('Haxe checkpoint plan must contain exactly the BatchBarrier type-value and colorFromKelvin call');
  }
  if (plan.bindings.some((binding) => binding.cpp.availability !== 'available')) {
    throw new Error('Haxe checkpoint healthy plan contains a refused C++ backing');
  }
  if (plan.bindings.some((binding) => binding.javascript.availability !== 'available')) {
    throw new Error('Haxe checkpoint healthy plan contains a refused JavaScript backing');
  }
  const callable = colorFromKelvin[0];
  if (!callable || callable.publicHaxe.kind !== 'function' || callable.publicHaxe.signature === undefined) {
    throw new Error('Haxe checkpoint callable has no public function signature');
  }
}

function assertCompilerHaxeBindingCheckpointEmission(
  publicFiles: readonly Readonly<EmittedFile>[],
  cppFiles: readonly Readonly<EmittedFile>[],
  refusals: readonly Readonly<CompilerHaxeCppExternRefusal>[],
): void {
  const paths = new Set([...publicFiles, ...cppFiles].map((file) => file.path));
  const required = [
    'flight/BatchBarrier.hx',
    'flight/Color.hx',
    'flight/_cpp/BatchBarrier.hx',
    'flight/_cpp/_fn/Color.hx',
    'flight/_js/BatchBarrier.hx',
    'flight/_js/_fn/Color.hx',
  ];
  const missing = required.find((file) => !paths.has(file));
  if (missing) throw new Error(`Haxe checkpoint emitted no ${missing}`);
  const refusal = refusals[0];
  if (refusal) throw new Error(`Haxe checkpoint Lane B refused ${refusal.key}: ${refusal.message}`);
}

function writeCompilerHaxeBindingCheckpointFiles(directory: string, files: readonly Readonly<EmittedFile>[]): void {
  const byPath = new Map<string, string>();
  for (const file of files) {
    const prior = byPath.get(file.path);
    if (prior !== undefined && prior !== file.contents) {
      throw new Error(`Haxe checkpoint output path collision at ${file.path}`);
    }
    byPath.set(file.path, file.contents);
  }
  for (const [relativePath, contents] of [...byPath].sort(([left], [right]) =>
    compareCompilerHaxeBindingText(left, right),
  )) {
    const file = path.join(directory, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents, 'utf8');
  }
}

function transpileCompilerHaxeBindingCheckpointEsm(source: string, fileName: string): string {
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(`Haxe checkpoint ESM transpilation failed: ${errors.map((error) => error.messageText).join('; ')}`);
  }
  return result.outputText.endsWith('\n') ? result.outputText : `${result.outputText}\n`;
}

function createCompilerHaxeBindingCheckpointConsumer(): string {
  return `package;

class Checkpoint {
  static function main():Void {
    final barrier:flight.BatchBarrier = cast 0;
    final color:Float = flight.Color.colorFromKelvin(6500);
    if (barrier == cast -1) trace(color);
  }
}
`;
}

function resetCompilerHaxeBindingCheckpointOutput(directory: string): string {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  if (resolved === root || resolved === path.resolve(process.cwd())) {
    throw new Error(`Refusing to clean broad Haxe checkpoint output ${resolved}`);
  }
  rmSync(resolved, { force: true, recursive: true });
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

function compareCompilerHaxeBindingText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
