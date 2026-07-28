// Manual mock for expo-audio, wired through `moduleNameMapper` in package.json
// (the same route the reanimated mock takes).
//
// Two reasons it has to exist rather than relying on jest-expo:
//   1. `transformIgnorePatterns` in this repo does not cover hyphenated
//      `expo-*` packages, so the real ESM build would fail to parse under Jest.
//   2. jest-expo's auto-mock table exposes ExpoAudio's free functions but no
//      `AudioPlayer` constructor, so `createAudioPlayer` would throw.
//
// Plain recorders rather than jest.fn(), so the file has no dependency on a
// jest global being present at module-init time.

const calls = {
  created: [],
  played: 0,
  sought: [],
  removed: 0,
  audioModes: [],
}

class Player {
  constructor(source) {
    this.source = source
    this.playing = false
  }
  play() {
    this.playing = true
    calls.played += 1
  }
  pause() {
    this.playing = false
  }
  seekTo(seconds) {
    calls.sought.push(seconds)
    return Promise.resolve()
  }
  remove() {
    calls.removed += 1
  }
}

function createAudioPlayer(source) {
  const p = new Player(source)
  calls.created.push(source)
  return p
}

function setAudioModeAsync(mode) {
  calls.audioModes.push(mode)
  return Promise.resolve()
}

function setIsAudioActiveAsync() {
  return Promise.resolve()
}

function __reset() {
  calls.created.length = 0
  calls.sought.length = 0
  calls.audioModes.length = 0
  calls.played = 0
  calls.removed = 0
}

module.exports = {
  __esModule: true,
  AudioPlayer: Player,
  createAudioPlayer,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  __calls: calls,
  __reset,
}
