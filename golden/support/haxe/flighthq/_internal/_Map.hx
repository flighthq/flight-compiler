package flighthq._internal;

class _Map<K, V> {
  public var size:Float;
  public function new() { size = 0; }
  public function get(key:K):Null<V> { return null; }
  public function has(key:K):Bool { return false; }
  public function set(key:K, value:V):Void {}
  public function delete(key:K):Void {}
}
