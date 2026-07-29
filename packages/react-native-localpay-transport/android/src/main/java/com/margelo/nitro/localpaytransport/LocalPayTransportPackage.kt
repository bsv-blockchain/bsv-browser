package com.margelo.nitro.localpaytransport

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Deliberately empty ReactPackage.
 *
 * Nitro HybridObjects register themselves via JNI (see the generated
 * LocalPayTransportOnLoad), not through ReactPackage#createNativeModules — but
 * Android autolinking (both the community CLI's and Expo's) only discovers a
 * dependency, and thus only adds it as a Gradle project of `:app`, when it
 * finds a class implementing ReactPackage under `android/`. Without this file
 * the module is invisible to autolinking and its native library never gets
 * bundled, even though nothing here is actually used at runtime.
 */
class LocalPayTransportPackage : ReactPackage {
  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<in Nothing, in Nothing>> = emptyList()
}
