package flighthq._internal;

class _DataView {
  public var buffer(default, null):_ArrayBuffer;
  public var byteLength(default, null):Float;
  public var byteOffset(default, null):Float;

  public inline function new(buffer:_ArrayBuffer, byteOffset:Float = 0, byteLength:Float = -1) {
    this.buffer = buffer;
    this.byteOffset = byteOffset;
    this.byteLength = byteLength < 0 ? buffer.byteLength - byteOffset : byteLength;
  }

  public inline function getFloat32(byteOffset:Float, littleEndian:Bool = false):Float return 0;
  public inline function getFloat64(byteOffset:Float, littleEndian:Bool = false):Float return 0;
  public inline function getInt8(byteOffset:Float):Float return 0;
  public inline function getInt16(byteOffset:Float, littleEndian:Bool = false):Float return 0;
  public inline function getInt32(byteOffset:Float, littleEndian:Bool = false):Float return 0;
  public inline function getUint8(byteOffset:Float):Float return 0;
  public inline function getUint16(byteOffset:Float, littleEndian:Bool = false):Float return 0;
  public inline function getUint32(byteOffset:Float, littleEndian:Bool = false):Float return 0;
  public inline function setFloat32(byteOffset:Float, value:Float, littleEndian:Bool = false):Void {}
  public inline function setFloat64(byteOffset:Float, value:Float, littleEndian:Bool = false):Void {}
  public inline function setInt8(byteOffset:Float, value:Float):Void {}
  public inline function setInt16(byteOffset:Float, value:Float, littleEndian:Bool = false):Void {}
  public inline function setInt32(byteOffset:Float, value:Float, littleEndian:Bool = false):Void {}
  public inline function setUint8(byteOffset:Float, value:Float):Void {}
  public inline function setUint16(byteOffset:Float, value:Float, littleEndian:Bool = false):Void {}
  public inline function setUint32(byteOffset:Float, value:Float, littleEndian:Bool = false):Void {}
}
