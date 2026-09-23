import { parse } from 'yaml';

// The invariants of the release path, read from the workflow documents rather than matched against their
// text.
//
// Releases are the one place this repository can act irreversibly from a distance: a dispatched payload
// decides whether a package reaches the public registry. The invariants here are the ones whose silent loss
// does not show up as a failing run -- an event type the sender no longer matches, a payload interpolated
// into a shell body, a concurrency group that lets two publishes overlap, a publish that runs before the
// gate -- so they are checked structurally, and each is mutation-proven by the test beside this file.
//
// This reads structure and nothing else: it does not publish, compute versions, or restate the pipeline.

export interface WorkflowJob {
  readonly job: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly steps: readonly Readonly<Record<string, unknown>>[];
}

export function collectReleaseBridgeIssues(name: string, contents: string): readonly string[] {
  const document = parseWorkflow(name, contents);
  if (document === undefined) return [`${name}: the workflow is not readable YAML`];

  const issues: string[] = [];
  collectTriggerIssues(issues, name, document);
  collectPayloadIssues(issues, name, document);
  collectRegistryIssues(issues, name, document);
  collectConcurrencyIssues(issues, name, document);
  collectPermissionIssues(issues, name, document);
  collectPublishOrderIssues(issues, name, document);
  collectTokenIssues(issues, name, document);
  return issues;
}

// The manual release and the bridge publish the same package, so they share one concurrency group: a group
// name is repository-wide, and two workflows that publish may not hold different ones.
export function collectReleaseWorkflowIssues(name: string, contents: string): readonly string[] {
  const document = parseWorkflow(name, contents);
  if (document === undefined) return [`${name}: the workflow is not readable YAML`];
  const issues: string[] = [];
  collectConcurrencyIssues(issues, name, document);
  return issues;
}

export function collectWorkflowJobs(document: Readonly<Record<string, unknown>>): readonly WorkflowJob[] {
  const jobs = asRecord(document.jobs);
  if (jobs === undefined) return [];
  return Object.entries(jobs).flatMap(([name, value]) => {
    const job = asRecord(value);
    return job === undefined ? [] : [{ job, name, steps: asRecords(job.steps) }];
  });
}

export function getStepRun(step: Readonly<Record<string, unknown>>): string {
  return typeof step.run === 'string' ? step.run : '';
}

export function getWorkflowSteps(
  document: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  return collectWorkflowJobs(document).flatMap((job) => job.steps);
}

function collectConcurrencyIssues(issues: string[], name: string, document: Readonly<Record<string, unknown>>): void {
  const concurrency = asRecord(document.concurrency);
  if (concurrency === undefined) {
    issues.push(`${name}: the workflow declares no concurrency group`);
    return;
  }
  if (concurrency.group !== releaseConcurrencyGroup) {
    issues.push(`${name}: concurrency group is ${String(concurrency.group)} rather than ${releaseConcurrencyGroup}`);
  }
  if (concurrency['cancel-in-progress'] !== false) {
    issues.push(`${name}: a running release must not be cancelled by the next one`);
  }
}

function collectPayloadIssues(issues: string[], name: string, document: Readonly<Record<string, unknown>>): void {
  for (const [index, step] of getWorkflowSteps(document).entries()) {
    if (getStepRun(step).includes('${{')) {
      issues.push(`${name}: step ${String(index + 1)} interpolates an expression into a shell body`);
    }
  }
  const environment: Record<string, unknown> = { ...asRecord(document.env) };
  for (const job of collectWorkflowJobs(document)) Object.assign(environment, asRecord(job.job.env));
  for (const variable of dispatchedFacts) {
    const value = environment[variable];
    if (typeof value !== 'string' || !value.includes('github.event.client_payload.') || !value.includes('inputs.')) {
      issues.push(`${name}: ${variable} is not derived from the dispatch and the manual inputs`);
    }
  }
}

function collectPermissionIssues(issues: string[], name: string, document: Readonly<Record<string, unknown>>): void {
  const permissions = asRecord(document.permissions);
  if (permissions === undefined) {
    issues.push(`${name}: the workflow declares no top-level permissions`);
  } else if (permissions.contents !== 'read') {
    issues.push(`${name}: top-level contents permission must be read`);
  } else {
    for (const [scope, value] of Object.entries(permissions)) {
      if (value !== 'read') issues.push(`${name}: top-level ${scope} permission is ${String(value)}`);
    }
  }
  const publishing = collectWorkflowJobs(document).filter((job) =>
    job.steps.some((step) => getStepRun(step).includes('npm publish')),
  );
  if (publishing.length !== 1) {
    issues.push(`${name}: exactly one job publishes, found ${String(publishing.length)}`);
    return;
  }
  const jobPermissions = asRecord(publishing[0]!.job.permissions);
  if (jobPermissions === undefined) {
    issues.push(`${name}: the publishing job declares no permissions`);
    return;
  }
  if (jobPermissions['id-token'] !== 'write') {
    issues.push(`${name}: publishing needs id-token write for provenance`);
  }
  if (jobPermissions.contents !== 'read') {
    issues.push(`${name}: the publishing job must keep contents read`);
  }
}

