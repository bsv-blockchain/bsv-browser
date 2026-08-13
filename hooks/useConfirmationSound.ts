/**
 * The app's tiny sound palette — the audible half of key money/security moments.
 *
 * Companion to `hooks/useHaptics.ts`, deliberately the same shape: a plain
 * module object you can import anywhere, plus a hook alias for symmetry inside
 * components. Fire-and-forget, and it never throws.
 *
 * Three rules, all non-negotiable, because these play in public:
 *
 *  1. RESPECT THE SILENT SWITCH. `playsInSilentMode: false` — a phone set to
 *     silent stays silent. An app that overrides the ringer switch for its own
 *     receipt noise is an app people mute permanently.
 *  2. NEVER MIX BADLY. `interruptionMode: 'mixWithOthers'` — these are sub-1s
 *     blips, not a media session. Ducking or pausing someone's music to
 *     announce a payment is rude and, on iOS, sticky.
 *  3. NEVER BLOCK, NEVER THROW. Every call site is `void`; every failure — no
 *     native module, an audio session another app owns, a decode error — is
 *     swallowed to a single dev warning. A silent success is still a success.
 *
 * expo-audio is required lazily on first play, so a build missing the native
 * module degrades to silence at the one moment it is used rather than taking
 * the module graph down at startup.
 *
 * Pairing rules (each tone pairs with exactly one haptic; never fire both a
 * tone's partner haptic AND the tone's own — Toast/Celebration already own
 * haptics.success for their moments):
 *   confirmation ↔ haptics.success   (money landed)
 *   vaultOpen    ↔ haptics.success   (vault unlocked after the ceremony)
 *   vaultClose   ↔ haptics.confirm   (vault relocked: timeout / unplug / manual)
 */
import { useMemo } from 'react'

// Bundled tones. Static requires, not imports: Metro resolves these to asset
// ids at build time, which is exactly the `number` shape expo-audio accepts.
const TONES = {
  confirmation: require('../assets/sounds/payment-confirmed.wav'),
  vaultOpen: require('../assets/sounds/vault-open.wav'),
  vaultClose: require('../assets/sounds/vault-close.wav'),
} as const

type ToneName = keyof typeof TONES

/** Minimal structural view of the bits of expo-audio this module touches. */
interface Player {
  play(): void
  seekTo(seconds: number): Promise<void>
  remove(): void
}
interface AudioModule {
  createAudioPlayer(source: unknown): Player
  setAudioModeAsync(mode: Record<string, unknown>): Promise<void>
}

let audio: AudioModule | null | undefined
let modeSet = false
const players: Partial<Record<ToneName, Player>> = {}

function warn(e: unknown): void {
  if (__DEV__) console.warn('[sound] tone unavailable:', e instanceof Error ? e.message : String(e))
}

function load(): AudioModule | null {
  if (audio !== undefined) return audio
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    audio = require('expo-audio') as AudioModule
  } catch (e) {
    warn(e)
    audio = null
  }
  return audio
}

/**
 * Plays a tone, if the device is willing. Returns immediately; the audio-session
 * configuration is awaited *inside* the fire-and-forget promise so nothing on a
 * user-facing path ever waits on CoreAudio. One reused player per tone.
 */
function playTone(name: ToneName): void {
  const mod = load()
  if (!mod) return
  void (async () => {
    try {
      if (!modeSet) {
        await mod.setAudioModeAsync({
          playsInSilentMode: false,
          interruptionMode: 'mixWithOthers',
          shouldPlayInBackground: false,
          allowsRecording: false,
        })
        modeSet = true
      }
      let player = players[name]
      if (!player) {
        player = mod.createAudioPlayer(TONES[name])
        players[name] = player
      }
      await player.seekTo(0)
      player.play()
    } catch (e) {
      warn(e)
    }
  })()
}

/** Releases every shared player. Optional — call when the last screen that can
 * play a tone unmounts, to hand native objects back early. */
function releaseAll(): void {
  for (const key of Object.keys(players) as ToneName[]) {
    const p = players[key]
    delete players[key]
    try {
      p?.remove()
    } catch (e) {
      warn(e)
    }
  }
  modeSet = false
}

export const sounds = {
  /** The money landed. Pairs with `haptics.success()`. */
  confirmation: () => playTone('confirmation'),
  /** The vault unlocked after a successful ceremony. Pairs with `haptics.success()`. */
  vaultOpen: () => playTone('vaultOpen'),
  /** The vault relocked (timeout, unplug, or manual). Pairs with `haptics.confirm()`. */
  vaultClose: () => playTone('vaultClose'),
  release: releaseAll,
} as const

export const useConfirmationSound = () => useMemo(() => sounds, [])
