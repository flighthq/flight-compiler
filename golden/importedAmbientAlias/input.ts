import type { Failure, Holder, Pattern } from './provider';

// The runtime binds these ambient types, so an alias of one names a reference the target already has.
export function read(holder: Holder): Pattern {
  return holder.pattern;
}

export function pass(failure: Failure): Failure {
  return failure;
}
