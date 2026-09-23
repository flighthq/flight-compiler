import { createCppCompilerBackend } from '../../compiler-backend-cpp/src/index.js';
import { createHaxeCompilerBackend } from '../../compiler-backend-hx/src/index.js';
import { createRustCompilerBackend } from '../../compiler-backend-rs/src/index.js';
import { compareTextCodeUnits } from '../../compiler-canonical-form/src/index.js';
import {
  compareCompilerPackageCheckBaseline,
  createCompilerPackageCheckPolicyResult,
  createCompilerPackageCheckPolicyStrict,
  createCompilerPackageCheckReport,
  getCompilerPackageCheckReportText,
} from '../../compiler-check/src/index.js';
import {
  createFlightPackageEligibilityPlan,
  isFlightPackageEligibilityFailure,
  readFlightPackageManifests,
} from '../../compiler-inventory/src/index.js';
import {
  compileFlightWorkspace,
  compileTypeScriptPackageGraph,
  parseTypeScriptSource,
} from '../../compiler-orchestration/src/index.js';
import type {
  CompilerCommandLineCapabilities,
  CompilerCommandLineCheckCapabilities,
  CompilerCommandLineCheckFormat,
  CompilerCommandLineCheckOutcome,
  CompilerCommandLineCheckRefusal,
  CompilerCommandLineCheckRequest,
  CompilerCommandLineCheckResult,
  CompilerCommandLineRefusal,
  CompilerCommandLineRequest,
  CompilerCommandLineResult,
  CompilerPackageCheckBaseline,
  CompilerPackageCheckProvenance,
  CompilerPackageCheckReport,
  FlightPackageEnvironment,
  FlightPackageManifest,
  HaxeCompilerEmissionMode,
} from '../../compiler-types/src/index.js';

// Pointing the compiler at a directory.
//
// All modules enter one graph compilation so sibling identities and graph-wide backend analysis are
// available. Each module still has its own outcome: pointed at an unfamiliar codebase, what one
// wants is the complete refusal report rather than a run that stops at the first unsupported form.
//
// The filesystem arrives as a capability record so the decision layer stays testable and so this
// stays the only place in the package that touches it.
export function compileCompilerCommandLineRequest(
  request: Readonly<CompilerCommandLineRequest>,
  capabilities: Readonly<CompilerCommandLineCapabilities>,
): CompilerCommandLineResult {
  const parsed = parseCompilerCommandLineRequest(request);
  if ('failure' in parsed) {
    capabilities.writeError(`${parsed.failure}\n\n${getCompilerCommandLineUsage()}\n`);
    return { emitted: 0, exitCode: 2, refusals: [] };
  }
  const backend = createCompilerCommandLineBackend(parsed);
  const backendOptions: Record<string, unknown> =
    parsed.target === 'haxe'
      ? {
          emissionMode: parsed.emissionMode,
          ...(parsed.rootPackage === undefined ? {} : { rootPackage: parsed.rootPackage }),
        }
      : parsed.target === 'cpp'
        ? {
            runtimeProfile: parsed.runtimeProfile,
            ...(parsed.runtimeHeader === undefined ? {} : { runtimeHeader: parsed.runtimeHeader }),
          }
        : {};
  const sources = capabilities.listSourceFiles(parsed.sourceDirectory);
  if (sources.length === 0) {
    capabilities.writeError(`No TypeScript modules under ${parsed.sourceDirectory}\n`);
    return { emitted: 0, exitCode: 2, refusals: [] };
  }
  const result = compileTypeScriptPackageGraph({
    backend,
    backendOptions,
    graph: {
      entries: [],
      moduleDependencies: [],
      packages: [{ dependencies: [], name: parsed.packageName, root: parsed.sourceDirectory }],
      schema: 'flight-compiler-package-graph/1',
    },
    sources: sources.map((source) => ({
      packageName: parsed.packageName,
      packageRoot: parsed.sourceDirectory,
      sourceFile: parseTypeScriptSource(source.sourcePath, source.contents),
      upstreamDirectory: parsed.sourceDirectory,
    })),
  });
  for (const file of result.compilation.files) {
    capabilities.writeOutputFile(parsed.outputDirectory, file.path, file.contents);
  }
  const emitted = result.report.modules.filter((module) => module.status === 'emitted').length;
  const refusals = result.report.modules.flatMap((module): CompilerCommandLineRefusal[] => {
    const refusal = module.refusals[0];
    if (!refusal) return [];
    return [
      {
        code: refusal.code,
        ...(refusal.column === undefined ? {} : { column: refusal.column }),
        ...(refusal.line === undefined ? {} : { line: refusal.line }),
        module: module.module.source,
        reason: refusal.message,
        stage: refusal.stage,
      },
    ];
  });
  capabilities.write(createCompilerCommandLineReport(emitted, refusals));
  return { emitted, exitCode: refusals.length > 0 && !parsed.reportOnly ? 1 : 0, refusals };
}

