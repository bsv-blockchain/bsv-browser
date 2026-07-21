require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
vendor_root = File.join(__dir__, '..', 'vendor')
xcframework = File.join(vendor_root, 'ios', 'UltrafastSecp256k1.xcframework')

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

  s.source_files = [
    '**/*.{h,m,mm,swift,cpp}',
    '../common/**/*.{h,cpp}'
  ]
  s.public_header_files = 'NativeSecp256k1Bridge.h'

  if File.directory?(xcframework)
    s.vendored_frameworks = '../vendor/ios/UltrafastSecp256k1.xcframework'
  else
    Pod::UI.warn '[NativeSecp256k1] vendor/ios/UltrafastSecp256k1.xcframework missing — run scripts/fetch-prebuilts.mjs before pod install'
  end

  s.libraries = 'c++'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'SWIFT_OBJC_BRIDGING_HEADER' => '$(PODS_TARGET_SRCROOT)/NativeSecp256k1-Bridging-Header.h',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'CLANG_CXX_LIBRARY' => 'libc++',
    'HEADER_SEARCH_PATHS' => [
      '"$(PODS_TARGET_SRCROOT)"',
      '"$(PODS_TARGET_SRCROOT)/../common"',
      '"$(PODS_TARGET_SRCROOT)/../vendor/include"',
      '"$(PODS_TARGET_SRCROOT)/../vendor/ios/UltrafastSecp256k1.xcframework/ios-arm64/Headers"'
    ].join(' '),
    'OTHER_CPLUSPLUSFLAGS' => '-std=c++20',
    # Mobile prebuilts are static archives that pull in C++ symbols.
    'OTHER_LDFLAGS' => '-lc++'
  }

  s.user_target_xcconfig = {
    'OTHER_LDFLAGS' => '-lc++'
  }
end
