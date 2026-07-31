project(LocalPayTransport)
cmake_minimum_required(VERSION 3.9.0)

set(CMAKE_VERBOSE_MAKEFILE ON)
set(CMAKE_CXX_STANDARD 20)

# No project-specific C++ sources yet — this module's implementation is plain
# Kotlin (see HybridLocalPayTransport.kt). All sources are added below by the
# nitrogen-generated autolinking file (JNI glue + shared HybridObject spec).
add_library(LocalPayTransport SHARED)

# Nitro's generated sources, include paths, and library links.
include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/LocalPayTransport+autolinking.cmake)
