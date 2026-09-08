cmake_minimum_required(VERSION 3.20)

project(FlightCppConsumer LANGUAGES C CXX)

include(CTest)
find_package(FlightCpp 0.1 CONFIG REQUIRED)

add_executable(flight_cpp_consumer main.cpp)
target_link_libraries(flight_cpp_consumer PRIVATE Flight::Cpp)

add_test(NAME flight_cpp.consumer COMMAND flight_cpp_consumer)

add_executable(flight_cpp_c_consumer main.c)
target_link_libraries(flight_cpp_c_consumer PRIVATE Flight::C)
add_test(NAME flight_cpp.c_consumer COMMAND flight_cpp_c_consumer)
