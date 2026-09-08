#include <flight/c/runtime.h>

#include <stddef.h>
#include <stdint.h>
#include <string.h>

int main(void) {
  static const char input[] = "flight \xF0\x9F\x98\x80";
  static const char failure[] = "failed \xF0\x9F\x9A\x80";
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

  flight_cpp_error* error = NULL;
  if (flight_cpp_error_create_utf8(failure, sizeof(failure) - 1, &error) != FLIGHT_CPP_STATUS_OK)
    return 9;
  if (flight_cpp_error_retain(error) != FLIGHT_CPP_STATUS_OK) return 10;
  flight_cpp_string* message = NULL;
  if (flight_cpp_error_message(error, &message) != FLIGHT_CPP_STATUS_OK) return 11;
  if (flight_cpp_string_utf8_size(message, &size) != FLIGHT_CPP_STATUS_OK || size != sizeof(failure) - 1)
    return 12;
  memset(output, 0, sizeof(output));
  if (flight_cpp_string_copy_utf8(message, output, sizeof(output), &written) != FLIGHT_CPP_STATUS_OK ||
      written != sizeof(failure) - 1 || memcmp(failure, output, written) != 0)
    return 13;
  flight_cpp_string_release(message);
  flight_cpp_error_release(error);
  flight_cpp_error_release(error);

  if (flight_cpp_string_create_utf8(failure, sizeof(failure) - 1, &value) != FLIGHT_CPP_STATUS_OK)
    return 14;
  if (flight_cpp_error_create(value, &error) != FLIGHT_CPP_STATUS_OK) return 15;
  flight_cpp_string_release(value);
  if (flight_cpp_error_message(error, &message) != FLIGHT_CPP_STATUS_OK) return 16;
  flight_cpp_error_release(error);
  if (flight_cpp_string_utf8_size(message, &size) != FLIGHT_CPP_STATUS_OK || size != sizeof(failure) - 1)
    return 17;
  flight_cpp_string_release(message);

  if (flight_cpp_error_create_utf8(NULL, 0, &error) != FLIGHT_CPP_STATUS_OK) return 18;
  flight_cpp_error* stale_error = error;
  if (flight_cpp_error_create_utf8("\xFF", 1, &error) != FLIGHT_CPP_STATUS_INVALID_UTF8 || error != NULL)
    return 19;
  flight_cpp_error_release(stale_error);
  if (flight_cpp_error_create_utf8(NULL, 0, &error) != FLIGHT_CPP_STATUS_OK) return 20;
  stale_error = error;
  if (flight_cpp_error_create_utf8(NULL, 1, &error) != FLIGHT_CPP_STATUS_INVALID_ARGUMENT || error != NULL)
    return 21;
  flight_cpp_error_release(stale_error);
  if (flight_cpp_string_create_utf8(NULL, 0, &message) != FLIGHT_CPP_STATUS_OK) return 22;
  flight_cpp_string* stale_message = message;
  if (flight_cpp_error_message(NULL, &message) != FLIGHT_CPP_STATUS_INVALID_ARGUMENT || message != NULL)
    return 23;
  flight_cpp_string_release(stale_message);
  if (flight_cpp_error_create(NULL, &error) != FLIGHT_CPP_STATUS_INVALID_ARGUMENT ||
      flight_cpp_error_retain(NULL) != FLIGHT_CPP_STATUS_INVALID_ARGUMENT)
    return 24;
  if (flight_cpp_error_create_utf8(NULL, 0, NULL) != FLIGHT_CPP_STATUS_INVALID_ARGUMENT ||
      flight_cpp_error_message(NULL, NULL) != FLIGHT_CPP_STATUS_INVALID_ARGUMENT)
    return 25;
  flight_cpp_error_release(NULL);
  return 0;
}
