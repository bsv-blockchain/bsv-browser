cmake_minimum_required(VERSION 3.13)
project(native-secp256k1)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# modules/native-secp256k1
set(MODULE_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../../..)
set(VENDOR_DIR ${MODULE_ROOT}/vendor)
set(COMMON_DIR ${MODULE_ROOT}/common)

if(ANDROID_ABI STREQUAL "arm64-v8a")
  set(UFSECP_ABI_DIR "arm64-v8a")
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
  set(UFSECP_ABI_DIR "armeabi-v7a")
elseif(ANDROID_ABI STREQUAL "x86_64")
  set(UFSECP_ABI_DIR "x86_64")
else()
  message(FATAL_ERROR "Unsupported ANDROID_ABI=${ANDROID_ABI}")
endif()

set(STATIC_LIB ${VENDOR_DIR}/android/${UFSECP_ABI_DIR}/lib/libfastsecp256k1.a)
if(NOT EXISTS ${STATIC_LIB})
  message(FATAL_ERROR
    "Missing ${STATIC_LIB}. Run: node modules/native-secp256k1/scripts/fetch-prebuilts.mjs")
endif()

add_library(native-secp256k1 SHARED
  jni_bridge.cpp
  ${COMMON_DIR}/ufsecp_bridge.cpp
)

target_include_directories(native-secp256k1 PRIVATE
  ${COMMON_DIR}
  ${VENDOR_DIR}/include
  ${VENDOR_DIR}/android/${UFSECP_ABI_DIR}/include
)

find_library(log-lib log)

target_link_libraries(native-secp256k1
  ${STATIC_LIB}
  ${log-lib}
  c++_shared
)

# Hide most symbols; keep JNI exports.
target_compile_options(native-secp256k1 PRIVATE
  -fvisibility=hidden
  -Wno-unused-parameter
)
