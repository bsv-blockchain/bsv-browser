require 'fileutils'
require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
vendor_root = File.join(__dir__, '..', 'vendor')
xcframework_src = File.join(vendor_root, 'ios', 'UltrafastSecp256k1.xcframework')
xcframework_dst = File.join(__dir__, 'UltrafastSecp256k1.xcframework')

# CocoaPods only resolves vendored/source paths inside the pod directory (ios/).
# Shared C++ and prebuilts live under the package root; stage copies here
# (same pattern as expo-sqlite vendor copy).
['ufsecp_bridge.h', 'ufsecp_bridge.cpp'].each do |file|
  src = File.join(__dir__, '..', 'common', file)
  dst = File.join(__dir__, file)
  FileUtils.cp(src, dst) if File.exist?(src)
end

if File.directory?(xcframework_src)
  FileUtils.rm_rf(xcframework_dst)
  FileUtils.cp_r(xcframework_src, xcframework_dst)
  # Drop Clang module maps from the staged xcframework. We compile C++ against
  # vendor/include and only link the static .a; keeping module.modulemap causes
  # "redefinition of module 'UltrafastSecp256k1'" when HEADER_SEARCH_PATHS and
  # framework search paths both surface the same map during Swift compile.
  Dir.glob(File.join(xcframework_dst, '**', 'module.modulemap')).each do |map|
    FileUtils.rm_f(map)
  end
end

Pod::Spec.new do |s|
  s.name           = 'NativeSecp256k1'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'BSV Association'
  s.homepage       = 'https://github.com/bsv-blockchain/bsv-browser'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,mm,swift,cpp}'
  s.public_header_files = 'NativeSecp256k1Bridge.h'
  s.private_header_files = 'ufsecp_bridge.h'
  # Avoid treating xcframework internals as pod sources.
  s.exclude_files = 'UltrafastSecp256k1.xcframework/**/*'

  if File.directory?(xcframework_dst)
    s.vendored_frameworks = 'UltrafastSecp256k1.xcframework'
  else
    Pod::UI.warn '[NativeSecp256k1] UltrafastSecp256k1.xcframework missing — run scripts/fetch-prebuilts.mjs before pod install'
  end

  s.libraries = 'c++'
  # No SWIFT_OBJC_BRIDGING_HEADER: ios.useFrameworks builds this as a framework
  # target, and Xcode rejects bridging headers on frameworks. Swift sees
  # NativeSecp256k1Bridge via DEFINES_MODULE + public_header_files (umbrella).
  #
  # UltrafastSecp256k1 prebuilts ship arm64 only (device + arm64-simulator).
  # EAS/Xcode generic-simulator destinations still try x86_64 when
  # ONLY_ACTIVE_ARCH=NO; CocoaPods then cannot select a slice, leaves
  # libfastsecp256k1.a uncopied, and the app link fails with
  # `ld: library 'fastsecp256k1' not found`. Exclude x86_64 for simulator.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'CLANG_CXX_LIBRARY' => 'libc++',
    # C++ bridge headers come from vendor/include (source of truth), not the
    # xcframework Headers tree (avoids pulling UltrafastSecp256k1 as a clang module).
    'HEADER_SEARCH_PATHS' => [
      '"$(PODS_TARGET_SRCROOT)"',
      '"$(PODS_TARGET_SRCROOT)/../vendor/include"'
    ].join(' '),
    'OTHER_CPLUSPLUSFLAGS' => '-std=c++20',
    'OTHER_LDFLAGS' => '-lc++',
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64'
  }

  s.user_target_xcconfig = {
    'OTHER_LDFLAGS' => '-lc++',
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64'
  }
end
