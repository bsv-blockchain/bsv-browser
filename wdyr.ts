/**
 * why-did-you-render bootstrap. Dev-only.
 *
 * Imported for its side effect at the very top of app/_layout.tsx — BEFORE any
 * component is defined/rendered. Wrapped in try/catch and a dynamic require so
 * the build never breaks if the package is absent or incompatible with the
 * current React version.
 *
 * Note: MobX `observer` components re-render via reactions, not prop changes, so
 * wdyr captures little for them — use the `useRenderCount` hook / React
 * <Profiler> for those. wdyr is most useful for plain prop-driven children.
 *
 * To track a specific component, set `MyComponent.whyDidYouRender = true`.
 */
if (__DEV__) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wdyr = require('@welldone-software/why-did-you-render')
    ;(wdyr.default || wdyr)(React, {
      trackAllPureComponents: false,
      trackHooks: true,
      logOnDifferentValues: true,
      collapseGroups: true
    })
    console.log('[wdyr] enabled')
  } catch {
    console.log('[wdyr] not installed — run: npm i -D @welldone-software/why-did-you-render')
  }
}

export {}
