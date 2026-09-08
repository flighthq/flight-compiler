add_executable(flight_cpp_runtime_tests runtime_test.cpp)
target_link_libraries(flight_cpp_runtime_tests PRIVATE Flight::Cpp)
flight_cpp_set_project_warnings(flight_cpp_runtime_tests)

add_test(NAME flight_cpp.runtime COMMAND flight_cpp_runtime_tests)

add_executable(flight_cpp_generated_runtime_tests generated_runtime_test.cpp)
target_link_libraries(flight_cpp_generated_runtime_tests PRIVATE Flight::Cpp)
flight_cpp_set_project_warnings(flight_cpp_generated_runtime_tests)

add_test(NAME flight_cpp.generated_runtime COMMAND flight_cpp_generated_runtime_tests)

add_executable(flight_cpp_c_api_tests c_api_test.c)
target_link_libraries(flight_cpp_c_api_tests PRIVATE Flight::C)
flight_cpp_set_project_warnings(flight_cpp_c_api_tests)
add_test(NAME flight_cpp.c_api COMMAND flight_cpp_c_api_tests)

find_package(Threads REQUIRED)
add_executable(flight_cpp_c_api_thread_tests c_api_thread_test.cpp)
target_link_libraries(flight_cpp_c_api_thread_tests PRIVATE Flight::C Threads::Threads)
flight_cpp_set_project_warnings(flight_cpp_c_api_thread_tests)
add_test(NAME flight_cpp.c_api_threads COMMAND flight_cpp_c_api_thread_tests)

set(
  flight_cpp_public_headers
  array
  contract
  date
  equality
  error
  executor
  host
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
  flight_cpp_set_project_warnings("flight_cpp_header_${header}_test")
endforeach()
