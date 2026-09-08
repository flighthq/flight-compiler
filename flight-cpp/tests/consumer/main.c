#include <flight/c/runtime.h>

int main(void) { return flight_cpp_abi_version() == 1 ? 0 : 1; }
