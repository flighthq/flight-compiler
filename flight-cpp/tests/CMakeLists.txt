add_executable(flight_cpp_runtime_tests runtime_test.cpp)
target_link_libraries(flight_cpp_runtime_tests PRIVATE Flight::Cpp)

if(MSVC)
  target_compile_options(flight_cpp_runtime_tests PRIVATE /W4 /permissive-)
else()
  target_compile_options(flight_cpp_runtime_tests PRIVATE -Wall -Wextra -Wpedantic -Wconversion)
endif()

add_test(NAME flight_cpp.runtime COMMAND flight_cpp_runtime_tests)
