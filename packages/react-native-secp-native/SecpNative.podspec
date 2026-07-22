# SecpNative.podspec — Nitro module wrapping the secp-native Rust staticlib.
#
# The xcframework is a build artifact (gitignored). If it is missing, we sync it
# from native-secp-poc/packages/SecpNativeFFI (which in turn is produced by
# native-secp-poc/scripts/build-secp-xcframework.sh).
require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

xcframework = File.join(__dir__, 'ios', 'SecpNative.xcframework')
unless Dir.exist?(xcframework)
  Pod::UI.puts '[SecpNative] xcframework missing — running scripts/sync-xcframework.sh'
  unless system(File.join(__dir__, 'scripts', 'sync-xcframework.sh'))
    raise "[SecpNative] sync-xcframework.sh failed — build the xcframework first: " \
          "(cd native-secp-poc && scripts/build-secp-xcframework.sh)"
  end
end

Pod::Spec.new do |s|
  s.name         = 'SecpNative'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = 'https://github.com/Calgooon/bsv-browser'
  s.license      = 'Open BSV'
  s.authors      = 'BSV Browser'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :git => 'https://github.com/Calgooon/bsv-browser.git', :tag => s.version.to_s }

  s.source_files = [
    'ios/HybridSecpNative.swift',
    'ios/uniffi/SecpNative.swift'
  ]
  # The `import secp_nativeFFI` in the UniFFI bindings resolves against the
  # module.modulemap CocoaPods exposes from the vendored xcframework's Headers/
  # (nested under Headers/secp_nativeFFI/ — the multi-xcframework collision fix).
  # Do NOT also ship a header copy in the pod: that defines the module twice
  # ("error: redefinition of module 'secp_nativeFFI'").
  s.vendored_frameworks = 'ios/SecpNative.xcframework'

  load File.join(__dir__, 'nitrogen', 'generated', 'ios', 'SecpNative+autolinking.rb')
  add_nitrogen_files(s)

  install_modules_dependencies(s)
end
