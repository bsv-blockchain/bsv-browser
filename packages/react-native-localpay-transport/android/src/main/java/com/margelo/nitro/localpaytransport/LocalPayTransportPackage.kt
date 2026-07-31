package com.margelo.nitro.localpaytransport

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * ReactPackage with no modules or view managers — but NOT unused at runtime.
 * It carries two load-bearing jobs:
 *
 *  1. Discovery: Android autolinking (community CLI's and Expo's) only adds a
 *     dependency as a Gradle project of `:app` when it finds a ReactPackage
 *     under `android/`.
 *  2. Registration: the companion init below is the ONLY thing that loads the
 *     native library. Nitro HybridObjects do register themselves via JNI —
 *     but only when the .so's JNI_OnLoad runs (see cpp-adapter.cpp), and
 *     nothing runs it until initializeNative() calls System.loadLibrary.
 *     Autolinking instantiates this class from PackageList at app start,
 *     which loads the class, which fires the companion init.
 *
 * Dropping the init block re-introduces the silent-QR-fallback bug: the .so
 * ships in the APK but is never loaded, createHybridObject throws, and every
 * capability probe on Android answers "unsupported" with no visible error.
 */
class LocalPayTransportPackage : ReactPackage {
  companion object {
    init {
      LocalPayTransportOnLoad.initializeNative()
    }
  }

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<in Nothing, in Nothing>> = emptyList()
}
