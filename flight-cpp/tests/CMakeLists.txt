add_executable(flight_cpp_runtime_tests runtime_test.cpp)
target_link_libraries(flight_cpp_runtime_tests PRIVATE Flight::Cpp)

if(MSVC)
  target_compile_options(flight_cpp_runtime_tests PRIVATE /W4 /permissive-)
else()
  target_compile_options(flight_cpp_runtime_tests PRIVATE -Wall -Wextra -Wpedantic -Wconversion)
endif()

add_test(NAME flight_cpp.runtime COMMAND flight_cpp_runtime_tests)

add_executable(flight_cpp_generated_runtime_tests generated_runtime_test.cpp)
target_link_libraries(flight_cpp_generated_runtime_tests PRIVATE Flight::Cpp)

if(MSVC)
  target_compile_options(flight_cpp_generated_runtime_tests PRIVATE /W4 /permissive-)
else()
  target_compile_options(flight_cpp_generated_runtime_tests PRIVATE -Wall -Wextra -Wpedantic -Wconversion)
endif()

add_test(NAME flight_cpp.generated_runtime COMMAND flight_cpp_generated_runtime_tests)

set(
  flight_cpp_public_headers
  array
  contract
  date
  equality
  executor
  map
  math
  presence
  rejection
  set
  string
  runtime
  task
  typed_array
  version
)

foreach(header IN LISTS flight_cpp_public_headers)
  set(source "${CMAKE_CURRENT_BINARY_DIR}/header_${header}_test.cpp")
  file(GENERATE OUTPUT "${source}" CONTENT "#include <flight/${header}.hpp>\n")
  add_library("flight_cpp_header_${header}_test" OBJECT "${source}")
  target_link_libraries("flight_cpp_header_${header}_test" PRIVATE Flight::Cpp)
endforeach()
