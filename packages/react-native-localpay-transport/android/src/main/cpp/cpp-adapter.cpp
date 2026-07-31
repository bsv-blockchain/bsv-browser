///
/// cpp-adapter.cpp
///
/// The JNI entry point for this library's .so. Nitro does NOT register
/// HybridObjects by itself on Android: nitrogen generates registerAllNatives()
/// (see nitrogen/generated/android/LocalPayTransportOnLoad.{hpp,cpp}) but the
/// hand-written half — this JNI_OnLoad — is what actually invokes it when
/// System.loadLibrary("LocalPayTransport") runs (triggered from
/// LocalPayTransportPackage's companion init via
/// LocalPayTransportOnLoad.initializeNative()).
///
/// Without this file the .so ships in the APK but exports no JNI_OnLoad, so
/// loading it registers nothing, createHybridObject("LocalPayTransport")
/// throws, and every JS capability check silently reports "no Nearby" — the
/// whole payment flow degrades to QR with no error anywhere.
///

#include <jni.h>
#include <fbjni/fbjni.h>
#include "LocalPayTransportOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, []() {
    margelo::nitro::localpaytransport::registerAllNatives();
  });
}
