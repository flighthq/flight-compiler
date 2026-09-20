export interface Signals {
  onComplete: () => void;
  onLoop: () => void;
  onPause: () => void;
  onPlay: () => void;
  onStop: () => void;
}

function invoke(signal: () => void): void {
  signal();
}

export type SignalName = 'onComplete' | 'onLoop' | 'onPause' | 'onPlay' | 'onStop';

export function emitsSignal(signals: Signals | null, name: SignalName): void {
  if (signals !== null) invoke(signals[name]);
}
