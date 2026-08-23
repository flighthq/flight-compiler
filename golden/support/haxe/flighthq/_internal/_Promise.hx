package flighthq._internal;

// The `task` capability of `flight-runtime-contract/2`, in the smallest shape that lets a target
// compiler check emitted source. The maintained implementation lives downstream; this stands in for
// it so the compile gate checks the compiler's output rather than the runtime's.
class _Promise<T> {
  public function new(executor:(T -> Void) -> (Dynamic -> Void) -> Void) {}
  public static function resolve<T>(value:Dynamic):_Promise<T> {
    return null;
  }
  public static function reject<T>(error:Dynamic):_Promise<T> {
    return null;
  }
  public function then<U>(onValue:T -> Void, ?onError:Dynamic -> Void):_Promise<U> {
    return null;
  }
}
