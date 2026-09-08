cmake_minimum_required(VERSION 3.20)

project(
  FlightCpp
  VERSION 0.1.0
  DESCRIPTION "C++20 semantic runtime for Flight compiler output"
  LANGUAGES C CXX
)

include(CMakePackageConfigHelpers)
include(CTest)
include(GNUInstallDirs)

option(FLIGHT_CPP_ENABLE_SANITIZERS "Enable AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
option(FLIGHT_CPP_BUILD_BENCHMARKS "Build deterministic runtime performance smoke gates" OFF)
option(FLIGHT_CPP_WARNINGS_AS_ERRORS "Treat warnings in flight-cpp's own targets as errors" OFF)
set(FLIGHT_CPP_ABI_VERSION 1)

function(flight_cpp_set_project_warnings target)
  if(MSVC)
    target_compile_options("${target}" PRIVATE /W4 "$<$<COMPILE_LANGUAGE:CXX>:/permissive->")
    if(FLIGHT_CPP_WARNINGS_AS_ERRORS)
      target_compile_options("${target}" PRIVATE /WX)
    endif()
  else()
    target_compile_options("${target}" PRIVATE -Wall -Wextra -Wpedantic -Wconversion)
    if(FLIGHT_CPP_WARNINGS_AS_ERRORS)
      target_compile_options("${target}" PRIVATE -Werror)
    endif()
  endif()
endfunction()

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

add_library(flight_cpp_c src/c_runtime.cpp)
add_library(Flight::C ALIAS flight_cpp_c)
set_target_properties(
  flight_cpp_c
  PROPERTIES
    CXX_VISIBILITY_PRESET hidden
    EXPORT_NAME C
    POSITION_INDEPENDENT_CODE ON
    SOVERSION "${FLIGHT_CPP_ABI_VERSION}"
    VERSION "${PROJECT_VERSION}"
    VISIBILITY_INLINES_HIDDEN YES
)
target_link_libraries(flight_cpp_c PUBLIC Flight::Cpp)
flight_cpp_set_project_warnings(flight_cpp_c)
if(BUILD_SHARED_LIBS)
  target_compile_definitions(flight_cpp_c PRIVATE FLIGHT_CPP_C_EXPORTS PUBLIC FLIGHT_CPP_C_SHARED)
endif()

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

if(FLIGHT_CPP_BUILD_BENCHMARKS)
  add_subdirectory(benchmarks)
endif()

install(
  TARGETS flight_cpp flight_cpp_c
  EXPORT FlightCppTargets
  ARCHIVE DESTINATION "${CMAKE_INSTALL_LIBDIR}"
  LIBRARY DESTINATION "${CMAKE_INSTALL_LIBDIR}"
  RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}"
)
install(DIRECTORY include/ DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}")
install(
  EXPORT FlightCppTargets
  FILE FlightCppTargets.cmake
  NAMESPACE Flight::
  DESTINATION "${CMAKE_INSTALL_LIBDIR}/cmake/FlightCpp"
)

configure_package_config_file(
  cmake/FlightCppConfig.cmake.in
  "${CMAKE_CURRENT_BINARY_DIR}/FlightCppConfig.cmake"
  INSTALL_DESTINATION "${CMAKE_INSTALL_LIBDIR}/cmake/FlightCpp"
)
write_basic_package_version_file(
  "${CMAKE_CURRENT_BINARY_DIR}/FlightCppConfigVersion.cmake"
  COMPATIBILITY SameMinorVersion
)
install(
  FILES
    "${CMAKE_CURRENT_BINARY_DIR}/FlightCppConfig.cmake"
    "${CMAKE_CURRENT_BINARY_DIR}/FlightCppConfigVersion.cmake"
  DESTINATION "${CMAKE_INSTALL_LIBDIR}/cmake/FlightCpp"
)
