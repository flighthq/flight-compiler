export type Lane = 'fast' | 'safe';

export interface Route {
  readonly lane: Lane;
  readonly cost: number;
}

export function isFast(route: Route): boolean {
  return route.lane === 'fast';
}

export function laneName(route: Route): string {
  return route.lane;
}

export function describe(lane: Lane): string {
  return lane === 'fast' ? 'quick' : 'careful';
}
