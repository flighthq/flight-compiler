export type BehavioralOracleFailureStage = 'build' | 'run';

export interface BehavioralOracleFailureRecord {
  readonly fixture: string;
  readonly message: string;
  readonly stage: BehavioralOracleFailureStage;
  readonly target: string;
}

interface BehavioralOracleProcessFailure extends Error {
  readonly kind: 'behavioral-oracle-process';
  readonly stage: BehavioralOracleFailureStage;
}

export function assertBehavioralOracleProcessSucceeded(
  stage: BehavioralOracleFailureStage,
  status: number | null,
  message: string,
): void {
  if (status === 0) return;
  throw createBehavioralOracleProcessFailure(stage, message);
}

export function createBehavioralOracleFailureRecord(
  fixture: string,
  target: string,
  error: unknown,
): BehavioralOracleFailureRecord {
  return {
    fixture,
    message: error instanceof Error ? error.message : String(error),
    stage: isBehavioralOracleProcessFailure(error) ? error.stage : 'build',
    target,
  };
}

export function getBehavioralOracleFailureSummaries(
  failures: readonly Readonly<BehavioralOracleFailureRecord>[],
): readonly string[] {
  return (['build', 'run'] as const).flatMap((stage) => {
    const staged = failures.filter((failure) => failure.stage === stage);
    if (staged.length === 0) return [];
    const fixturesByTarget = new Map<string, string[]>();
    for (const failure of staged) {
      fixturesByTarget.set(failure.target, [...(fixturesByTarget.get(failure.target) ?? []), failure.fixture]);
    }
    const targets = [...fixturesByTarget.keys()]
      .sort()
      .map((target) => {
        const fixtures = fixturesByTarget.get(target)!;
        return `${target}: ${String(fixtures.length)} (${[...fixtures].sort().join(', ')})`;
      })
      .join('; ');
    const action = stage === 'build' ? 'build or link' : 'run';
    return [`${String(staged.length)} fixture(s) failed to ${action} (${targets}).`];
  });
}

function createBehavioralOracleProcessFailure(
  stage: BehavioralOracleFailureStage,
  message: string,
): BehavioralOracleProcessFailure {
  return Object.assign(new Error(message), { kind: 'behavioral-oracle-process' as const, stage });
}

function isBehavioralOracleProcessFailure(value: unknown): value is BehavioralOracleProcessFailure {
  return (
    value instanceof Error &&
    'kind' in value &&
    value.kind === 'behavioral-oracle-process' &&
    'stage' in value &&
    (value.stage === 'build' || value.stage === 'run')
  );
}
