type Handler = (value: number) => void;
type Reporter = (value?: number) => void;
type NullableReporter = (value: number | undefined) => void;

type HandlerSlot = Handler | string;
type ReporterSlot = Reporter | string;

// The destination's signature is the only caller this value ever has, and it always supplies the
// parameter. A handler that also accepts absence is therefore one it can call, and the storage it is
// called through is the source's own optional parameter -- constructed implicitly by the call.
export function storeOptional(handler: (value?: number) => void): HandlerSlot {
  return handler;
}

export function storeNullable(handler: (value: number | undefined) => void): HandlerSlot {
  return handler;
}

// The mirror the destination declares for itself: a reporter that accepts absence, stored where the
// signature also accepts absence. Nothing adapts, because the two parameters are one storage.
export function storeReporter(handler: Reporter): ReporterSlot {
  return handler;
}

export function storeNullableReporter(handler: NullableReporter): ReporterSlot {
  return handler;
}
