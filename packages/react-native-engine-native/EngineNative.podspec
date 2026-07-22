# EngineNative.podspec — Nitro module wrapping the native-engine-ffi Rust staticlib.
#
# Mirrors SecpNative.podspec (the proven shape, including its fixes):
#   • the xcframework is a build artifact (gitignored) — if missing, sync it from
#     native-engine-ffi/packages/EngineNativeFFI (built by
#     native-engine-ffi/scripts/build-engine-xcframework.sh);
#   • `import engine_nativeFFI` in the UniFFI bindings resolves against the
#     module.modulemap CocoaPods exposes from the vendored xcframework's Headers/
#     (nested under Headers/engine_nativeFFI/ — the multi-xcframework collision fix,
#     mandatory since SecpNative.xcframework ships in the same app). Do NOT also
#     ship a header copy in the pod: that defines the module twice
#     ("error: redefinition of module 'engine_nativeFFI'").
require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

xcframework = File.join(__dir__, 'ios', 'EngineNative.xcframework')
unless Dir.exist?(xcframework)
  Pod::UI.puts '[EngineNative] xcframework missing — running scripts/sync-xcframework.sh'
  unless system(File.join(__dir__, 'scripts', 'sync-xcframework.sh'))
    raise "[EngineNative] sync-xcframework.sh failed — build the xcframework first: " \
          "(cd native-engine-ffi && scripts/build-engine-xcframework.sh)"
  end
end

Pod::Spec.new do |s|
  s.name         = 'EngineNative'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = 'https://github.com/Calgooon/bsv-browser'
  s.license      = 'Open BSV'
  s.authors      = 'BSV Browser'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :git => 'https://github.com/Calgooon/bsv-browser.git', :tag => s.version.to_s }

  s.source_files = [
    'ios/HybridEngineNative.swift',
    'ios/uniffi/EngineNative.swift'
  ]
  s.vendored_frameworks = 'ios/EngineNative.xcframework'

  load File.join(__dir__, 'nitrogen', 'generated', 'ios', 'EngineNative+autolinking.rb')
  add_nitrogen_files(s)

  install_modules_dependencies(s)
end
