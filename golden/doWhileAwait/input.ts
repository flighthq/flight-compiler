export async function drain(task: Promise<number>, again: boolean): Promise<number> {
  let last: number = 0;
  do {
    last = await task;
    again = false;
  } while (again);
  return last;
}
