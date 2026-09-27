interface CommandBase {
  readonly id: string;
}

interface Command extends CommandBase {
  readonly payload: number;
}

// A structural row is a VIEW. Erasing one needs a runtime carrier that keeps the row's owner and its native
// type, because the row's `shared_object()` is deliberately null for a widened schema: the derived owner is
// still the identity, and only the row view names it. The emitter has no such alternative to construct, so
// the erasure is refused where the runtime is what would have to supply it. Copying the members, boxing the
// view, or reaching for `shared_object()` would change identity or lose the widened owner, and an unchecked
// cast would discard the evidence a checked recovery needs.
export function inspect(command: Readonly<Partial<Command>>): unknown {
  return command;
}

export function inspectWidened(command: Command): unknown {
  return command as Readonly<Partial<CommandBase>>;
}
