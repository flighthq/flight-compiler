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
  collectCheckoutIssues(issues, name, document);
  collectDistributionTagPolicyIssues(issues, name, document);
  collectRegistryIssues(issues, name, document);
  collectReleaseBridgeConcurrencyIssues(issues, name, document);
  collectPermissionIssues(issues, name, document);
  collectPublishOrderIssues(issues, name, document);
  collectTokenIssues(issues, name, document);
  return issues;
}

// The direct workflow is the stable lane. Its literal group must collide with both manual bridge runs and
// stable dispatches, while prerelease tags retain independent lanes.
export function collectReleaseWorkflowIssues(name: string, contents: string): readonly string[] {
  const document = parseWorkflow(name, contents);
  if (document === undefined) return [`${name}: the workflow is not readable YAML`];
  const issues: string[] = [];
  collectStableConcurrencyIssues(issues, name, document);
  collectStablePublisherIssues(issues, name, document);
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

// Whether a step is the one that reaches the registry: the root release publisher, and nothing else. A raw
// `npm publish` is not accepted, because the idempotent publisher owns the registry read, the ordering, and
// the provenance attestation; a step that bypassed it would publish without them.
export function isPublishStep(step: Readonly<Record<string, unknown>>): boolean {
  return publishStepPattern.test(getStepRun(step));
}

// Whether a step stamps the version. The stamp command has two modes -- `--check` validates what the manifest
// already carries, and the bare invocation rewrites it -- and only the second one is the stamp: counting the
// validation as the stamp would place the real stamp before the gates that are supposed to run ahead of it.
export function isStampStep(step: Readonly<Record<string, unknown>>): boolean {
  const run = getStepRun(step);
  return run.includes(stampCommand) && !run.includes('--check');
}

export function getWorkflowSteps(
  document: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  return collectWorkflowJobs(document).flatMap((job) => job.steps);
}

function collectReleaseBridgeConcurrencyIssues(
  issues: string[],
  name: string,
  document: Readonly<Record<string, unknown>>,
): void {
  const concurrency = asRecord(document.concurrency);
  if (concurrency === undefined) {
    issues.push(`${name}: the workflow declares no concurrency group`);
    return;
  }
  const group = concurrency.group;
  const distributionTag = getDispatchedFact(document, distributionTagVariable);
  const expected = typeof distributionTag === 'string' ? `${releaseConcurrencyPrefix}-${distributionTag}` : undefined;
  if (group !== expected) {
    issues.push(
      `${name}: concurrency must use the same effective ${distributionTagVariable} expression as the release job`,
    );
  }
  if (concurrency['cancel-in-progress'] !== false) {
    issues.push(`${name}: a running release must not be cancelled by the next one`);
  }
}

function collectStableConcurrencyIssues(
  issues: string[],
  name: string,
  document: Readonly<Record<string, unknown>>,
): void {
  const concurrency = asRecord(document.concurrency);
  if (concurrency === undefined) {
    issues.push(`${name}: the workflow declares no concurrency group`);
    return;
  }
  if (concurrency.group !== stableReleaseConcurrencyGroup) {
    issues.push(
      `${name}: concurrency group is ${String(concurrency.group)} rather than ${stableReleaseConcurrencyGroup}`,
    );
  }
  if (concurrency['cancel-in-progress'] !== false) {
    issues.push(`${name}: a running release must not be cancelled by the next one`);
  }
}

function collectStablePublisherIssues(
  issues: string[],
  name: string,
  document: Readonly<Record<string, unknown>>,
): void {
  const steps = getWorkflowSteps(document);
  collectRawPublishIssues(issues, name, steps);
  const publishing = steps.filter((step) => isPublishStep(step));
  const commands = publishing.flatMap((step) => getPublisherCommands(step));
  if (commands.length === 0) {
    issues.push(`${name}: no step publishes through the root release publisher`);
    return;
  }
  if (commands.some((command) => !stablePublisherTagPattern.test(command))) {
    issues.push(`${name}: the direct release publisher must use the stable latest tag`);
  }
  if (
    !publishing.some(
      (step) =>
        typeof step.if === 'string' &&
        step.if.includes("github.event_name == 'workflow_dispatch'") &&
        step.if.includes('inputs.publish'),
    )
  ) {
    issues.push(`${name}: the stable publish must remain gated by the manual publish input`);
  }
  collectMisplacedTokenIssues(issues, name, steps);
}

function collectPayloadIssues(issues: string[], name: string, document: Readonly<Record<string, unknown>>): void {
  for (const [index, step] of getWorkflowSteps(document).entries()) {
    if (getStepRun(step).includes('${{')) {
      issues.push(`${name}: step ${String(index + 1)} interpolates an expression into a shell body`);
    }
  }
  for (const variable of dispatchedFacts) {
    const value = getDispatchedFact(document, variable);
    if (typeof value !== 'string' || !value.includes('github.event.client_payload.') || !value.includes('inputs.')) {
      issues.push(`${name}: ${variable} is not derived from the dispatch and the manual inputs`);
    }
  }
  const distributionTag = getDispatchedFact(document, distributionTagVariable);
  if (typeof distributionTag !== 'string' || !distributionTag.includes(dispatchDistributionTag)) {
    issues.push(`${name}: ${distributionTagVariable} is not read from the authoritative dispatch dist_tag`);
  }
  if (typeof distributionTag !== 'string' || referencedInput(distributionTag, 'inputs.') === undefined) {
    issues.push(`${name}: ${distributionTagVariable} is not read from a manual input for recovery`);
  }
}

// The Flight commit is provenance, not the source of this repository. A receiver that checks out that commit
// either fails or, worse, runs a same-named compiler commit instead of the compiler's default branch.
function collectCheckoutIssues(issues: string[], name: string, document: Readonly<Record<string, unknown>>): void {
  const checkoutSteps = getWorkflowSteps(document).filter(
    (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
  );
  if (checkoutSteps.length !== 1) {
    issues.push(
      `${name}: exactly one step must check out the compiler repository, found ${String(checkoutSteps.length)}`,
    );
    return;
  }
  if (asRecord(checkoutSteps[0]!.with)?.ref !== compilerDefaultBranchExpression) {
    issues.push(
      `${name}: checkout must use the compiler repository default branch, not the informational Flight commit`,
    );
  }
  for (const [index, step] of getWorkflowSteps(document).entries()) {
    const run = getStepRun(step);
    const nonRunFields = JSON.stringify({ ...step, run: undefined });
    const usesCommitOutsideSummary =
      nonRunFields.includes(dispatchedCommitVariable) ||
      nonRunFields.includes(dispatchCommit) ||
      ((run.includes(dispatchedCommitVariable) || run.includes(dispatchCommit)) &&
        !run.includes('$GITHUB_STEP_SUMMARY'));
    if (usesCommitOutsideSummary) {
      issues.push(`${name}: step ${String(index + 1)} uses the informational Flight commit outside the run summary`);
    }
  }
}

// The workflow rejects a malformed dispatch before it stamps or queries the registry. The publisher repeats
// this policy at the final boundary; keeping the receiver check means a bad dispatch fails with its own facts.
function collectDistributionTagPolicyIssues(
  issues: string[],
  name: string,
  document: Readonly<Record<string, unknown>>,
): void {
  const runs = getWorkflowSteps(document).map((step) => getStepRun(step));
  const allowlist = runs.some(
    (run) =>
      /case\s+"\$\{?FLIGHT_DIST_TAG\}?"\s+in/u.test(run) &&
      /latest\s*\|\s*edge\s*\|\s*next\s*\)/u.test(run) &&
      /\*\s*\)[\s\S]*?exit\s+1/u.test(run),
  );
  if (!allowlist) {
    issues.push(`${name}: no guard restricts ${distributionTagVariable} to latest, edge, or next`);
  }
  const prereleaseLatest = runs.some(
    (run) =>
      /"\$\{?FLIGHT_DIST_TAG\}?"\s*=\s*latest/u.test(run) &&
      /"\$\{?FLIGHT_VERSION\}?"\s*==\s*\*-\*/u.test(run) &&
      /exit\s+1/u.test(run),
  );
  if (!prereleaseLatest) {
    issues.push(`${name}: no guard prevents a prerelease version from using the latest tag`);
  }
}