function collectPublishOrderIssues(issues: string[], name: string, document: Readonly<Record<string, unknown>>): void {
  const publishing = collectWorkflowJobs(document).filter((job) =>
    job.steps.some((step) => getStepRun(step).includes(publishCommand)),
  );
  if (publishing.length !== 1) {
    issues.push(`${name}: exactly one job publishes, found ${String(publishing.length)}`);
    return;
  }
  const steps = publishing[0]!.steps;
  const publishIndex = steps.findIndex((step) => getStepRun(step).includes(publishCommand));
  for (const gate of releaseGateCommands) {
    const gateIndex = steps.findIndex((step) => getStepRun(step).includes(gate));
    if (gateIndex === -1) issues.push(`${name}: the publishing job never runs \`${gate}\``);
    else if (gateIndex > publishIndex) issues.push(`${name}: \`${gate}\` runs after \`${publishCommand}\``);
  }
}

function collectRegistryIssues(issues: string[], name: string, document: Readonly<Record<string, unknown>>): void {
  const steps = getWorkflowSteps(document);
  const registries = steps
    .map((step) => asRecord(step.with)?.['registry-url'])
    .filter((value): value is string => typeof value === 'string');
  if (!registries.includes(publicRegistry)) {
    issues.push(`${name}: no step points setup-node at ${publicRegistry}`);
  }
  for (const step of steps) {
    const override = /--registry[= ](\S+)/u.exec(getStepRun(step));
    if (override !== null && override[1] !== publicRegistry) {
      issues.push(`${name}: a step reads or publishes through ${override[1]}`);
    }
  }
}

function collectTokenIssues(issues: string[], name: string, document: Readonly<Record<string, unknown>>): void {
  const steps = getWorkflowSteps(document);
  for (const [index, step] of steps.entries()) {
    if (typeof asRecord(step.env)?.NODE_AUTH_TOKEN !== 'string') continue;
    if (!getStepRun(step).includes(publishCommand)) {
      issues.push(`${name}: step ${String(index + 1)} carries the registry token without publishing`);
    }
  }
  const publish = steps.find((step) => getStepRun(step).includes(publishCommand));
  if (publish === undefined) {
    issues.push(`${name}: no step publishes`);
    return;
  }
  const condition = publish.if;
  if (typeof condition !== 'string' || !/dry[_-]run/iu.test(condition)) {
    issues.push(`${name}: publishing is not conditioned on the rehearsal input`);
  }
}

function collectTriggerIssues(issues: string[], name: string, document: Readonly<Record<string, unknown>>): void {
  const on = asRecord(document.on);
  if (on === undefined) {
    issues.push(`${name}: the workflow declares no triggers`);
    return;
  }
  const types = asRecord(on.repository_dispatch)?.types;
  if (!Array.isArray(types) || types.length !== 1 || types[0] !== releaseEventType) {
    issues.push(`${name}: repository_dispatch types must be exactly [${releaseEventType}]`);
  }
  const manual = asRecord(asRecord(on.workflow_dispatch)?.inputs);
  if (manual === undefined) {
    issues.push(`${name}: no manual dispatch inputs, so a lost delivery cannot be replayed`);
    return;
  }
  for (const input of recoveryInputs) {
    const declaration = asRecord(manual[input]);
    if (declaration === undefined || declaration.required !== true) {
      issues.push(`${name}: manual input ${input} must be required`);
    }
  }
  const rehearsal = asRecord(manual[rehearsalInput]);
  if (rehearsal === undefined || rehearsal.type !== 'boolean' || rehearsal.default !== true) {
    issues.push(`${name}: a manual dispatch must rehearse unless it is armed`);
  }
}

function parseWorkflow(name: string, contents: string): Readonly<Record<string, unknown>> | undefined {
  try {
    return asRecord(parse(contents));
  } catch {
    // A document the parser cannot read is reported as an unreadable workflow rather than as a stack: this
    // runs on every check, and a malformed workflow is a finding.
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRecords(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    return record === undefined ? [] : [record];
  });
}

// The one event type Flight dispatches, the two facts every run needs, and the rehearsal default. These
// names are the sending contract: changing one here changes what Flight has to send.
const releaseConcurrencyGroup = 'release-global';
const releaseEventType = 'flight-release';
const publicRegistry = 'https://registry.npmjs.org';
const publishCommand = 'npm publish';
const rehearsalInput = 'dry_run';
const dispatchedFacts = ['FLIGHT_VERSION', 'FLIGHT_COMMIT'] as const;
const recoveryInputs = ['flight_version', 'flight_commit'] as const;
const releaseGateCommands = ['npm run ci', 'npm run smoke'] as const;
