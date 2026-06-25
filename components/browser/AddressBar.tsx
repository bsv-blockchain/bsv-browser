import React, {
  forwardRef,
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import { Keyboard, Platform, Share, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  Easing,
  SharedValue
} from 'react-native-reanimated'
import Fuse from 'fuse.js'
import { Ionicons } from '@expo/vector-icons'
import { observer } from 'mobx-react-lite'
import { useFocusEffect } from 'expo-router'

import { haptics } from '@/hooks/useHaptics'
import { useTheme } from '@/context/theme/ThemeContext'
import { useLocalStorage } from '@/context/LocalStorageProvider'
import { useSheet } from '@/context/SheetContext'
import type { SheetRoute } from '@/context/SheetContext'
import type { Bookmark, HistoryEntry, Tab } from '@/shared/types/browser'
import { kNEW_TAB_URL, SEARCH_ENGINES, DEFAULT_SEARCH_ENGINE_ID, safeBottomInset, ADDRESS_BAR_HEIGHT } from '@/shared/constants'
import { buildLocationHrefScript, isValidUrl } from '@/utils/generalHelpers'
import { escapeForJsSingleQuote } from '@/utils/webview/errorPages'
import tabStore from '@/stores/TabStore'
import bookmarkStore from '@/stores/BookmarkStore'
import uiStore from '@/stores/uiStore'
import { useTranslation } from 'react-i18next'

import { AddressBarRow } from '@/components/browser/AddressBarRow'
import { GlassPill, useGlassColors } from '@/components/browser/GlassPill'
import { MenuPopover } from '@/components/browser/MenuPopover'
import { HistoryPopover } from '@/components/browser/HistoryPopover'
import { SuggestionsDropdown } from '@/components/browser/SuggestionsDropdown'
import { FindInPageBar } from '@/components/browser/FindInPageBar'
import { spacing } from '@/context/theme/tokens'
import LoadProgressBar from '@/components/browser/LoadProgressBar'

import { useAddressBarAnimation } from '@/hooks/useAddressBarAnimation'

/* -------------------------------------------------------------------------- */
/*                       ISOLATED BOOKMARK-AWARE MENU                         */
/* -------------------------------------------------------------------------- */
/**
 * Wraps MenuPopover in a tiny observer that reads `bookmarkStore.bookmarks`
 * for the active URL only. Without this wrapper the root `Browser` observer
 * has to read `bookmarkStore.bookmarks.some(...)` directly in its render,
 * which causes every bookmark mutation to re-render the entire WebView +
 * chrome tree. Confining the read here keeps bookmark churn local.
 */
type ObservedMenuPopoverProps = Omit<React.ComponentProps<typeof MenuPopover>, 'isBookmarked'> & {
  activeTabUrl: string | null
}
const ObservedMenuPopover = observer(({ activeTabUrl, ...rest }: ObservedMenuPopoverProps) => {
  const isBookmarked = !!activeTabUrl && bookmarkStore.bookmarks.some(b => b.url === activeTabUrl)
  return <MenuPopover {...rest} isBookmarked={isBookmarked} />
})

/* -------------------------------------------------------------------------- */
/*                              ADDRESS BAR (smart)                           */
/* -------------------------------------------------------------------------- */

export interface AddressBarHandle {
  /** Plain auto-focus of the URL input (new-tab autofocus path). */
  focusInput: () => void
  /**
   * The new-tab homepage focus dance: mark editing, focus, then select the full
   * homepage URL so the user can type over it immediately.
   */
  beginEditing: (selectUrl: string) => void
  /**
   * Forward a FIND_IN_PAGE_RESULT from the WebView message bridge (which stays
   * in the Browser shell) into the find-in-page state that lives here.
   */
  onFindInPageResult: (current: number, total: number, capped: boolean) => void
}

export interface AddressBarProps {
  // Page-load progress shared value (webview load events set it in Browser).
  loadProgress: SharedValue<number>
  isFullscreen: boolean
  updateActiveTab: (patch: Partial<Tab>) => void
  injectNavigationSplash: (url: string) => void
  // Ref to the tab id that can be "cancelled" (closed) from the in-bar X.
  cancelableNewTabId: React.MutableRefObject<number | null>
  // Shared set of tabs whose last load was user-cancelled. Owned by the shell so
  // its handleNavStateChange (the WebView event source) can clear entries when a
  // new load starts; the cancel/reload handlers here write/read it.
  cancelledLoadTabIds: React.MutableRefObject<Set<number>>
  // captureActiveThumbnail + setShowTabsView, run from the menu "Tabs" action.
  onShowTabs: () => void
  // handleNewTab from the shell (sets focusAddressBarOnNewTab + opens a new tab).
  onNewTab: () => void
  onEnableWeb3: () => void
  onConnections: () => void
  // Push a sheet route (e.g. 'browser-menu', 'settings').
  onOpenSheet: (route: SheetRoute) => void
  history: HistoryEntry[]
  addBookmark: (title: string, url: string) => void
}

export const AddressBar = observer(
  forwardRef<AddressBarHandle, AddressBarProps>(function AddressBar(
    {
      loadProgress,
      isFullscreen,
      updateActiveTab,
      injectNavigationSplash,
      cancelableNewTabId,
      cancelledLoadTabIds,
      onShowTabs,
      onNewTab,
      onEnableWeb3,
      onConnections,
      onOpenSheet,
      history,
      addBookmark
    }: AddressBarProps,
    ref
  ) {
    /* --------------------------- theme / basic hooks -------------------------- */
    const { colors } = useTheme()
    const gc = useGlassColors()
    const insets = useSafeAreaInsets()
    const { t } = useTranslation()
    const { getItem } = useLocalStorage()
    const sheet = useSheet()

    // Read the active tab as an observer — this is where the high-frequency
    // activeTab reads (isLoading, canGoBack/Forward, url) now live, so a page
    // load's loading-state churn re-renders only this AddressBar subtree, not
    // the 2000-line Browser shell.
    const activeTab = tabStore.activeTab

    const bottomInset = safeBottomInset(insets.bottom)

    /* -------------------------- ui / animation state -------------------------- */
    const addressEditing = useRef(false)
    const [addressText, setAddressText] = useState(kNEW_TAB_URL)
    const [addressSuggestions, setAddressSuggestions] = useState<(HistoryEntry | Bookmark)[]>([])

    const addressInputRef = useRef<TextInput>(null)

    const searchEngineTemplate = useRef(SEARCH_ENGINES.find(e => e.id === DEFAULT_SEARCH_ENGINE_ID)!.urlTemplate)

    useEffect(() => {
      const load = async () => {
        try {
          const storedEngine = await getItem('searchEngineId')
          if (storedEngine) {
            const engine = SEARCH_ENGINES.find(e => e.id === storedEngine)
            if (engine) searchEngineTemplate.current = engine.urlTemplate
          }
        } catch {}
      }
      load()
    }, [getItem])

    // Re-read search engine preference when the settings sheet closes
    useEffect(() => {
      if (sheet.isOpen) return
      ;(async () => {
        try {
          const storedEngine = await getItem('searchEngineId')
          if (storedEngine) {
            const engine = SEARCH_ENGINES.find(e => e.id === storedEngine)
            if (engine) searchEngineTemplate.current = engine.urlTemplate
          }
        } catch {}
      })()
    }, [sheet.isOpen, getItem])

    // Collapse ref + stable callback declared BEFORE the hook so the function
    // identity is defined at the call site (avoids TDZ → undefined → no-op default).
    const collapseRef = useRef<() => void>(() => {})
    const requestCollapseAddressBar = useCallback(() => {
      collapseRef.current()
    }, [])

    // Tracks whether the bar's collapse-exit animation is still in flight.
    // Lets us keep the bar's <Animated.View> mounted (and animating its fade
    // + scale on the UI thread) AFTER addressBarCollapsed has flipped to true,
    // so the bar's exit and the dot's entrance overlap visually.
    const [barExitAnimating, setBarExitAnimating] = useState(false)

    const handleCollapseAnimationEnd = useCallback(() => {
      setBarExitAnimating(false)
    }, [])

    // Forward declaration — implementation defined below. The kebab tap (when
    // bar is collapsed) calls this ref so we don't capture a stale identity.
    const expandRef = useRef<() => void>(() => {})
    const requestExpandAddressBar = useCallback(() => {
      expandRef.current()
    }, [])

    const {
      keyboardVisible,
      addressBarPanGesture,
      animatedAddressBarStyle,
      animatedMenuPopoverStyle,
      animatedKebabStyle,
      addressBarIsAtTop,
      resetGestureState
    } = useAddressBarAnimation(
      insets,
      uiStore.addressFocused,
      addressEditing,
      addressInputRef,
      uiStore.setAddressFocused,
      setAddressSuggestions,
      requestCollapseAddressBar,
      handleCollapseAnimationEnd,
      requestExpandAddressBar
    )

    // Menu popover visibility — driven by a shared value so the open/close
    // animation runs entirely on the UI thread (and stays smooth even while the
    // JS thread is blocked, e.g. parsing large BEEF payloads). React state
    // (menuPopoverOpen) controls mount; the close-side unmount only fires AFTER
    // the close animation completes via runOnJS in the withTiming callback.
    // The setMenuPopoverOpen(open) API is preserved so callers don't change.
    const [menuPopoverOpen, _setMenuPopoverMounted] = useState(false)
    const menuPopoverProgress = useSharedValue(0)
    const setMenuPopoverOpen = useCallback(
      (open: boolean) => {
        if (open) {
          // Snap progress to 1 INSTANTLY on open — no fade-in. Rationale:
          // the popover card is a LiquidGlassView (UIVisualEffectView on iOS).
          // If the wrapper's opacity animates from 0 -> 1 on first mount, the
          // native effect view initialises in a disabled state and stays stuck
          // transparent (the "first open is empty" bug). By making the wrapper
          // opaque on its FIRST paint, the effect view initialises enabled and
          // renders correctly. Perceptual motion still comes from the existing
          // translateY in `animatedMenuPopoverStyle`. The close path still
          // animates 1 -> 0 so the popover can fade out before unmounting.
          _setMenuPopoverMounted(true)
          menuPopoverProgress.value = 1
        } else {
          menuPopoverProgress.value = withTiming(0, { duration: 160, easing: Easing.in(Easing.cubic) }, finished => {
            if (finished) {
              runOnJS(_setMenuPopoverMounted)(false)
            }
          })
        }
      },
      [menuPopoverProgress]
    )

    // Binary visibility (NOT a fractional fade). The popover card is a
    // LiquidGlassView (UIVisualEffectView on iOS) and animating an ancestor's
    // opacity to fractional values triggers Apple's well-known stuck-effect
    // bug — the blur snaps transparent and STAYS broken until the native view
    // is re-mounted. We snap visible at the midpoint of the timing animation;
    // the perceptual fade comes from the popover's own enter/exit transform
    // (translateY in `animatedMenuPopoverStyle`).
    //
    // Note: we deliberately do NOT include a transform here, since this style is
    // composed with `animatedMenuPopoverStyle` (which owns translateY based on the
    // address-bar position). In React Native style merge, `transform` is replaced
    // wholesale by later entries — so adding scale here would clobber translateY.
    const animatedMenuVisibilityStyle = useAnimatedStyle(() => ({
      opacity: menuPopoverProgress.value >= 0.5 ? 1 : 0
    }))

    // HistoryPopover visibility — driven by a shared value so open/close runs
    // entirely on the UI thread (same pattern as MenuPopover above). React state
    // (historyPopoverDirection) controls mount + which side ('back' | 'forward'
    // | null); the close-side unmount only fires AFTER the close animation
    // completes via runOnJS in the withTiming callback.
    const [historyPopoverDirection, _setHistoryPopoverDirectionMounted] = useState<'back' | 'forward' | null>(null)
    const historyPopoverProgress = useSharedValue(0)
    const setHistoryPopoverDirection = useCallback(
      (next: 'back' | 'forward' | null) => {
        if (next !== null) {
          // Snap progress to 1 INSTANTLY on open — no fade-in. Same rationale as
          // `setMenuPopoverOpen` above: the popover card is a LiquidGlassView
          // (UIVisualEffectView on iOS), and a 0 -> 1 fade-in on first mount
          // leaves the native effect stuck transparent. Opening with opacity
          // already at 1 avoids the bug. Close still animates 1 -> 0 so the
          // popover can fade out before unmounting.
          _setHistoryPopoverDirectionMounted(next)
          historyPopoverProgress.value = 1
        } else {
          historyPopoverProgress.value = withTiming(0, { duration: 160, easing: Easing.in(Easing.cubic) }, finished => {
            if (finished) {
              runOnJS(_setHistoryPopoverDirectionMounted)(null)
            }
          })
        }
      },
      [historyPopoverProgress]
    )
    const historyPopoverOpen = historyPopoverDirection !== null
    // Binary visibility (NOT a fractional fade) — same rationale as
    // `animatedMenuVisibilityStyle` above. The popover card is a LiquidGlassView
    // / UIVisualEffectView, and fractional ancestor opacity sticks the effect
    // view transparent on iOS. Snap at the midpoint of the timing animation;
    // the perceptual movement comes from the wrapper's translateY in
    // `animatedMenuPopoverStyle` (composed with this style). Keep transforms
    // out of this style so the merge doesn't clobber translateY.
    const animatedHistoryVisibilityStyle = useAnimatedStyle(() => ({
      opacity: historyPopoverProgress.value >= 0.5 ? 1 : 0
    }))
    const desktopModeCooldown = useRef(false)

    /* ------------------------------ find in page ----------------------------- */
    const [findInPageVisible, setFindInPageVisible] = useState(false)
    const [findInPageQuery, setFindInPageQuery] = useState('')
    const [findInPageCurrent, setFindInPageCurrent] = useState(0)
    const [findInPageTotal, setFindInPageTotal] = useState(0)
    const [findInPageCapped, setFindInPageCapped] = useState(false)

    // Address bar collapse state (new gesture: rightward hold+swipe collapses bar into the ... button)
    const [addressBarCollapsed, setAddressBarCollapsed] = useState(false)
    // Remember where the bar was before collapsing so we can restore the position on expand
    const positionBeforeCollapse = useRef<'top' | 'bottom'>('bottom')

    // glassRevision — monotonically incremented on every collapse and every
    // expand. Used as `key` on the AddressBar subtree and on the collapsed
    // dot's GlassPill so React fully unmounts and re-mounts the underlying
    // LiquidGlassView (UIVisualEffectView on iOS) on each cycle.
    //
    // Why: @callstack/liquid-glass wraps Apple's UIVisualEffectView, which has
    // a well-known rendering bug — once its parent goes through a fractional
    // opacity transition (or ANY interruption while alpha < 1), the effect can
    // snap to fully transparent and STICK there even after parent opacity
    // returns to 1. Re-mounting the native view tears down the effect view and
    // re-creates it, restoring the blur. The user empirically confirmed this:
    // opening the menu popover (which conditionally re-renders the kebab pill)
    // unsticks it. We do the same thing automatically on collapse <-> expand.
    const [glassRevision, setGlassRevision] = useState(0)
    const bumpGlassRevision = useCallback(() => {
      setGlassRevision(r => r + 1)
    }, [])

    // When the Browser screen regains focus after returning from a pushed route
    // (transactions, payments, wallet-config, …): close any lingering menu
    // popover and remount the chrome LiquidGlass pills via glassRevision. The
    // native-stack route transition detaches/reattaches the screen's views,
    // which can leave a UIVisualEffectView (address-bar / back-button pills)
    // stuck transparent with nothing to cure it — a fresh key tears it down and
    // recreates it. Skipped on the first focus (initial mount) to avoid a
    // startup remount. (Closing the sheet on focus lives in the Browser shell.)
    const hasFocusedOnceRef = useRef(false)
    useFocusEffect(
      useCallback(() => {
        setMenuPopoverOpen(false)
        if (hasFocusedOnceRef.current) bumpGlassRevision()
        hasFocusedOnceRef.current = true
      }, [setMenuPopoverOpen, bumpGlassRevision])
    )

    const collapseAddressBar = useCallback(() => {
      // Remember pre-collapse position so expand can spring the bar back to the
      // same edge. The useAddressBarAnimation hook keeps addressBarAtTop.value
      // unchanged through the collapse so resetGestureState() on expand already
      // restores the correct translateY — this ref is just for any JS-side
      // consumers that need to know.
      positionBeforeCollapse.current = addressBarIsAtTop ? 'top' : 'bottom'
      // DO NOT bump glassRevision here. Bumping on collapse remounts the
      // AddressBar's LiquidGlass pills FRESH at the very moment the wrapper is
      // animating its opacity to 0 — a newly-mounted UIVisualEffectView that sees
      // an opacity change before its effect finishes initializing sticks
      // transparent (same "init disabled" mechanism as the menu popover), and that
      // stuck native view then returns to Fabric's recycler pool and poisons the
      // next expand's remount (the reported "pill transparent after hide/unhide",
      // alternating between the URL and back-button pills). The collapse bump also
      // did nothing useful: the collapsed dot/kebab GlassPill is NOT keyed by
      // glassRevision, so this only ever remounted the exiting bar. Let the
      // already-initialized pills animate out untouched; the expand bump below
      // remounts fresh pills at a stable opacity 1.
      // Flip JS state immediately (dot mounts at progress=0 and fades in via the
      // shared collapse-progress), and keep the bar wrapper mounted briefly via
      // barExitAnimating so its UI-thread fade/scale finishes on screen.
      //
      // Do NOT call resetGestureState() here — that would zero
      // addressBarCollapseProgress mid-animation, fighting the in-flight
      // withTiming(progress, 1) on the UI thread.
      setBarExitAnimating(true)
      setAddressBarCollapsed(true)
    }, [addressBarIsAtTop])

    const expandAddressBar = useCallback(() => {
      // CRITICAL order: zero out the shared values FIRST so that when React
      // commits the state changes below and the bar wrapper / AddressBar mount,
      // the animatedAddressBarStyle reads collapse=0 and emits opacity=1. If we
      // don't reset first, a stale collapse=1 from the just-finished collapse
      // animation causes the wrapper to mount at opacity=0, which traps every
      // LiquidGlassView pill descendant in Apple's stuck UIVisualEffectView
      // state (pills appear transparent / lost their blur background).
      resetGestureState()
      // DEFER the remount by one frame. resetGestureState() writes
      // addressBarCollapseProgress.value = 0 from the JS thread, but that write is
      // applied on the UI thread ASYNCHRONOUSLY. If we mount the fresh AddressBar
      // synchronously here, its LiquidGlass pills can paint their FIRST frame while
      // the UI thread still holds the stale collapsed progress (=1 → opacity 0),
      // mounting the new UIVisualEffectView at opacity 0 and sticking it
      // transparent before its effect initializes. Waiting one frame guarantees
      // the =0 write has propagated, so the pills mount at a stable opacity 1.
      requestAnimationFrame(() => {
        // Bump revision so the AddressBar mounts with a fresh key and its
        // LiquidGlass pills are brand-new native views — never inheriting a stuck
        // UIVisualEffectView state from the previous expand cycle.
        bumpGlassRevision()
        setAddressBarCollapsed(false)
        // Just in case the exit-end callback didn't fire (e.g. cancelled
        // animation), clear the bar's exit-mount flag so we don't have a ghost
        // wrapper layered behind the freshly re-mounted real bar.
        setBarExitAnimating(false)
      })
    }, [resetGestureState, bumpGlassRevision])

    // Keep the ref up to date so runOnJS always calls the latest version (avoids stale closures)
    useEffect(() => {
      collapseRef.current = collapseAddressBar
    }, [collapseAddressBar])
    useEffect(() => {
      expandRef.current = expandAddressBar
    }, [expandAddressBar])

    /* -------------------------------------------------------------------------- */
    /*                              ADDRESS HANDLING                              */
    /* -------------------------------------------------------------------------- */

    const onAddressSubmit = useCallback(() => {
      let entry = addressText.trim()
      const hasProtocol = /^[a-z]+:\/\//i.test(entry)
      const isIpAddress = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/i.test(entry)
      const isProbablyUrl = hasProtocol || /^(www\.|([A-Za-z0-9\-]+\.)+[A-Za-z]{2,})(\/|$)/i.test(entry) || isIpAddress

      if (entry === '') {
        entry = kNEW_TAB_URL
      } else if (!isProbablyUrl) {
        entry = searchEngineTemplate.current.replace('%s', encodeURIComponent(entry))
      } else if (!hasProtocol) {
        entry = isIpAddress ? 'http://' + entry : 'https://' + entry
      }

      if (!isValidUrl(entry)) entry = kNEW_TAB_URL

      injectNavigationSplash(entry)
      updateActiveTab({ url: entry })
      addressEditing.current = false
      cancelableNewTabId.current = null
    }, [addressText, updateActiveTab, injectNavigationSplash, cancelableNewTabId])

    /* -------------------------------------------------------------------------- */
    /*                          ADDRESS BAR AUTOCOMPLETE                          */
    /* -------------------------------------------------------------------------- */

    const fuseRef = useRef(
      new Fuse<HistoryEntry | Bookmark>([], {
        keys: ['title', 'url'],
        threshold: 0.4
      })
    )
    useEffect(() => {
      fuseRef.current.setCollection([...history, ...bookmarkStore.bookmarks])
    }, [history])

    // Keep input updates synchronous (so typing feels instant) but compute Fuse
    // results from a deferred value. React 19 schedules the suggestion update at
    // a lower priority, so a long Fuse pass on a big history list can never block
    // the TextInput keystroke render.
    const deferredAddressText = useDeferredValue(addressText)
    useEffect(() => {
      const txt = deferredAddressText.trim()
      if (txt.length === 0) {
        setAddressSuggestions([])
        return
      }
      const results = fuseRef.current
        .search(txt)
        .slice(0, 10)
        .map(r => r.item)
      const uniqueResults = results
        .filter((item, index, self) => index === self.findIndex(t => t.url === item.url))
        .slice(0, 5)
      setAddressSuggestions(uniqueResults)
    }, [deferredAddressText])

    const onChangeAddressText = useCallback((txt: string) => {
      setAddressText(txt)
    }, [])

    // Sync address text with tab url (only when the user isn't actively editing).
    // Browser writes tab.url through tabStore on every navigation (address submit,
    // suggestion tap, sheet navigation, nav-state change, manifest redirect); as
    // an observer this picks that up and reflects it in the input.
    // Depend on the url VALUE, not just the Tab object: tabStore mutates tab.url
    // IN PLACE (Object.assign / direct write), so the object identity is stable
    // across an in-tab navigation. AddressBar is an observer that reads
    // activeTab.url, so this primitive dep re-runs the effect on every committed
    // navigation (link tap, redirect, SPA route, manifest start-url, sheet nav)
    // as well as on tab switch — keeping the input in sync. The object stays in
    // deps too so switching to a same-url tab still re-syncs.
    useEffect(() => {
      if (activeTab && !addressEditing.current) {
        setAddressText(activeTab.url)
      }
    }, [activeTab, activeTab?.url])

    /* -------------------------------------------------------------------------- */
    /*                               TAB NAVIGATION                              */
    /* -------------------------------------------------------------------------- */
    const navBack = useCallback(() => {
      const currentTab = tabStore.activeTab
      if (currentTab?.canGoBack) tabStore.goBack(currentTab.id)
    }, [])

    const navBackLongPress = useCallback(() => {
      const currentTab = tabStore.activeTab
      if (!currentTab) return
      const { entries, currentIndex } = tabStore.getNavigationHistory(currentTab.id)
      // Only open if there's at least one back entry that isn't the new-tab sentinel
      const hasBack = entries.some((e, i) => i < currentIndex && e.url !== 'about:blank' && !e.url.includes('new-tab'))
      if (hasBack) setHistoryPopoverDirection('back')
    }, [setHistoryPopoverDirection])

    const navForward = useCallback(() => {
      const currentTab = tabStore.activeTab
      if (currentTab?.canGoForward) tabStore.goForward(currentTab.id)
    }, [])

    const navForwardLongPress = useCallback(() => {
      const currentTab = tabStore.activeTab
      if (!currentTab) return
      const { entries, currentIndex } = tabStore.getNavigationHistory(currentTab.id)
      const hasForward = entries.some((e, i) => i > currentIndex && e.url !== 'about:blank' && !e.url.includes('new-tab'))
      if (hasForward) setHistoryPopoverDirection('forward')
    }, [setHistoryPopoverDirection])

    const onSelectHistoryEntry = useCallback(
      (index: number) => {
        const currentTab = tabStore.activeTab
        if (currentTab) tabStore.navigateToHistoryIndex(currentTab.id, index)
        setHistoryPopoverDirection(null)
      },
      [setHistoryPopoverDirection]
    )

    /**
     * Cancel the active tab's in-flight load. stopLoading() alone is not enough:
     * WebKit reports the stopped provisional navigation as NSURLErrorCancelled
     * (-999), which react-native-webview swallows (no onError, no onLoadEnd), so
     * the tab's isLoading flag — and the navigation splash's spinner — would
     * otherwise stay stuck until something else navigates. Clear both ourselves.
     */
    const cancelActiveLoad = useCallback(() => {
      const currentTab = tabStore.activeTab
      if (!currentTab?.isLoading) return
      const webviewRef = currentTab.webviewRef?.current
      try {
        webviewRef?.stopLoading()
        // Flip the splash (if that's what's showing) to its cancelled state.
        // No-op on real pages — __navCancel only exists on the splash document.
        webviewRef?.injectJavaScript('window.__navCancel && window.__navCancel();true;')
      } catch {
        // WebView may be mid-teardown; cancelling is best-effort.
      }
      tabStore.updateTab(currentTab.id, { isLoading: false })
      tabStore.clearSwitchLoading()
      loadProgress.value = 0
      if (currentTab.url !== kNEW_TAB_URL && currentTab.url.startsWith('http')) {
        cancelledLoadTabIds.current.add(currentTab.id)
      }
    }, [loadProgress])

    const navReloadOrStop = useCallback(() => {
      const currentTab = tabStore.activeTab
      if (!currentTab) return
      if (currentTab.isLoading) {
        cancelActiveLoad()
      } else if (cancelledLoadTabIds.current.has(currentTab.id)) {
        // Retry the cancelled target rather than reloading the stale document.
        cancelledLoadTabIds.current.delete(currentTab.id)
        injectNavigationSplash(currentTab.url)
        currentTab.webviewRef?.current?.injectJavaScript(buildLocationHrefScript(currentTab.url))
      } else {
        currentTab.webviewRef?.current?.reload()
      }
    }, [cancelActiveLoad, injectNavigationSplash])

    // Stable AddressBar handlers so the memoized AddressBarRow (LiquidGlass pill)
    // skips reconciliation on re-renders that don't change its inputs.
    // activeTab is ref-stable across in-place MobX mutations, so these stay
    // stable across the page-load nav storm.
    const onAddressFocus = useCallback(() => {
      // A USER tap on the bar while a page is loading means they want to change
      // course (typo'd URL, slow host). Cancel the in-flight request immediately
      // so the correction isn't queued behind a dying load — and so the WebView
      // isn't doing network/layout work while they type. Programmatic focuses
      // (the new-tab homepage flow) set addressEditing BEFORE calling .focus(),
      // so this guard keeps them from cancelling their own homepage load.
      if (!addressEditing.current) cancelActiveLoad()
      setMenuPopoverOpen(false)
      setHistoryPopoverDirection(null)
      addressEditing.current = true
      uiStore.setAddressFocused(true)
      if (activeTab?.url === kNEW_TAB_URL) setAddressText('')
      setTimeout(() => {
        const textToSelect = activeTab?.url === kNEW_TAB_URL ? '' : addressText
        addressInputRef.current?.setNativeProps({
          selection: { start: 0, end: textToSelect.length }
        })
      }, 0)
    }, [activeTab, addressText, cancelActiveLoad, setMenuPopoverOpen, setHistoryPopoverDirection])

    const onAddressBlur = useCallback(() => {
      addressEditing.current = false
      uiStore.setAddressFocused(false)
      setAddressSuggestions([])
      setAddressText(activeTab?.url || kNEW_TAB_URL)
    }, [activeTab])

    const onClearAddressText = useCallback(() => setAddressText(''), [])

    const onCancelNewTabFn = useCallback(() => {
      const tabId = cancelableNewTabId.current!
      cancelableNewTabId.current = null
      Keyboard.dismiss()
      addressEditing.current = false
      uiStore.setAddressFocused(false)
      setAddressSuggestions([])
      tabStore.closeTab(tabId)
    }, [cancelableNewTabId])

    const onSuggestionSelect = useCallback(
      (url: string) => {
        addressInputRef.current?.blur()
        Keyboard.dismiss()
        uiStore.setAddressFocused(false)
        setAddressSuggestions([])
        setAddressText(url)
        injectNavigationSplash(url)
        updateActiveTab({ url })
        addressEditing.current = false
        cancelableNewTabId.current = null
      },
      [injectNavigationSplash, updateActiveTab, cancelableNewTabId]
    )

    const shareCurrent = useCallback(async () => {
      const currentTab = tabStore.activeTab
      if (!currentTab) return
      try {
        await Share.share({ message: currentTab.url })
      } catch {}
    }, [])

    /* -------------------------------------------------------------------------- */
    /*                              FIND IN PAGE                                  */
    /* -------------------------------------------------------------------------- */

    /**
     * Find-in-page uses the CSS Custom Highlight API when available (iOS 17.2+,
     * Android WebView 105+). This paints highlights at the rendering layer
     * without modifying the DOM — zero layout shifts, zero style conflicts.
     *
     * The state stored on window:
     *   __bsvFindRanges : Range[]   – every match range
     *   __bsvFindIdx    : number    – index of the active match
     */

    /** Clear all find highlights (CSS Highlight API). */
    const CLEAR_FIND_JS = `
    if(typeof CSS!=='undefined'&&CSS.highlights){
      CSS.highlights.delete('__bsv_find');
      CSS.highlights.delete('__bsv_find_active');
    }
    window.__bsvFindRanges=null;
    window.__bsvFindIdx=0;
    if(window.__bsvFindSheet){
      var idx=document.adoptedStyleSheets.indexOf(window.__bsvFindSheet);
      if(idx>=0){var a=Array.from(document.adoptedStyleSheets);a.splice(idx,1);document.adoptedStyleSheets=a;}
      window.__bsvFindSheet=null;
    }`

    const findInPageScript = useCallback(
      (query: string) => {
        if (!activeTab?.webviewRef?.current) return
        if (!query) {
          activeTab.webviewRef.current.injectJavaScript(`(function(){
          ${CLEAR_FIND_JS}
          window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
            type:'FIND_IN_PAGE_RESULT',current:0,total:0
          }));
        })();true;`)
          return
        }
        const escaped = escapeForJsSingleQuote(query)
        activeTab.webviewRef.current.injectJavaScript(`(function(){
        try{
          ${CLEAR_FIND_JS}

          // Check for CSS Custom Highlight API support
          var hasHighlightAPI=typeof CSS!=='undefined'&&typeof CSS.highlights!=='undefined'&&typeof Highlight!=='undefined';
          if(!hasHighlightAPI){
            window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
              type:'FIND_IN_PAGE_RESULT',current:0,total:0,error:'no_highlight_api'
            }));
            return;
          }

          // Inject styles via adoptedStyleSheets (bypasses CSP)
          if(!window.__bsvFindSheet){
            var sheet=new CSSStyleSheet();
            sheet.replaceSync('::highlight(__bsv_find){background-color:rgba(255,210,0,0.4);}::highlight(__bsv_find_active){background-color:rgba(255,150,0,0.6);}');
            window.__bsvFindSheet=sheet;
            document.adoptedStyleSheets=[].concat(Array.from(document.adoptedStyleSheets),[sheet]);
          }

          var MAX_MATCHES=1000;
          var query='${escaped}'.toLowerCase();
          if(!query){
            window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
              type:'FIND_IN_PAGE_RESULT',current:0,total:0
            }));
            return;
          }
          var qLen=query.length;

          // Walk text nodes and collect Range objects — no DOM modification
          var ranges=[];
          var capped=false;
          var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{
            acceptNode:function(n){
              var tag=n.parentElement&&n.parentElement.tagName;
              if(tag==='SCRIPT'||tag==='STYLE'||tag==='NOSCRIPT')return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            }
          },false);
          while(walker.nextNode()){
            var node=walker.currentNode;
            var text=(node.textContent||'').toLowerCase();
            var pos=0;
            while((pos=text.indexOf(query,pos))!==-1){
              var r=new Range();
              r.setStart(node,pos);
              r.setEnd(node,pos+qLen);
              ranges.push(r);
              pos+=qLen;
              if(ranges.length>=MAX_MATCHES){capped=true;break;}
            }
            if(capped)break;
          }

          window.__bsvFindRanges=ranges;
          window.__bsvFindIdx=0;

          if(ranges.length>0){
            CSS.highlights.set('__bsv_find',new Highlight(...ranges));
            CSS.highlights.set('__bsv_find_active',new Highlight(ranges[0]));
            // Scroll to first match using Selection (no DOM modification)
            var sel=window.getSelection();
            sel.removeAllRanges();
            var scrollRange=ranges[0].cloneRange();
            scrollRange.collapse(true);
            sel.addRange(scrollRange);
            var active=document.activeElement;
            if(active&&active.blur)active.blur();
            sel.removeAllRanges();
          }

          var total=capped?MAX_MATCHES:ranges.length;
          window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
            type:'FIND_IN_PAGE_RESULT',
            current:ranges.length>0?1:0,
            total:total,
            capped:capped
          }));
        }catch(e){
          window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
            type:'FIND_IN_PAGE_RESULT',current:0,total:0,error:e.message
          }));
        }
      })();true;`)
      },
      [activeTab]
    )

    const findInPageNavigate = useCallback(
      (direction: 'next' | 'prev') => {
        if (!activeTab?.webviewRef?.current) return
        activeTab.webviewRef.current.injectJavaScript(`(function(){
        var ranges=window.__bsvFindRanges;
        if(!ranges||ranges.length===0||typeof CSS==='undefined'||!CSS.highlights)return;
        var idx=window.__bsvFindIdx||0;
        idx=${direction === 'next' ? '(idx+1)%ranges.length' : '(idx-1+ranges.length)%ranges.length'};
        window.__bsvFindIdx=idx;
        CSS.highlights.set('__bsv_find_active',new Highlight(ranges[idx]));
        // Scroll into view using Selection API (no DOM modification)
        try{
          var sel=window.getSelection();
          sel.removeAllRanges();
          var scrollRange=ranges[idx].cloneRange();
          scrollRange.collapse(true);
          sel.addRange(scrollRange);
          var el=document.createElement('span');
          scrollRange.insertNode(el);
          el.scrollIntoView({block:'center'});
          el.parentNode.removeChild(el);
          sel.removeAllRanges();
        }catch(e){}
        window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({
          type:'FIND_IN_PAGE_RESULT',current:idx+1,total:ranges.length
        }));
      })();true;`)
      },
      [activeTab]
    )

    const closeFindInPageRef = useRef<() => void>(() => {})

    const closeFindInPage = useCallback(() => {
      setFindInPageVisible(false)
      setFindInPageQuery('')
      setFindInPageCurrent(0)
      setFindInPageTotal(0)
      setFindInPageCapped(false)
      if (activeTab?.webviewRef?.current) {
        activeTab.webviewRef.current.injectJavaScript(`(function(){
        ${CLEAR_FIND_JS}
      })();true;`)
      }
    }, [activeTab])

    closeFindInPageRef.current = closeFindInPage

    const findInPageVisibleRef = useRef(false)
    findInPageVisibleRef.current = findInPageVisible

    /** Debounce timer for find-in-page queries */
    const findDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const onFindInPageQueryChange = useCallback(
      (text: string) => {
        setFindInPageQuery(text)
        if (findDebounceRef.current) clearTimeout(findDebounceRef.current)
        findDebounceRef.current = setTimeout(() => {
          findInPageScript(text)
        }, 250)
      },
      [findInPageScript]
    )

    // Close find-in-page when the active tab changes
    useEffect(() => {
      if (findInPageVisibleRef.current) {
        closeFindInPageRef.current()
      }
    }, [activeTab?.id]) // eslint-disable-line react-hooks/exhaustive-deps

    /* -------------------------------------------------------------------------- */
    /*                            IMPERATIVE FOCUS API                           */
    /* -------------------------------------------------------------------------- */
    // The Browser shell owns the new-tab / homepage lifecycle effects (they read
    // tabStore + persisted homepageUrl). Those effects drive the address-bar
    // focus, but the input ref / editing flag / text live here — so the shell
    // calls these handles instead of reaching across the boundary.
    useImperativeHandle(
      ref,
      () => ({
        focusInput: () => {
          uiStore.setAddressFocused(true)
          addressInputRef.current?.focus()
        },
        beginEditing: (selectUrl: string) => {
          addressEditing.current = true
          // Pre-fill the input with the url so the selection highlights real
          // text for type-over. The url-sync effect won't fire here (the new-tab
          // Tab object is mutated in place, stable identity), so set it directly.
          setAddressText(selectUrl)
          uiStore.setAddressFocused(true)
          addressInputRef.current?.focus()
          setTimeout(() => {
            addressInputRef.current?.setNativeProps({
              selection: { start: 0, end: selectUrl.length }
            })
          }, 0)
        },
        onFindInPageResult: (current: number, total: number, capped: boolean) => {
          setFindInPageCurrent(current)
          setFindInPageTotal(total)
          setFindInPageCapped(capped)
        }
      }),
      []
    )

    /* -------------------------------------------------------------------------- */
    /*                                  RENDER                                    */
    /* -------------------------------------------------------------------------- */

    const showAddressBar = Platform.OS === 'android' ? !keyboardVisible || uiStore.addressFocused : true
    const addressFocused = uiStore.addressFocused
    const isNewTab = activeTab?.url === kNEW_TAB_URL

    // Geometry used by native chrome overlays. The WebView itself remains
    // full-height; users can collapse the address bar when it covers page
    // controls.
    const bottomReservedHeight = !addressBarIsAtTop && !isFullscreen ? safeBottomInset(insets.bottom) + ADDRESS_BAR_HEIGHT : 0

    return (
      <>
        {/* Touch blocker shield:
            - WebView frame is kept full-height so page backgrounds, heroes, and
              full-bleed visuals can paint under the frosted-glass address bar.
            - When the address bar is at the bottom, this transparent overlay
              captures touches in the bottom (safeBottom + 48px) region, preventing
              web content's fixed/sticky tappable elements from being hit "under"
              the bar while still allowing the visual background to show through.
            - zIndex sits above WebView (0) but below chromeWrapper (20). */}
        {/* Touch blocker area — full height when bar is expanded, tiny right-corner area when collapsed */}
        {!addressBarCollapsed && bottomReservedHeight > 0 && (
          <View
            pointerEvents="auto"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: bottomReservedHeight,
              backgroundColor: 'transparent',
              zIndex: 15
            }}
          />
        )}

        {/* Small right-side blocker when collapsed (only protects taps under the ... button) */}
        {addressBarCollapsed && (
          <View
            pointerEvents="auto"
            style={{
              position: 'absolute',
              right: spacing.md - 4,
              bottom: 0,
              width: 52,
              height: safeBottomInset(insets.bottom) + 52,
              backgroundColor: 'transparent',
              zIndex: 15
            }}
          />
        )}

        {/* Always-mounted kebab (...) pill.
            Lives OUTSIDE the collapsing address-bar wrapper so it stays
            visible during right-swipe collapse. Its translateY follows the
            bar's vertical position (top vs bottom) + keyboard offset via
            `animatedKebabStyle`, but the style emits NO opacity, NO scale,
            NO translateX — only translateY. This is required so the
            LiquidGlassView (UIVisualEffectView on iOS) never sees a
            fractional-opacity ancestor (Apple's stuck-effect bug).
            The kebab's tap action is always "open the menu popover". */}
        {!isFullscreen && showAddressBar && !addressFocused && (
          <Animated.View
            style={[
              {
                position: 'absolute',
                right: spacing.md,
                top: insets.top + spacing.xs,
                zIndex: 30,
                width: 44,
                height: 44
              },
              animatedKebabStyle
            ]}
            pointerEvents="box-none"
          >
            {!menuPopoverOpen && (
              <GlassPill style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                <TouchableOpacity
                  onPress={() => {
                    // Collapsed bar: first tap re-expands the address bar.
                    // Expanded bar: tap opens the menu popover.
                    if (addressBarCollapsed) {
                      requestExpandAddressBar()
                      return
                    }
                    setHistoryPopoverDirection(null)
                    setMenuPopoverOpen(true)
                  }}
                  style={{
                    width: 44,
                    height: 44,
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                  activeOpacity={0.6}
                >
                  <Ionicons name="ellipsis-horizontal" size={20} color={gc.accent} />
                </TouchableOpacity>
              </GlassPill>
            )}
          </Animated.View>
        )}

        {/* Address bar re-expand is now a single tap on the kebab (...) pill.
            The previous full-width left-swipe hit area was removed because it
            captured touches across the entire top strip, blocking taps that
            should land on the web page beneath. */}

        {/* ---- Floating Address Bar + Popover (absolutely positioned) ----
            Stays mounted while the collapse exit animation plays (gated by
            barExitAnimating) so the bar's UI-thread fade + scale completes
            on screen before the wrapper unmounts. The GestureDetector is
            still wrapped here, but during exit-animating the bar is fading
            to opacity 0 so taps don't land on it visually. */}
        {!isFullscreen && showAddressBar && (!addressBarCollapsed || barExitAnimating) && (
          <>
            <GestureDetector gesture={addressBarPanGesture}>
              <Animated.View
                key={`chrome-wrapper-${glassRevision}`}
                style={[styles.chromeWrapper, { top: insets.top }, animatedAddressBarStyle]}
                // Block taps during the collapse-exit animation so the fading
                // bar can't receive ghost touches before it unmounts.
                pointerEvents={addressBarCollapsed ? 'none' : 'box-none'}
              >
                <AddressBarRow
                  key={`address-bar-${glassRevision}`}
                  addressText={addressText}
                  addressFocused={addressFocused}
                  isLoading={activeTab?.isLoading || false}
                  canGoBack={activeTab?.canGoBack || false}
                  canGoForward={activeTab?.canGoForward || false}
                  isNewTab={activeTab?.url === kNEW_TAB_URL}
                  isHttps={activeTab?.url?.startsWith('https') || false}
                  historyPopoverOpen={historyPopoverOpen}
                  inputRef={addressInputRef}
                  onChangeText={onChangeAddressText}
                  onSubmit={onAddressSubmit}
                  onFocus={onAddressFocus}
                  onBlur={onAddressBlur}
                  onBack={navBack}
                  onBackLongPress={navBackLongPress}
                  onForward={navForward}
                  onForwardLongPress={navForwardLongPress}
                  onReloadOrStop={navReloadOrStop}
                  onClearText={onClearAddressText}
                  onCancelNewTab={cancelableNewTabId.current === activeTab?.id ? onCancelNewTabFn : undefined}
                />
                <LoadProgressBar progress={loadProgress} />
              </Animated.View>
            </GestureDetector>

            {/* ---- Suggestions ---- */}
            {addressFocused && (
              <SuggestionsDropdown
                suggestions={addressSuggestions}
                colors={colors}
                bottomOffset={bottomInset}
                onSelect={onSuggestionSelect}
              />
            )}
          </>
        )}

        {/* ---- Find in Page Bar ---- */}
        {findInPageVisible && !isFullscreen && (
          <View style={{ position: 'absolute', top: insets.top, left: 0, right: 0, zIndex: 30 }}>
            <FindInPageBar
              query={findInPageQuery}
              currentMatch={findInPageCurrent}
              totalMatches={findInPageTotal}
              capped={findInPageCapped}
              onChangeQuery={onFindInPageQueryChange}
              onNext={() => findInPageNavigate('next')}
              onPrevious={() => findInPageNavigate('prev')}
              onClose={closeFindInPage}
            />
          </View>
        )}

        {/* ---- Menu Popover (full-screen layer so backdrop covers everything) ----
            Stays mounted while the close animation plays (the JS unmount only
            fires after the UI-thread fade-out completes via runOnJS callback). */}
        {menuPopoverOpen && (
          <Animated.View
            style={[
              { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
              animatedMenuPopoverStyle,
              animatedMenuVisibilityStyle
            ]}
          >
            <ObservedMenuPopover
              activeTabUrl={activeTab?.url ?? null}
              isNewTab={isNewTab}
              canShare={!isNewTab}
              addressBarAtTop={addressBarIsAtTop}
              topOffset={8}
              bottomOffset={bottomInset + 4}
              isDesktopMode={activeTab?.isDesktopMode ?? false}
              onDismiss={() => setMenuPopoverOpen(false)}
              onShare={shareCurrent}
              onAddBookmark={() => {
                if (activeTab && activeTab.url !== kNEW_TAB_URL && isValidUrl(activeTab.url)) {
                  addBookmark(activeTab.title || t('untitled'), activeTab.url)
                }
              }}
              onRemoveBookmark={() => {
                if (activeTab) {
                  bookmarkStore.removeBookmark(activeTab.url)
                }
              }}
              onFindInPage={() => setFindInPageVisible(true)}
              onBookmarks={() => onOpenSheet('browser-menu')}
              onTabs={async () => {
                haptics.tap()
                onShowTabs()
              }}
              onNewTab={onNewTab}
              onSettings={() => onOpenSheet('settings')}
              onEnableWeb3={onEnableWeb3}
              onConnections={onConnections}
              onToggleDesktopMode={() => {
                if (!activeTab || desktopModeCooldown.current) return
                desktopModeCooldown.current = true
                setMenuPopoverOpen(false)
                tabStore.toggleDesktopMode(activeTab.id)
                // The native layer sets customUserAgent but does not reload automatically,
                // so we must trigger a reload explicitly after the state update propagates.
                if (activeTab.url !== kNEW_TAB_URL) {
                  setTimeout(() => {
                    activeTab.webviewRef.current?.reload()
                  }, 50)
                }
                setTimeout(() => {
                  desktopModeCooldown.current = false
                }, 1500)
              }}
            />
          </Animated.View>
        )}

        {/* ---- History Popover (full-screen layer, anchored left) ----
            Stays mounted while the close animation plays (the JS unmount only
            fires after the UI-thread fade-out completes via runOnJS callback,
            same pattern as MenuPopover). */}
        {historyPopoverOpen &&
          activeTab &&
          (() => {
            const { entries, currentIndex } = tabStore.getNavigationHistory(activeTab.id)
            return (
              <Animated.View
                style={[
                  { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
                  animatedMenuPopoverStyle,
                  animatedHistoryVisibilityStyle
                ]}
              >
                <HistoryPopover
                  entries={entries}
                  currentIndex={currentIndex}
                  direction={historyPopoverDirection!}
                  addressBarAtTop={addressBarIsAtTop}
                  topOffset={8}
                  bottomOffset={bottomInset + 4}
                  onDismiss={() => setHistoryPopoverDirection(null)}
                  onSelectEntry={onSelectHistoryEntry}
                />
              </Animated.View>
            )
          })()}
      </>
    )
  })
)

const styles = StyleSheet.create({
  chromeWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 20,
    // Collapse shrinks toward the right edge (where the ... menu button sits) so
    // the bar visibly tucks into the kebab — signalling that tapping ... brings
    // it back. Paired with scale/translate in animatedAddressBarStyle.
    transformOrigin: 'right center'
  }
})