// What a check found. The check package renders the report -- the findings, the policy classes, the
// cascades -- and this adds only the verdict the invocation itself reached, because that is the part the
// report does not carry: what the baseline comparison and the policy made of it.
export function createCompilerCommandLineCheckReport(
  result: Readonly<CompilerCommandLineCheckResult>,
  format: CompilerCommandLineCheckFormat = 'text',
): string {
  if (isCompilerCommandLineCheckRefusal(result)) {
    return format === 'json'
      ? `${JSON.stringify({ schema: 'flight-compiler-check-run/1', exitCode: 2, reason: result.reason }, undefined, 2)}\n`
      : `${result.reason}\n`;
  }
  if (format === 'json') return `${JSON.stringify(createCompilerCommandLineCheckJson(result), undefined, 2)}\n`;
  return `${getCompilerPackageCheckReportText(result.report)}${createCompilerCommandLineCheckSummaryLine(result)}\n`;
}

// The one line the invocation always prints: what it checked, what it found, and what it decided. Absent a
// baseline every finding is introduced, which is why `0 baselined` and `0 resolved` read as a first run.
function createCompilerCommandLineCheckSummaryLine(result: Readonly<CompilerCommandLineCheckOutcome>): string {
  const gating = result.policyResult.failingFindingIdentities.length;
  return (
    `${String(result.eligiblePackageNames.length)} package(s) checked, ` +
    `${String(result.report.totals.directFindings)} direct finding(s), ` +
    `${String(result.comparison.introduced.length)} introduced, ${String(gating)} gating, ` +
    `${String(result.comparison.unchanged.length)} baselined, ` +
    `${String(result.comparison.resolvedFindingIdentities.length)} resolved, ` +
    `policy ${result.policyResult.policy.id}.`
  );
}

