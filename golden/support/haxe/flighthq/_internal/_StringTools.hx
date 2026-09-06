package flighthq._internal;

class _StringTools {
  public static function replaceFirst(text:String, search:String, replacement:String):String {
    var index = text.indexOf(search);
    if (index == -1) return text;
    return text.substr(0, index) + replacement + text.substr(index + search.length);
  }
}
