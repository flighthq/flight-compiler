#ifndef FLIGHT_CPP_HEADER_SELECTOR
#error "FLIGHT_CPP_HEADER_SELECTOR must name one public header"
#elif FLIGHT_CPP_HEADER_SELECTOR == 1
#include <flight/array.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 2
#include <flight/contract.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 3
#include <flight/date.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 4
#include <flight/equality.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 5
#include <flight/error.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 6
#include <flight/executor.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 7
#include <flight/host.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 8
#include <flight/map.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 9
#include <flight/math.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 10
#include <flight/presence.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 11
#include <flight/rejection.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 12
#include <flight/runtime.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 13
#include <flight/set.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 14
#include <flight/string.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 15
#include <flight/task.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 16
#include <flight/typed_array.hpp>
#elif FLIGHT_CPP_HEADER_SELECTOR == 17
#include <flight/version.hpp>
#else
#error "FLIGHT_CPP_HEADER_SELECTOR does not name a public header"
#endif

int main() { return 0; }
