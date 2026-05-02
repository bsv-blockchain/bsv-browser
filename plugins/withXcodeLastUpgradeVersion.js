const { withDangerousMod } = require('@expo/config-plugins')
const { promises: fs } = require('fs')
const path = require('path')

module.exports = (config, { version = '2640' } = {}) =>
  withDangerousMod(config, [
    'ios',
    async (mod) => {
      const schemePath = path.join(
        mod.modRequest.platformProjectRoot,
        `${mod.modRequest.projectName}.xcodeproj`,
        'xcshareddata',
        'xcschemes',
        `${mod.modRequest.projectName}.xcscheme`
      )
      try {
        let contents = await fs.readFile(schemePath, 'utf8')
        contents = contents.replace(
          /LastUpgradeVersion\s*=\s*"[^"]*"/,
          `LastUpgradeVersion = "${version}"`
        )
        await fs.writeFile(schemePath, contents, 'utf8')
      } catch (e) {
        console.warn('[withXcodeLastUpgradeVersion] Could not patch xcscheme:', e.message)
      }
      return mod
    }
  ])
