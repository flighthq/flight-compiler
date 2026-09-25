export type Pattern = RegExp;

export interface Holder {
  readonly pattern: Pattern;
}

export type Failure = Error;
