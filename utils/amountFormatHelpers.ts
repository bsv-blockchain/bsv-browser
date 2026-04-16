// Safe locale detection for React Native
const getLocaleDefault = (): string => {
  try {
    // Try to get locale using Intl API if available
    return Intl.NumberFormat().resolvedOptions().locale?.split('-u-')[0] || 'en-US'
  } catch {
    // Fallback to en-US if Intl is not fully supported
    return 'en-US'
  }
}

const localeDefault = getLocaleDefault()

const SATS_PER_BSV = 100_000_000

// Format number as currency with fallback for platforms where Intl is not fully supported
const formatCurrency = (value: number, locale: string, minDigits: number, maxDigits?: number): string => {
  try {
    const options: Intl.NumberFormatOptions = {
      currency: 'USD',
      style: 'currency',
      minimumFractionDigits: minDigits
    }

    if (maxDigits !== undefined) {
      options.maximumFractionDigits = maxDigits
    }

    const formatter = new Intl.NumberFormat(locale, options)
    return formatter.format(value)
  } catch {
    // Fallback formatting if Intl is not supported
    const fixed = value.toFixed(minDigits)
    return `$${fixed}`
  }
}

/**
 * Format a satoshi amount as a locale-aware integer string with grouping separators.
 * E.g. 1234567 -> "1,234,567" (en-US) or "1.234.567" (de-DE)
 */
const formatSatoshisLocale = (satoshis: number): string => {
  try {
    return new Intl.NumberFormat(localeDefault, {
      maximumFractionDigits: 0,
      useGrouping: true
    }).format(satoshis)
  } catch {
    return Math.abs(satoshis).toLocaleString()
  }
}

/**
 * Format a BSV decimal amount with locale-aware separators.
 * Shows up to 8 decimal places, trimming trailing zeros.
 */
const formatBsvLocale = (bsvValue: number): string => {
  try {
    return new Intl.NumberFormat(localeDefault, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 8,
      useGrouping: true
    }).format(bsvValue)
  } catch {
    // Fallback: trim trailing zeros from toFixed(8)
    return parseFloat(bsvValue.toFixed(8)).toString()
  }
}

/**
 * Format a satoshi amount as USD using exchange rate.
 * Dynamically adjusts decimal precision based on magnitude.
 */
export const formatSatoshisAsFiat = (satoshis: number, satoshisPerUSD: number, showFiatAsInteger = false): string => {
  if (!Number.isInteger(Number(satoshis)) || !satoshisPerUSD || satoshisPerUSD <= 0) {
    return '...'
  }

  const usd = satoshis / satoshisPerUSD
  if (isNaN(usd)) return '...'

  let minDigits = 2
  let maxDigits: number | undefined
  const v = Math.abs(usd)
  if (v < 0.001) minDigits = 6
  else if (v < 0.01) minDigits = 5
  else if (v < 0.1) minDigits = 4
  else if (v < 1) minDigits = 3

  if (showFiatAsInteger) {
    minDigits = 0
    maxDigits = 0
  }

  return formatCurrency(usd, localeDefault, minDigits, maxDigits)
}

/**
 * Format a satoshi amount in BSV mode with smart threshold:
 * - < 100,000,000 sats (< 1 BSV): display as satoshis with grouping (e.g., "50,000 satoshis")
 * - >= 100,000,000 sats (>= 1 BSV): display as BSV with decimals (e.g., "1.5 BSV")
 *
 * All formatting is locale-aware.
 */
export const formatSatoshisAsBsv = (satoshis: number, showPlus = false, abbreviate = false): string => {
  const numValue = Number(satoshis)
  if (!Number.isInteger(numValue)) return '---'

  const sign = numValue < 0 ? '-' : showPlus ? '+' : ''
  const absValue = Math.abs(numValue)

  if (absValue >= SATS_PER_BSV) {
    // Display as BSV
    const bsvValue = absValue / SATS_PER_BSV
    return `${sign}${formatBsvLocale(bsvValue)} BSV`
  } else {
    // Display as satoshis
    const label = abbreviate ? 'sats' : 'satoshis'
    return `${sign}${formatSatoshisLocale(absValue)} ${label}`
  }
}

/**
 * Smart format function: formats a satoshi amount based on the currency setting.
 * - 'USD': converts to USD using exchange rate
 * - 'BSV' (default): uses smart threshold (satoshis for < 1 BSV, BSV for >= 1 BSV)
 */
export const formatAmount = (
  satoshis: number,
  currency: string = 'BSV',
  satoshisPerUSD: number = 0,
  options: { showPlus?: boolean; abbreviate?: boolean; showFiatAsInteger?: boolean } = {}
): string => {
  const { showPlus = false, abbreviate = false, showFiatAsInteger = false } = options

  if (currency === 'USD') {
    return formatSatoshisAsFiat(satoshis, satoshisPerUSD, showFiatAsInteger)
  }

  return formatSatoshisAsBsv(satoshis, showPlus, abbreviate)
}

/**
 * Convert a user-entered display value back to integer satoshis.
 * - BSV mode: input is satoshi integers, passthrough
 * - USD mode: input is dollar amount, multiply by satoshisPerUSD
 */
export const parseDisplayToSatoshis = (displayValue: string, currency: string, satoshisPerUSD: number): number => {
  const cleaned = displayValue.trim()
  if (!cleaned) return 0

  if (currency === 'USD') {
    const usdAmount = parseFloat(cleaned)
    if (isNaN(usdAmount)) return 0
    return Math.round(usdAmount * satoshisPerUSD)
  }

  // BSV mode: input is always integer satoshis
  const sats = parseInt(cleaned, 10)
  return isNaN(sats) ? 0 : sats
}

/**
 * Get the appropriate unit label for display.
 * In BSV mode, the label depends on the amount (satoshis vs BSV).
 * If no satoshi value is provided, returns "satoshis" (the input label for BSV mode).
 */
export const getUnitLabel = (currency: string, satoshis?: number, abbreviate = false): string => {
  if (currency === 'USD') return 'USD'

  // BSV mode: if an amount is provided, use threshold to pick label
  if (satoshis !== undefined && Math.abs(satoshis) >= SATS_PER_BSV) {
    return 'BSV'
  }

  return abbreviate ? 'sats' : 'satoshis'
}

// Keep legacy exports for backward compatibility during migration
export const formatSatoshis = formatSatoshisAsBsv
