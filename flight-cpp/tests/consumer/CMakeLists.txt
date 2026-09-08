cmake_minimum_required(VERSION 3.20)

project(FlightCppConsumer LANGUAGES CXX)

include(CTest)
find_package(FlightCpp 0.1 CONFIG REQUIRED)

add_executable(flight_cpp_consumer main.cpp)
target_link_libraries(flight_cpp_consumer PRIVATE Flight::Cpp)

add_test(NAME flight_cpp.consumer COMMAND flight_cpp_consumer)
