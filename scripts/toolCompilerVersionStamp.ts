import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

export interface ToolCompilerVersionStampInput {
  readonly version: string;
  readonly workspaceDirectory: string;
}

export interface ToolCompilerVersionStampResult {
  readonly changed: boolean;
  readonly manifestPath: string;
  readonly previousVersion: string;
  readonly version: string;
}

interface ManifestVersionLocation {
  readonly end: number;
  readonly start: number;
  readonly version: string;
}

interface CommandOptions extends ToolCompilerVersionStampInput {
  readonly checkOnly: boolean;
}

const semanticVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const toolCompilerManifestSegments = ['packages', 'tool-compiler', 'package.json'] as const;

export function checkToolCompilerVersionStamp(
  input: Readonly<ToolCompilerVersionStampInput>,
): Readonly<ToolCompilerVersionStampResult> {
  return prepareToolCompilerVersionStamp(input).result;
}

export function stampToolCompilerVersion(
  input: Readonly<ToolCompilerVersionStampInput>,
): Readonly<ToolCompilerVersionStampResult> {
  const prepared = prepareToolCompilerVersionStamp(input);
  if (prepared.result.changed) writeFileSync(prepared.result.manifestPath, prepared.contents, 'utf8');
  return prepared.result;
}

function assertReleaseVersion(version: unknown): asserts version is string {
  if (typeof version !== 'string' || !semanticVersionPattern.test(version)) {
    throw new TypeError('Tool compiler version must be a strict SemVer release or prerelease without build metadata.');
  }
}

function inspectManifestVersion(contents: string, manifestPath: string): ManifestVersionLocation {
  let manifest: unknown;
  try {
    manifest = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`Tool compiler manifest is not valid JSON: ${manifestPath}`, { cause: error });
  }

  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error(`Tool compiler manifest must contain a top-level object: ${manifestPath}`);
  }

  const parsedVersion = (manifest as Record<string, unknown>).version;
  if (typeof parsedVersion !== 'string') {
    throw new Error(`Tool compiler manifest must contain one top-level string version: ${manifestPath}`);
  }
  assertReleaseVersion(parsedVersion);

  const sourceFile = ts.parseJsonText(manifestPath, contents);
  const statement = sourceFile.statements[0];
  if (
    sourceFile.statements.length !== 1 ||
    !statement ||
    !ts.isExpressionStatement(statement) ||
    !ts.isObjectLiteralExpression(statement.expression)
  ) {
    throw new Error(`Tool compiler manifest must contain a top-level object: ${manifestPath}`);
  }

  const versionProperties = statement.expression.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.name) && property.name.text === 'version',
  );
  const versionProperty = versionProperties[0];
  if (versionProperties.length !== 1 || !versionProperty || !ts.isStringLiteralLike(versionProperty.initializer)) {
    throw new Error(`Tool compiler manifest must contain one top-level string version: ${manifestPath}`);
  }

  return {
    end: versionProperty.initializer.getEnd(),
    start: versionProperty.initializer.getStart(sourceFile),
    version: parsedVersion,
  };
}

function prepareToolCompilerVersionStamp(input: Readonly<ToolCompilerVersionStampInput>): {
  readonly contents: string;
  readonly result: Readonly<ToolCompilerVersionStampResult>;
} {
  assertReleaseVersion(input.version);
  if (typeof input.workspaceDirectory !== 'string' || !path.isAbsolute(input.workspaceDirectory)) {
    throw new TypeError('Tool compiler version stamping requires an absolute workspace directory.');
  }

  const manifestPath = path.join(input.workspaceDirectory, ...toolCompilerManifestSegments);
  const originalContents = readFileSync(manifestPath, 'utf8');
  const current = inspectManifestVersion(originalContents, manifestPath);
  const changed = current.version !== input.version;
  const contents = changed
    ? `${originalContents.slice(0, current.start)}${JSON.stringify(input.version)}${originalContents.slice(current.end)}`
    : originalContents;

  return {
    contents,
    result: Object.freeze({
      changed,
      manifestPath,
      previousVersion: current.version,
      version: input.version,
    }),
  };
}

function parseCommandOptions(arguments_: readonly string[]): CommandOptions {
  let checkOnly = false;
  let version: string | undefined;
  let workspaceDirectory: string | undefined;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === '--check') {
      if (checkOnly) throw new Error('The --check option may only be specified once.');
      checkOnly = true;
      continue;
    }
    if (argument === '--workspace') {
      if (workspaceDirectory !== undefined) throw new Error('The --workspace option may only be specified once.');
      workspaceDirectory = arguments_[index + 1];
      if (workspaceDirectory === undefined) throw new Error('The --workspace option requires a path.');
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    if (version !== undefined) throw new Error(`Unexpected argument: ${argument}`);
    version = argument;
  }

  if (version === undefined) throw new Error('A tool compiler release version is required.');
  return {
    checkOnly,
    version,
    workspaceDirectory: workspaceDirectory ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  };
}

function runCommand(arguments_: readonly string[]): void {
  const options = parseCommandOptions(arguments_);
  const input = { version: options.version, workspaceDirectory: options.workspaceDirectory };
  const result = options.checkOnly ? checkToolCompilerVersionStamp(input) : stampToolCompilerVersion(input);

  if (options.checkOnly) {
    const state = result.changed
      ? `${result.previousVersion} -> ${result.version}`
      : `${result.version} (already stamped)`;
    process.stdout.write(`Tool compiler version is valid: ${state} (check only)\n`);
  } else if (result.changed) {
    process.stdout.write(`Tool compiler version stamped: ${result.previousVersion} -> ${result.version}\n`);
  } else {
    process.stdout.write(`Tool compiler version already stamped: ${result.version}\n`);
  }
}

const invokedScriptPath = process.argv[1];
if (invokedScriptPath && path.resolve(invokedScriptPath) === fileURLToPath(import.meta.url)) {
  try {
    runCommand(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
