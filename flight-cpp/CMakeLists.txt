cmake_minimum_required(VERSION 3.20)

project(
  FlightCpp
  VERSION 0.1.0
  DESCRIPTION "C++20 semantic runtime for Flight compiler output"
  LANGUAGES CXX
)

include(CMakePackageConfigHelpers)
include(CTest)

option(FLIGHT_CPP_ENABLE_SANITIZERS "Enable AddressSanitizer and UndefinedBehaviorSanitizer" OFF)

add_library(flight_cpp INTERFACE)
add_library(Flight::Cpp ALIAS flight_cpp)
set_target_properties(flight_cpp PROPERTIES EXPORT_NAME Cpp)
target_compile_features(flight_cpp INTERFACE cxx_std_20)
target_include_directories(
  flight_cpp
  INTERFACE
    "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
    "$<INSTALL_INTERFACE:include>"
)

if(FLIGHT_CPP_ENABLE_SANITIZERS)
  if(MSVC)
    message(FATAL_ERROR "FLIGHT_CPP_ENABLE_SANITIZERS currently requires GCC, Clang, or AppleClang")
  endif()
  target_compile_options(flight_cpp INTERFACE -fsanitize=address,undefined -fno-omit-frame-pointer)
  target_link_options(flight_cpp INTERFACE -fsanitize=address,undefined)
endif()

if(BUILD_TESTING)
  add_subdirectory(tests)
endif()

install(TARGETS flight_cpp EXPORT FlightCppTargets)
install(DIRECTORY include/ DESTINATION include)
install(
  EXPORT FlightCppTargets
  FILE FlightCppTargets.cmake
  NAMESPACE Flight::
  DESTINATION lib/cmake/FlightCpp
)

configure_package_config_file(
  cmake/FlightCppConfig.cmake.in
  "${CMAKE_CURRENT_BINARY_DIR}/FlightCppConfig.cmake"
  INSTALL_DESTINATION lib/cmake/FlightCpp
)
write_basic_package_version_file(
  "${CMAKE_CURRENT_BINARY_DIR}/FlightCppConfigVersion.cmake"
  COMPATIBILITY SameMajorVersion
)
install(
  FILES
    "${CMAKE_CURRENT_BINARY_DIR}/FlightCppConfig.cmake"
    "${CMAKE_CURRENT_BINARY_DIR}/FlightCppConfigVersion.cmake"
  DESTINATION lib/cmake/FlightCpp
)
