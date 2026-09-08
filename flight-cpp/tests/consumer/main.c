#include <flight/c/runtime.h>

int main(void) {
  if (flight_cpp_abi_version() != 1) return 1;
  flight_cpp_error* error = NULL;
  if (flight_cpp_error_create_utf8("consumer", 8, &error) != FLIGHT_CPP_STATUS_OK) return 2;
  flight_cpp_error_release(error);
  return 0;
}