// The environment a dispatched fact is read from, wherever the workflow declares it: the dispatched payload
// first, the manual input second, which is what makes one workflow serve both.
function getDispatchedFact(document: Readonly<Record<string, unknown>>, variable: string): unknown {
  let value: unknown;
  for (const job of collectWorkflowJobs(document)) {
    const declared = asRecord(job.job.env)?.[variable];
    if (declared !== undefined) value = declared;
  }
  return value ?? asRecord(document.env)?.[variable];
}

function referencedInput(expression: unknown, prefix: string): string | undefined {
  if (typeof expression !== 'string') return undefined;
  const match = new RegExp(`${prefix.replace('.', '\\.')}([A-Za-z_][A-Za-z0-9_-]*)`, 'u').exec(expression);
  return match?.[1];
}

// What may be granted: read everywhere, writes only where the registry attestation needs them. A scope is
// judged by the permission in force -- the job's own if it declares any, the workflow's otherwise -- because a
// job that declares none inherits the workflow's, and a check that insisted on one placement would report a
// least-privilege workflow as unprivileged in the wrong direction.
function collectPermissionIssues(issues: string[], name: string, document: Readonly<Record<string, unknown>>): void {
  const workflowPermissions = asRecord(document.permissions);
  if (workflowPermissions === undefined) {
    issues.push(`${name}: the workflow declares no permissions`);
  } else {
    for (const [scope, value] of Object.entries(workflowPermissions)) {
      const permitted = value === 'read' || (scope === 'id-token' && value === 'write');
      if (!permitted) issues.push(`${name}: the workflow grants ${scope} ${String(value)}`);
    }
  }
  const publishing = collectWorkflowJobs(document).filter((job) => job.steps.some((step) => isPublishStep(step)));
  if (publishing.length !== 1) {
    issues.push(`${name}: exactly one job publishes, found ${String(publishing.length)}`);
    return;
  }
  const effective = asRecord(publishing[0]!.job.permissions) ?? workflowPermissions;
  if (effective === undefined) {
    issues.push(`${name}: the publishing job is granted nothing, so it cannot publish`);
    return;
  }
  for (const [scope, value] of Object.entries(effective)) {
    const permitted = value === 'read' || (scope === 'id-token' && value === 'write');
    if (!permitted) issues.push(`${name}: the publishing job is granted ${scope} ${String(value)}`);
  }
  if (effective['id-token'] !== 'write') {
    issues.push(`${name}: publishing needs id-token write for provenance`);
  }
  if (effective.contents !== 'read') {
    issues.push(`${name}: the publishing job must keep contents read`);
  }
}

