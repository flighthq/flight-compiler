// The gate list `scripts/repositoryCheck.ts` builds, extracted so its one invariant can be tested:
// a stage name registers at most once.
//
// A duplicate registration is invisible in the only signal anyone reads. A sweep that runs a stage
// twice is green exactly like a sweep that runs it once, and two independent edits that each add the
// same gate land far enough apart to merge without a conflict. Registration therefore throws rather
// than returning a sentinel: registering the same stage twice is a programmer error that correct
// code cannot reach, which is this repository's dividing line between throwing and returning a
// structured result.
//
// The check lives at registration rather than in a static scan of the caller on purpose. A scan
// cannot tell a real duplicate from two registrations on opposite arms of a conditional, where only
// one ever executes and the source is correct.

export interface CheckGate {
  readonly args: readonly string[];
  readonly command: string;
  readonly label: string;
}

export interface CheckGateRegistry {
  readonly add: (label: string, command: string, args: readonly string[]) => void;
  readonly gates: readonly CheckGate[];
}

export function createCheckGateRegistry(): CheckGateRegistry {
  const gates: CheckGate[] = [];
  const registered = new Set<string>();
  return {
    add: (label: string, command: string, args: readonly string[]): void => {
      if (registered.has(label)) {
        throw new Error(
          `repositoryCheck.ts registers the gate '${label}' twice. A duplicate is never intended and is invisible in a green sweep, so it is rejected here rather than run twice. If two edits added the same stage independently, keep one registration and merge the reasoning from both.`,
        );
      }
      registered.add(label);
      gates.push({ args, command, label });
    },
    gates,
  };
}
