// stores/uiStore.ts
import { makeAutoObservable } from 'mobx'

/**
 * Cross-cutting nav-chrome UI flags shared between the AddressBar subsystem and
 * the Browser shell. These two booleans used to be `useState` inside the
 * 2000-line Browser observer, so flipping them (focus the address bar, move the
 * bar top<->bottom) re-rendered the whole shell + WebView tree. Promoting them
 * to a tiny MobX store makes them a single source of truth that AddressBar
 * writes and Browser reads as an observer — only the components that actually
 * read a flag re-render when it changes.
 *
 * Mirrors the singleton pattern in stores/TabStore.tsx.
 */
export class UIStore {
  // True while the address-bar input is focused (user is typing a URL). Browser
  // reads this for the KeyboardAvoidingView `enabled` prop; AddressBar + the
  // useAddressBarAnimation hook read/write it for the focus-driven bar position.
  addressFocused = false

  // JS-thread mirror of the address bar's vertical position (top vs bottom),
  // flipped by useAddressBarAnimation. Browser reads it for the WebView bottom
  // inset (bottomReservedHeight) and the SwitchLoadingOverlay placement.
  addressBarAtTop = false

  constructor() {
    makeAutoObservable(this)
  }

  setAddressFocused = (v: boolean) => {
    this.addressFocused = v
  }

  setAddressBarAtTop = (v: boolean) => {
    this.addressBarAtTop = v
  }
}

const uiStore = new UIStore()
export default uiStore
