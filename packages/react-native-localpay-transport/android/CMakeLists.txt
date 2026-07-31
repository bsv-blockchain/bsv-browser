project(LocalPayTransport)
cmake_minimum_required(VERSION 3.9.0)

set(CMAKE_VERBOSE_MAKEFILE ON)
set(CMAKE_CXX_STANDARD 20)

# The implementation is plain Kotlin (see HybridLocalPayTransport.kt); the one
# C++ source of our own is the JNI_OnLoad entry point. The generated
# LocalPayTransportOnLoad.cpp added by the autolinking include below only
# DEFINES registerAllNatives() — nothing in the generated set calls it, so
# without cpp-adapter.cpp the .so loads inert and the HybridObject is never
# registered (JS then reports "no Nearby support" on every Android device).
add_library(LocalPayTransport SHARED
  src/main/cpp/cpp-adapter.cpp
)

# Nitro's generated sources, include paths, and library links.
include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/LocalPayTransport+autolinking.cmake)