// The pipeline order, as the contract states it: the static sweep and the isolated package tests before the
// version is stamped, the packed-consumer proofs after it, and the publish last. The stamp sits between them
// because it is the point of no return for what is being released: everything before it judges the source,
// everything after it judges the artifact that would reach the registry.
function collectPublishOrderIssues(issues: string[], name: string, document: Readonly<Record<string, unknown>>): void {
  const publishing = collectWorkflowJobs(document).filter((job) => job.steps.some((step) => isPublishStep(step)));
  if (publishing.length !== 1) {
    issues.push(`${name}: exactly one job publishes, found ${String(publishing.length)}`);
    return;
  }
  const steps = publishing[0]!.steps;
  const order = new Map<string, number>();
  for (const [index, step] of steps.entries()) {
    if (isStampStep(step) && !order.has(stampCommand)) order.set(stampCommand, index);
    for (const command of [...preStampCommands, ...postStampCommands]) {
      if (getStepRun(step).includes(command) && !order.has(command)) order.set(command, index);
    }
  }
  const publishIndex = steps.findIndex((step) => isPublishStep(step));
  const stampStep = steps.find((step) => isStampStep(step));
  const stampIndex = order.get(stampCommand);
  if (stampIndex === undefined) {
    issues.push(`${name}: nothing stamps the compiler version with \`${stampCommand}\``);
  }
  for (const command of preStampCommands) {
    const index = order.get(command);
    if (index === undefined) issues.push(`${name}: the publishing job never runs \`${command}\``);
    else if (stampIndex !== undefined && index > stampIndex) {
      issues.push(`${name}: \`${command}\` runs after the version is stamped`);
    }
  }
  for (const command of postStampCommands) {
    const index = order.get(command);
    if (index === undefined) issues.push(`${name}: the publishing job never runs \`${command}\``);
    else if (stampIndex !== undefined && index < stampIndex) {
      issues.push(`${name}: \`${command}\` runs before the version is stamped`);
    } else if (index > publishIndex) {
      issues.push(`${name}: \`${command}\` runs after the publish step`);
    }
  }
  // The release waits until the upstream version is actually visible on the registry. A dispatch can arrive
  // before npm's own propagation has caught up with Flight's publish, and a compiler released against a
  // version nobody can install is a release that describes a graph that does not exist yet.
  const waits = steps.some(
    (step) => !isStampStep(step) && /npm view\b/u.test(getStepRun(step)) && /\$\{?[A-Za-z_]/u.test(getStepRun(step)),
  );
  if (!waits) {
    issues.push(`${name}: nothing waits for the upstream release to be visible on the registry`);
  }
  const stampRun = stampStep === undefined ? undefined : getStepRun(stampStep);
  if (stampRun !== undefined) {
    // Policy: the compiler is stamped to the version Flight dispatched. A stamp that carries a literal, or
    // that reads the checkout's own placeholder, publishes a version nobody released.
    if (!/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/u.test(stampRun)) {
      issues.push(`${name}: the stamp does not read its version from the environment`);
    }
    if (/\b\d+\.\d+\.\d+\b/u.test(stampRun)) {
      issues.push(`${name}: the stamp carries a version literal`);
    }
  }
  for (const step of steps) {
    const run = getStepRun(step);
    for (const forbidden of forbiddenPipelineCommands) {
      if (run.includes(forbidden)) {
        issues.push(`${name}: the release pipeline runs \`${forbidden}\``);
      }
    }
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

function collectMisplacedTokenIssues(
  issues: string[],
  name: string,
  steps: readonly Readonly<Record<string, unknown>>[],
): void {
  for (const [index, step] of steps.entries()) {
    if (typeof asRecord(step.env)?.NODE_AUTH_TOKEN !== 'string') continue;
    if (!isPublishStep(step)) {
      issues.push(`${name}: step ${String(index + 1)} carries the registry token without publishing`);
    }
  }
}

function collectRawPublishIssues(
  issues: string[],
  name: string,
  steps: readonly Readonly<Record<string, unknown>>[],
): void {
  for (const [index, step] of steps.entries()) {
    if (/\bnpm publish\b/u.test(getStepRun(step))) {
      issues.push(`${name}: step ${String(index + 1)} publishes with a raw npm publish`);
    }
  }
}

function getPublisherCommands(step: Readonly<Record<string, unknown>>): readonly string[] {
  return getStepRun(step)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => publishStepPattern.test(line));
}

function collectTokenIssues(issues: string[], name: string, document: Readonly<Record<string, unknown>>): void {
  const steps = getWorkflowSteps(document);
  // A raw `npm publish` reaches the registry without the idempotency read, the tag, or the ordering the root
  // publisher owns. The workflow is allowed exactly one way in.
  collectRawPublishIssues(issues, name, steps);
  collectMisplacedTokenIssues(issues, name, steps);
  const publishing = steps.filter((step) => isPublishStep(step));
  if (publishing.length === 0) {
    issues.push(`${name}: no step publishes through the root release publisher`);
    return;
  }
  const commands = publishing.flatMap((step) => getPublisherCommands(step));
  if (commands.some((command) => !environmentPublisherTagPattern.test(command))) {
    issues.push(`${name}: every root release publisher invocation must receive --tag from ${distributionTagVariable}`);
  }
  if (!commands.some((command) => !/--dry[_-]run\b/u.test(command))) {
    issues.push(`${name}: no root release publisher invocation can perform the release`);
  }
  // A rehearsal must be possible without the registry token. Either route proves it: the publisher is invoked
  // in a rehearsal mode, or the step that would publish is conditioned on the rehearsal input. What is not
  // acceptable is a publish step that runs unconditionally, because then the only way to rehearse is to not
  // run the workflow at all.
  const rehearses =
    publishing.some((step) => /--dry[_-]run\b/u.test(getStepRun(step))) ||
    publishing.some((step) => typeof step.if === 'string' && /dry[_-]run/iu.test(step.if));
  if (!rehearses) {
    issues.push(`${name}: nothing rehearses: the publisher is neither invoked with --dry-run nor conditional`);
  }
}

function collectTriggerIssues(issues: string[], name: string, document: Readonly<Record<string, unknown>>): void {
  const on = asRecord(document.on);
  if (on === undefined) {
    issues.push(`${name}: the workflow declares no triggers`);
    return;
  }
  const types = asRecord(on.repository_dispatch)?.types;
  if (!isExactStringSet(types, releaseEventTypes)) {
    issues.push(`${name}: repository_dispatch types must be exactly [${releaseEventTypes.join(', ')}]`);
  }
  const manual = asRecord(asRecord(on.workflow_dispatch)?.inputs);
  if (manual === undefined) {
    issues.push(`${name}: no manual dispatch inputs, so a lost delivery cannot be replayed`);
    return;
  }
  // The version is what a recovery run must not be able to omit: it drives the stamp, so without it the run
  // releases nothing or releases the wrong thing. The commit is provenance for the run summary -- the
  // artifact is identical either way -- so a receiver may take it as informational, and this checks the same
  // thing the run does: which input each dispatched fact is read from.
  const versionInput = referencedInput(getDispatchedFact(document, 'FLIGHT_VERSION'), 'inputs.');
  if (versionInput === undefined) {
    issues.push(`${name}: the version is not read from a manual input, so recovery cannot supply it`);
  } else {
    const declaration = asRecord(manual[versionInput]);
    if (declaration === undefined) {
      issues.push(`${name}: manual input ${versionInput} is not declared`);
    } else if (declaration.required !== true) {
      issues.push(`${name}: manual input ${versionInput} must be required`);
    }
  }
  const commitInput = referencedInput(getDispatchedFact(document, 'FLIGHT_COMMIT'), 'inputs.');
  if (commitInput === undefined || asRecord(manual[commitInput]) === undefined) {
    issues.push(`${name}: the commit is not read from a declared manual input`);
  }
  const distributionTagInput = referencedInput(getDispatchedFact(document, distributionTagVariable), 'inputs.');
  if (distributionTagInput === undefined) {
    issues.push(`${name}: the distribution tag is not read from a manual input, so recovery cannot supply it`);
    return;
  }
  const distributionTagDeclaration = asRecord(manual[distributionTagInput]);
  if (distributionTagDeclaration === undefined) {
    issues.push(`${name}: manual input ${distributionTagInput} is not declared`);
    return;
  }
  if (distributionTagDeclaration.required !== true) {
    issues.push(`${name}: manual input ${distributionTagInput} must be required`);
  }
  if (distributionTagDeclaration.type !== 'choice') {
    issues.push(`${name}: manual input ${distributionTagInput} must be a choice`);
  }
  if (!isExactStringSet(distributionTagDeclaration.options, allowedDistributionTags)) {
    issues.push(
      `${name}: manual input ${distributionTagInput} options must be exactly [${allowedDistributionTags.join(', ')}]`,
    );
  }
  if (Object.hasOwn(distributionTagDeclaration, 'default')) {
    issues.push(`${name}: manual input ${distributionTagInput} must not silently default a recovery tag`);
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

function isExactStringSet(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length || !value.every((entry) => typeof entry === 'string')) {
    return false;
  }
  return new Set(value).size === expected.length && expected.every((entry) => value.includes(entry));
}

// The event types Flight dispatches and the facts every run needs. These names are the sending contract:
// changing one here changes what Flight has to send.
const allowedDistributionTags = ['latest', 'edge', 'next'] as const;
const compilerDefaultBranchExpression = '${{ github.event.repository.default_branch }}';
const dispatchCommit = 'github.event.client_payload.commit';
const dispatchDistributionTag = 'github.event.client_payload.dist_tag';
const dispatchedCommitVariable = 'FLIGHT_COMMIT';
const distributionTagVariable = 'FLIGHT_DIST_TAG';
const releaseConcurrencyPrefix = 'release';
const releaseEventTypes = ['flight-release', 'flight-snapshot'] as const;
const stableReleaseConcurrencyGroup = 'release-latest';
const publicRegistry = 'https://registry.npmjs.org';
const dispatchedFacts = ['FLIGHT_VERSION', 'FLIGHT_COMMIT'] as const;

// The pipeline, in the order it has to run. `npm run ci` is deliberately absent: it is the cold-tree sweep
// that enters the downstream and corpus lanes, and a bridge that judges a source release is not the place for
// a lane whose cost is minutes and whose goldens are maintained elsewhere.
const preStampCommands = ['npm run check', 'npm run test:packages'] as const;
const stampCommand = 'npm run version:tool-compiler';
const postStampCommands = ['npm run pack:check', 'npm run smoke'] as const;
const forbiddenPipelineCommands = ['npm run ci'] as const;
const environmentPublisherTagPattern = /--tag(?:=|\s+)["']?\$\{?FLIGHT_DIST_TAG\}?["']?(?:\s|$)/u;
const publishStepPattern = /\bnpm run release(?:\s|$)/u;
const stablePublisherTagPattern = /--tag(?:=|\s+)["']?latest["']?(?:\s|$)/u;
