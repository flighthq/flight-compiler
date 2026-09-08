#include <flight/c/runtime.h>

#include <stddef.h>
#include <stdint.h>
#include <string.h>

int main(void) {
  static const char input[] = "flight \xF0\x9F\x98\x80";
  flight_cpp_string* value = NULL;
  if (flight_cpp_abi_version() != 1 || strcmp(flight_cpp_version(), "0.1.0") != 0) return 1;
  if (flight_cpp_string_create_utf8(input, sizeof(input) - 1, &value) != FLIGHT_CPP_STATUS_OK) return 2;
  if (flight_cpp_string_retain(value) != FLIGHT_CPP_STATUS_OK) return 3;

  size_t size = 0;
  if (flight_cpp_string_utf8_size(value, &size) != FLIGHT_CPP_STATUS_OK || size != sizeof(input) - 1) return 4;
  char output[sizeof(input)] = {0};
  size_t written = 0;
  if (flight_cpp_string_copy_utf8(value, output, size - 1, &written) != FLIGHT_CPP_STATUS_BUFFER_TOO_SMALL)
    return 5;
  if (written != size || flight_cpp_string_copy_utf8(value, output, size, &written) != FLIGHT_CPP_STATUS_OK)
    return 6;
  if (memcmp(input, output, size) != 0) return 7;

  flight_cpp_string_release(value);
  flight_cpp_string_release(value);
  value = NULL;
  if (flight_cpp_string_create_utf8("\xFF", 1, &value) != FLIGHT_CPP_STATUS_INVALID_UTF8 || value != NULL)
    return 8;
  return 0;
}