export function createCompilerCommandLineReport(
  emitted: number,
  refusals: readonly Readonly<{ module: string; reason: string }>[],
): string {
  const lines = [`${String(emitted)} module(s) emitted, ${String(refusals.length)} refused.`];
  const grouped = new Map<string, string[]>();
  for (const refusal of refusals) {
    grouped.set(refusal.reason, [...(grouped.get(refusal.reason) ?? []), refusal.module]);
  }
  const ordered = [...grouped.entries()].sort(
    (left, right) => right[1].length - left[1].length || (left[0] < right[0] ? -1 : 1),
  );
  for (const [reason, modules] of ordered) {
    lines.push('', `  ${String(modules.length)}x ${reason}`);
    for (const module of modules.slice(0, refusalModuleSampleSize)) lines.push(`       ${module}`);
    if (modules.length > refusalModuleSampleSize) {
      lines.push(`       … and ${String(modules.length - refusalModuleSampleSize)} more`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function getCompilerCommandLineCheckUsage(): string {
  return commandLineCheckUsage;
}
export function getCompilerCommandLineUsage(): string {
  return commandLineUsage;
}

export function isCompilerCommandLineCheckRefusal(
  result: Readonly<CompilerCommandLineCheckResult>,
): result is CompilerCommandLineCheckRefusal {
  return result.exitCode === 2;
}

export function validateCompilerCommandLineCheckRequest(
  request: Readonly<CompilerCommandLineCheckRequest>,
  capabilities: Readonly<CompilerCommandLineCheckCapabilities>,
): CompilerCommandLineCheckResult {
  const parsed = parseCompilerCommandLineCheckRequest(request);
  if ('failure' in parsed) {
    return refuseCompilerCommandLineCheck(capabilities, `${parsed.failure}\n\n${getCompilerCommandLineCheckUsage()}\n`);
  }
  let manifests: readonly Readonly<FlightPackageManifest>[];
  try {
    manifests = readFlightPackageManifests(
      { upstreamDirectory: parsed.workspaceDirectory },
      capabilities.workspaceSource,
    );
  } catch (error) {
    return refuseCompilerCommandLineCheck(capabilities, `${describeCompilerCommandLineFailure(error)}\n`);
  }
  const selectedPackageNames = selectCompilerCommandLinePackageNames(manifests, parsed);
  if ('failure' in selectedPackageNames) {
    return refuseCompilerCommandLineCheck(capabilities, `${selectedPackageNames.failure}\n`);
  }
  if (selectedPackageNames.length === 0) {
    // Nothing in scope is an invocation failure rather than a clean run: the check was pointed at
    // something that is not the workspace the caller meant, and saying so beats reporting zero findings.
    return refuseCompilerCommandLineCheck(
      capabilities,
      `${
        parsed.environment === undefined
          ? `No packages under ${parsed.workspaceDirectory}`
          : `No package under ${parsed.workspaceDirectory} declares ${parsed.environment}`
      }\n`,
    );
  }
  const baseline = readCompilerCommandLineCheckBaseline(capabilities, parsed);
  if ('failure' in baseline) return refuseCompilerCommandLineCheck(capabilities, `${baseline.failure}\n`);
  let report: CompilerPackageCheckReport;
  try {
    // One compilation of the whole selected closure, not one per package: the module graph, the export
    // lanes, and the identity a baseline records are all graph facts, and a per-package run would answer
    // "what is wrong with this module" with what a dependency could not do.
    const compilation = compileFlightWorkspace({
      backend: createCompilerCommandLineBackend(parsed),
      backendOptions: createCompilerCommandLineCheckBackendOptions(parsed),
      eligiblePackageNames: selectedPackageNames,
      source: capabilities.workspaceSource,
      upstreamDirectory: parsed.workspaceDirectory,
    });
    report = createCompilerPackageCheckReport(compilation.report, {
      provenance: capabilities.readProvenance?.() ?? createCompilerCommandLineCheckProvenance(parsed, capabilities),
    });
  } catch (error) {
    return refuseCompilerCommandLineCheck(capabilities, `${describeCompilerCommandLineFailure(error)}\n`);
  }
  const comparison = compareCompilerPackageCheckBaseline(report, baseline.baseline);
  const policyResult = createCompilerPackageCheckPolicyResult(comparison, createCompilerPackageCheckPolicyStrict());
  const outcome: CompilerCommandLineCheckOutcome = {
    comparison,
    eligiblePackageNames: selectedPackageNames,
    exitCode: policyResult.passed ? 0 : 1,
    policyResult,
    report,
  };
  const rendered = createCompilerCommandLineCheckReport(outcome, parsed.format);
  if (parsed.reportPath === undefined) {
    capabilities.write(rendered);
  } else {
    // The file carries the whole report; the stream carries the verdict, because a run that writes a file
    // still has to say in one line what it decided.
    capabilities.writeReportFile(parsed.reportPath, rendered);
    capabilities.write(`${createCompilerCommandLineCheckSummaryLine(outcome)}\n`);
  }
  return outcome;
}

// A baseline is the identities an earlier run recorded, as the check package writes them. Naming one that
// cannot be read or understood is an invocation failure: silently continuing would compare against nothing
// and report every finding as introduced while appearing to have honoured the file.
function readCompilerCommandLineCheckBaseline(
  capabilities: Readonly<CompilerCommandLineCheckCapabilities>,
  parsed: Readonly<ParsedCompilerCommandLineCheckRequest>,
): Readonly<{ baseline: CompilerPackageCheckBaseline }> | Readonly<{ failure: string }> {
  const empty: CompilerPackageCheckBaseline = { findingIdentities: [], schema: 'flight-compiler-check-baseline/1' };
  if (parsed.baselinePath === undefined) return { baseline: empty };
  const text = capabilities.readBaseline(parsed.baselinePath);
  if (text === undefined) return { failure: `Baseline ${parsed.baselinePath} could not be read` };
  let parsedBaseline: unknown;
  try {
    parsedBaseline = JSON.parse(text);
  } catch {
    return { failure: `Baseline ${parsed.baselinePath} is not valid JSON` };
  }
  if (!isCompilerCommandLineCheckBaseline(parsedBaseline)) {
    return { failure: `Baseline ${parsed.baselinePath} is not a flight-compiler-check-baseline/1 record` };
  }
  return { baseline: parsedBaseline };
}

function isCompilerCommandLineCheckBaseline(value: unknown): value is CompilerPackageCheckBaseline {
  return (
    value !== null &&
    typeof value === 'object' &&
    'schema' in value &&
    value.schema === 'flight-compiler-check-baseline/1' &&
    'findingIdentities' in value &&
    Array.isArray(value.findingIdentities) &&
    value.findingIdentities.every((identity: unknown) => typeof identity === 'string')
  );
}

// A run reports what produced it. The upstream revision is whatever the caller's workspace reading could
// establish -- a Git checkout has one and says so; the compiler and the target runtime have no revision the
// compiler can read about itself, so those say `unversioned` rather than a guess.
function createCompilerCommandLineCheckProvenance(
  parsed: Readonly<ParsedCompilerCommandLineCheckRequest>,
  capabilities: Readonly<CompilerCommandLineCheckCapabilities>,
): CompilerPackageCheckProvenance {
  return {
    compiler: { name: '@flighthq/tool-compiler', revision: unversionedRevision },
    target: { name: parsed.target === 'cpp' ? parsed.runtimeProfile : parsed.target, revision: unversionedRevision },
    upstream: {
      name: 'workspace',
      revision: capabilities.readUpstreamRevision?.(parsed.workspaceDirectory) ?? unversionedRevision,
    },
  };
}

function createCompilerCommandLineCheckBackendOptions(
  parsed: Readonly<ParsedCompilerCommandLineCheckRequest>,
): Record<string, unknown> {
  return parsed.target === 'cpp'
    ? {
        runtimeProfile: parsed.runtimeProfile,
        ...(parsed.runtimeHeader === undefined ? {} : { runtimeHeader: parsed.runtimeHeader }),
      }
    : {};
}

function createCompilerCommandLineBackend(parsed: Readonly<{ target: 'cpp' | 'haxe' | 'rust' }>) {
  return parsed.target === 'haxe'
    ? createHaxeCompilerBackend()
    : parsed.target === 'cpp'
      ? createCppCompilerBackend()
      : createRustCompilerBackend();
}

function describeCompilerCommandLineFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refuseCompilerCommandLineCheck(
  capabilities: Readonly<CompilerCommandLineCheckCapabilities>,
  text: string,
): CompilerCommandLineCheckRefusal {
  capabilities.writeError(text);
  return { exitCode: 2, reason: text.trimEnd() };
}

// What the compiler could not do, grouped by reason rather than listed by module. One rule blocking
// forty modules is one thing to decide about; forty lines are forty things to read.

const commandLineUsage = `Usage: flight-compile <source-directory> --target <cpp|haxe|rust> --out <directory>

  --package <name>        Package name the modules belong to (default: @local/source)
  --emission-mode <mode>  Haxe emission: extern or transpile (default: transpile)
  --root-package <name>   Root package for Haxe output (default: the target's own)
  --runtime-profile <id>  C++ runtime profile: flight-cpp or standard-library (default: flight-cpp)
  --runtime-header <path> Override the flight-cpp runtime include spelling
  --report                Report refusals without failing the run`;

interface ParsedCompilerCommandLineRequest {
  readonly emissionMode: HaxeCompilerEmissionMode;
  readonly outputDirectory: string;
  readonly packageName: string;
  readonly reportOnly: boolean;
  readonly rootPackage?: string | undefined;
  readonly runtimeHeader?: string | undefined;
  readonly runtimeProfile: 'flight-cpp' | 'standard-library';
  readonly sourceDirectory: string;
  readonly target: 'cpp' | 'haxe' | 'rust';
}

function parseCompilerCommandLineRequest(
  request: Readonly<CompilerCommandLineRequest>,
): ParsedCompilerCommandLineRequest | Readonly<{ failure: string }> {
  const positional: string[] = [];
  const named = new Map<string, string>();
  let reportOnly = false;
  for (let index = 0; index < request.argv.length; index += 1) {
    const argument = request.argv[index]!;
    if (argument === '--report') {
      reportOnly = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    if (!commandLineValueOptions.has(argument)) return { failure: `Unknown option ${argument}` };
    if (named.has(argument.slice(2))) return { failure: `${argument} may be supplied once` };
    const value = request.argv[index + 1];
    if (value === undefined || value.startsWith('--')) return { failure: `${argument} requires a value` };
    named.set(argument.slice(2), value);
    index += 1;
  }
  const sourceDirectory = positional[0];
  if (sourceDirectory === undefined) return { failure: 'A source directory is required' };
  if (positional.length > 1) return { failure: 'Exactly one source directory is required' };
  const target = named.get('target');
  if (target !== 'cpp' && target !== 'haxe' && target !== 'rust')
    return { failure: '--target must be cpp, haxe, or rust' };
  const outputDirectory = named.get('out');
  if (outputDirectory === undefined) return { failure: '--out is required' };
  const rootPackage = named.get('root-package');
  if (rootPackage !== undefined && target !== 'haxe') return { failure: '--root-package requires --target haxe' };
  const emissionMode = named.get('emission-mode') ?? 'transpile';
  if (emissionMode !== 'extern' && emissionMode !== 'transpile') {
    return { failure: '--emission-mode must be extern or transpile' };
  }
  if (named.has('emission-mode') && target !== 'haxe') {
    return { failure: '--emission-mode requires --target haxe' };
  }
  const runtimeProfile = named.get('runtime-profile') ?? 'flight-cpp';
  if (runtimeProfile !== 'flight-cpp' && runtimeProfile !== 'standard-library') {
    return { failure: '--runtime-profile must be flight-cpp or standard-library' };
  }
  const runtimeHeader = named.get('runtime-header');
  if ((named.has('runtime-profile') || runtimeHeader !== undefined) && target !== 'cpp') {
    return { failure: '--runtime-profile and --runtime-header require --target cpp' };
  }
  if (runtimeHeader !== undefined && (!isPortableIncludePath(runtimeHeader) || runtimeProfile !== 'flight-cpp')) {
    return {
      failure:
        runtimeProfile !== 'flight-cpp'
          ? '--runtime-header requires the flight-cpp runtime profile'
          : '--runtime-header must be a portable quoted-include path',
    };
  }
  return {
    emissionMode,
    outputDirectory,
    packageName: named.get('package') ?? '@local/source',
    reportOnly,
    ...(rootPackage === undefined ? {} : { rootPackage }),
    ...(runtimeHeader === undefined ? {} : { runtimeHeader }),
    runtimeProfile,
    sourceDirectory,
    target,
  };
}

function isPortableIncludePath(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && !/["<>\r\n]/u.test(value);
}

const commandLineValueOptions = new Set([
  '--emission-mode',
  '--out',
  '--package',
  '--root-package',
  '--runtime-header',
  '--runtime-profile',
  '--target',
]);

const refusalModuleSampleSize = 3;

// Checking a workspace without writing one.
//
// The same deterministic compilation the emit path runs, with the output-file capability simply absent:
// check mode cannot write generated sources because its capability record has nowhere to put them. The
// report goes to the caller's streams, and the exit code says which of three things happened -- the check
// admitted the workspace, it found something that gates, or the invocation itself could not be carried out.
// The machine-readable form: the three landed records the run produced, under one identity, with no
// ordering that depends on iteration. Each part keeps its own schema, so a consumer can read the report
// without reading this envelope's shape at all.
function createCompilerCommandLineCheckJson(result: Readonly<CompilerCommandLineCheckOutcome>): unknown {
  return {
    schema: 'flight-compiler-check-run/1',
    comparison: result.comparison,
    eligiblePackageNames: [...result.eligiblePackageNames],
    exitCode: result.exitCode,
    policyResult: result.policyResult,
    report: result.report,
  };
}

// A run that did not establish a revision says so. The field is a fact about the invocation, and a guess
// would make two different toolchains look like the same one.
const unversionedRevision = 'unversioned';

const commandLineCheckUsage = `Usage: flight-compile check <workspace> --target <cpp|haxe|rust>

  --environment <name>    Package environment to check (default: the workspace's unmarked packages)
  --package <name>        Package to check by name; repeat for several (default: the workspace's compatible
                          packages). A package that declares an environment needs --environment for it
  --baseline <file>       Compare findings against a baseline; the file is never rewritten
  --format <text|json>    Report format (default: text)
  --report <file>         Write the report to a file as well as printing the summary
  --runtime-profile <id>  C++ runtime profile: flight-cpp or standard-library (default: flight-cpp)
  --runtime-header <path> Override the flight-cpp runtime include spelling`;

interface ParsedCompilerCommandLineCheckRequest {
  readonly baselinePath?: string | undefined;
  readonly environment?: FlightPackageEnvironment | undefined;
  readonly format: CompilerCommandLineCheckFormat;
  readonly selectedPackageNames: readonly string[];
  readonly reportPath?: string | undefined;
  readonly runtimeHeader?: string | undefined;
  readonly runtimeProfile: 'flight-cpp' | 'standard-library';
  readonly target: 'cpp' | 'haxe' | 'rust';
  readonly workspaceDirectory: string;
}

function parseCompilerCommandLineCheckRequest(
  request: Readonly<CompilerCommandLineCheckRequest>,
): ParsedCompilerCommandLineCheckRequest | Readonly<{ failure: string }> {
  const positional: string[] = [];
  const named = new Map<string, string>();
  const selectedPackageNames: string[] = [];
  for (let index = 0; index < request.argv.length; index += 1) {
    const argument = request.argv[index]!;
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    if (!commandLineCheckValueOptions.has(argument)) return { failure: `Unknown option ${argument}` };
    const value = request.argv[index + 1];
    if (value === undefined || value.startsWith('--')) return { failure: `${argument} requires a value` };
    index += 1;
    if (argument === '--environment') {
      // One environment per run, deliberately: packages that target different environments have different
      // profiles behind them, so one report over two of them would compare findings that do not belong
      // together. Checking both means two runs, each with its own report and baseline.
      if (named.has('environment')) {
        return { failure: '--environment may be supplied once; check each environment in its own run' };
      }
    }
    if (argument === '--package') {
      if (selectedPackageNames.includes(value)) return { failure: `--package ${value} is supplied twice` };
      selectedPackageNames.push(value);
      continue;
    }
    if (named.has(argument.slice(2))) return { failure: `${argument} may be supplied once` };
    named.set(argument.slice(2), value);
  }
  const workspaceDirectory = positional[0];
  if (workspaceDirectory === undefined) return { failure: 'A workspace directory is required' };
  if (positional.length > 1) return { failure: 'Exactly one workspace directory is required' };
  const target = named.get('target');
  if (target !== 'cpp' && target !== 'haxe' && target !== 'rust') {
    return { failure: '--target must be cpp, haxe, or rust' };
  }
  const format = named.get('format') ?? 'text';
  if (format !== 'text' && format !== 'json') return { failure: '--format must be text or json' };
  const environmentName = named.get('environment');
  if (environmentName !== undefined && !commandLineCheckEnvironments.has(environmentName)) {
    return { failure: '--environment must be capacitor, electron, node, tauri, or web' };
  }
  const reportPath = named.get('report');
  if (reportPath !== undefined && reportPath.length === 0) return { failure: '--report requires a path' };
  const runtimeProfile = named.get('runtime-profile') ?? 'flight-cpp';
  if (runtimeProfile !== 'flight-cpp' && runtimeProfile !== 'standard-library') {
    return { failure: '--runtime-profile must be flight-cpp or standard-library' };
  }
  const runtimeHeader = named.get('runtime-header');
  if ((named.has('runtime-profile') || runtimeHeader !== undefined) && target !== 'cpp') {
    return { failure: '--runtime-profile and --runtime-header require --target cpp' };
  }
  return {
    ...(named.get('baseline') === undefined ? {} : { baselinePath: named.get('baseline')! }),
    ...(environmentName === undefined ? {} : { environment: environmentName as FlightPackageEnvironment }),
    format,
    ...(reportPath === undefined ? {} : { reportPath }),
    ...(runtimeHeader === undefined ? {} : { runtimeHeader }),
    runtimeProfile,
    selectedPackageNames,
    target,
    workspaceDirectory,
  };
}

// Which packages a run is about. The eligibility lane owns this question -- the declared
// `flight.environment`, the narrow name selector, and what an unmarked package means -- so the CLI hands it
// the workspace's packages and takes back names. The whole workspace goes in, not only the seeds, because
// the plan is what pulls in the dependencies a selection needs; the seeds are only what the caller asked
// for. Naming packages states the selection exactly and a refusal is then the answer; naming none takes the
// workspace's own compatible default, which is the packages that carry no environment. A refusal from the
// plan is an invocation failure, not a finding.
function selectCompilerCommandLinePackageNames(
  manifests: readonly Readonly<FlightPackageManifest>[],
  parsed: Readonly<ParsedCompilerCommandLineCheckRequest>,
): readonly string[] | Readonly<{ failure: string }> {
  const selectedPackageNames = manifests
    .filter((manifest) =>
      parsed.selectedPackageNames.length === 0
        ? manifest.environment === parsed.environment
        : parsed.selectedPackageNames.includes(manifest.name),
    )
    .map((manifest) => manifest.name);
  try {
    const plan = createFlightPackageEligibilityPlan({
      packages: manifests.map((manifest) => ({
        dependencies: manifest.dependencies,
        ...(manifest.environment === undefined ? {} : { environment: manifest.environment }),
        name: manifest.name,
      })),
      selectedPackageNames,
      ...(parsed.environment === undefined ? {} : { environment: parsed.environment }),
    });
    return [...plan.eligiblePackageNames].sort(compareTextCodeUnits);
  } catch (error) {
    if (isFlightPackageEligibilityFailure(error)) return { failure: error.message };
    throw error;
  }
}

// The environment names `--environment` accepts, spelled here the way `--target` spells its own values: the
// flag is this package's, so the message a typo earns is this package's too.
const commandLineCheckEnvironments = new Set(['capacitor', 'electron', 'node', 'tauri', 'web']);

const commandLineCheckValueOptions = new Set([
  '--baseline',
  '--environment',
  '--format',
  '--package',
  '--report',
  '--runtime-header',
  '--runtime-profile',
  '--target',
]);
