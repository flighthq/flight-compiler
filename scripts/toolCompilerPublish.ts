import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolCompilerPackageName = '@flighthq/tool-compiler';
const toolCompilerVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;

export interface ToolCompilerPublishCapabilities {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly npmCommand: string;
  readonly readTextFile: (file: string) => string;
  readonly rootDirectory: string;
  readonly runProcess: (
    command: string,
    arguments_: readonly string[],
    options: Readonly<{ cwd: string; env: Readonly<NodeJS.ProcessEnv> }>,
  ) => Readonly<ToolCompilerPublishProcessResult>;
}

export interface ToolCompilerPublishOptions {
  readonly dryRun: boolean;
  readonly tag: ToolCompilerDistributionTag;
}

export interface ToolCompilerPublishProcessResult {
  readonly errorMessage?: string | undefined;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ToolCompilerPublishResult {
  readonly kind: 'dry-run' | 'published' | 'skipped';
  readonly message: string;
  readonly packageName: typeof toolCompilerPackageName;
  readonly tag: string;
  readonly version: string;
}

export type ToolCompilerDistributionTag = (typeof toolCompilerDistributionTags)[number];

export function parseToolCompilerPublishArguments(arguments_: readonly string[]): ToolCompilerPublishOptions {
  let dryRun = false;
  let tag: ToolCompilerDistributionTag | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--dry-run') {
      if (dryRun) throw new TypeError('Duplicate tool-compiler publish option --dry-run.');
      dryRun = true;
      continue;
    }
    if (argument === '--tag') {
      if (tag !== undefined) throw new TypeError('Duplicate tool-compiler publish option --tag.');
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new TypeError('Tool-compiler publish option --tag requires a value.');
      }
      assertToolCompilerDistributionTag(value);
      tag = value;
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown tool-compiler publish option ${argument ?? '<missing>'}.`);
  }
  if (tag === undefined) throw new TypeError('Tool-compiler publish option --tag is required.');
  return { dryRun, tag };
}

export function publishToolCompilerPackage(
  options: Readonly<ToolCompilerPublishOptions>,
  capabilities: Readonly<ToolCompilerPublishCapabilities>,
): ToolCompilerPublishResult {
  assertToolCompilerDistributionTag(options.tag);
  const packageDirectory = path.join(capabilities.rootDirectory, 'packages', 'tool-compiler');
  const manifestPath = path.join(packageDirectory, 'package.json');
  const manifest = readToolCompilerManifest(manifestPath, capabilities.readTextFile);
  const version = assertToolCompilerManifest(manifest);
  if (options.tag === 'latest' && version.includes('-')) {
    throw new TypeError(`Refusing to publish prerelease ${toolCompilerPackageName}@${version} with tag latest.`);
  }
  const registry = runNpm(['view', toolCompilerPackageName, 'versions', '--json'], packageDirectory, capabilities);
  const versions = readRegistryVersions(registry);
  if (versions.includes(version)) {
    return {
      kind: 'skipped',
      message: `[release] skip ${toolCompilerPackageName}@${version}: version already published.\n`,
      packageName: toolCompilerPackageName,
      tag: options.tag,
      version,
    };
  }

  const publishArguments = ['publish', '--access', 'public', '--tag', options.tag];
  if (options.dryRun) publishArguments.push('--dry-run');
  const published = runNpm(publishArguments, packageDirectory, capabilities);
  if (published.status !== 0) {
    throw new Error(
      `npm publish failed for ${toolCompilerPackageName}@${version} (${describeProcessStatus(published)}).${describeProcessOutput(published)}`,
    );
  }
  return options.dryRun
    ? {
        kind: 'dry-run',
        message: `[release] dry run complete for ${toolCompilerPackageName}@${version} with tag ${options.tag}: package built and packed; nothing uploaded.\n`,
        packageName: toolCompilerPackageName,
        tag: options.tag,
        version,
      }
    : {
        kind: 'published',
        message: `[release] published ${toolCompilerPackageName}@${version} with tag ${options.tag}.\n`,
        packageName: toolCompilerPackageName,
        tag: options.tag,
        version,
      };
}

interface ToolCompilerManifest {
  readonly name?: unknown;
  readonly private?: unknown;
  readonly publishConfig?: unknown;
  readonly version?: unknown;
}

function assertToolCompilerDistributionTag(tag: string): asserts tag is ToolCompilerDistributionTag {
  if (!toolCompilerDistributionTags.includes(tag as ToolCompilerDistributionTag)) {
    throw new TypeError(
      `Unsupported tool-compiler npm distribution tag ${JSON.stringify(tag)}; expected ${toolCompilerDistributionTags.join(', ')}.`,
    );
  }
}

function assertToolCompilerManifest(manifest: Readonly<ToolCompilerManifest>): string {
  if (manifest.name !== toolCompilerPackageName) {
    throw new TypeError(`Public package must be named ${toolCompilerPackageName}.`);
  }
  if (manifest.private !== undefined && manifest.private !== false) {
    throw new TypeError(`${toolCompilerPackageName} must be public.`);
  }
  if (!isRecord(manifest.publishConfig) || manifest.publishConfig.access !== 'public') {
    throw new TypeError(`${toolCompilerPackageName} must declare publishConfig.access as public.`);
  }
  if (typeof manifest.version !== 'string' || !isSemanticVersion(manifest.version)) {
    throw new TypeError(`${toolCompilerPackageName} has an invalid stamped version.`);
  }
  return manifest.version;
}

function describeProcessOutput(result: Readonly<ToolCompilerPublishProcessResult>): string {
  const details = [result.stderr.trim(), result.stdout.trim(), result.errorMessage?.trim()]
    .filter((detail): detail is string => detail !== undefined && detail.length > 0)
    .join('\n');
  return details.length === 0 ? '' : `\n${details}`;
}

function describeProcessStatus(result: Readonly<ToolCompilerPublishProcessResult>): string {
  return result.status === null ? 'process did not exit normally' : `exit ${String(result.status)}`;
}

function isNpmPackageAbsent(result: Readonly<ToolCompilerPublishProcessResult>): boolean {
  if (result.status === null || result.status === 0 || result.errorMessage !== undefined) return false;
  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    return /(?:^|\r?\n)npm (?:ERR!|error) code E404(?:\r?\n|$)/u.test(result.stderr);
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return false;
  }
  return isRecord(value) && isRecord(value.error) && value.error.code === 'E404';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSemanticVersion(version: string): boolean {
  return toolCompilerVersionPattern.test(version);
}

function readRegistryVersions(result: Readonly<ToolCompilerPublishProcessResult>): readonly string[] {
  if (isNpmPackageAbsent(result)) return [];
  if (result.status !== 0) {
    throw new Error(`npm registry query failed (${describeProcessStatus(result)}).${describeProcessOutput(result)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm registry query returned invalid JSON.${describeProcessOutput(result)}`);
  }
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || !value.every((version) => typeof version === 'string')) {
    throw new TypeError('npm registry query returned a versions value other than strings.');
  }
  return value;
}

function readToolCompilerManifest(manifestPath: string, readTextFile: (file: string) => string): ToolCompilerManifest {
  let value: unknown;
  try {
    value = JSON.parse(readTextFile(manifestPath));
  } catch (error) {
    throw new TypeError(`Unable to read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new TypeError(`${manifestPath} must contain a JSON object.`);
  return value;
}

function runNpm(
  arguments_: readonly string[],
  packageDirectory: string,
  capabilities: Readonly<ToolCompilerPublishCapabilities>,
): Readonly<ToolCompilerPublishProcessResult> {
  return capabilities.runProcess(capabilities.npmCommand, [...arguments_], {
    cwd: packageDirectory,
    env: capabilities.environment,
  });
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolCompilerDistributionTags = ['latest', 'edge', 'next'] as const;
const entryPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    const result = publishToolCompilerPackage(parseToolCompilerPublishArguments(process.argv.slice(2)), {
      environment: process.env,
      npmCommand: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      readTextFile: (file) => readFileSync(file, 'utf8'),
      rootDirectory: root,
      runProcess: (command, arguments_, options) => {
        const child = spawnSync(command, [...arguments_], {
          cwd: options.cwd,
          encoding: 'utf8',
          env: { ...options.env },
        });
        return {
          ...(child.error === undefined ? {} : { errorMessage: child.error.message }),
          status: child.status,
          stderr: child.stderr,
          stdout: child.stdout,
        };
      },
    });
    process.stdout.write(result.message);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
