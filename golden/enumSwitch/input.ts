enum Direction {
  Up = 'up',
  Down = 'down',
  Left = 'left',
  Right = 'right',
}

export function isVertical(dir: Direction): boolean {
  return dir === Direction.Up || dir === Direction.Down;
}

export function opposite(dir: Direction): Direction {
  switch (dir) {
    case Direction.Up:
      return Direction.Down;
    case Direction.Down:
      return Direction.Up;
    case Direction.Left:
      return Direction.Right;
    case Direction.Right:
      return Direction.Left;
  }
}

export function directionLabel(dir: Direction): string {
  switch (dir) {
    case Direction.Up:
      return 'north';
    case Direction.Down:
      return 'south';
    case Direction.Left:
      return 'west';
    case Direction.Right:
      return 'east';
  }
}
