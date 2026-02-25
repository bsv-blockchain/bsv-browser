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

// Safe separator detection with fallbacks
const getSeparator = (type: 'group' | 'decimal'): string => {
  try {
    const locale = getLocaleDefault()
    const parts = Intl.NumberFormat(locale).formatToParts(1234.56)
    const part = parts.find(p => p.type === type)
    return part ? part.value : type === 'group' ? ',' : '.'
  } catch {
    // Fallback values if Intl is not supported
    return type === 'group' ? ',' : '.'
  }
}

const localeDefault = getLocaleDefault()
const groupDefault = getSeparator('group')
const decimalDefault = getSeparator('decimal')

export const satoshisOptions = {
  fiatFormats: [
    {
      name: 'USD',
      // value suitable as first arg for Intl.NumberFormat or null for default locale
      locale: 'en-US',
      // value suitable as currency property of second arg for Intl.NumberFormat
      currency: 'USD'
    },
    {
      name: 'USD_locale',
      locale: null,
      currency: 'USD'
    },
    {
      name: 'EUR',
      locale: null,
      currency: 'EUR'
    },
    {
      name: 'GBP',
      locale: null,
      currency: 'GBP'
    }
  ],
  satsFormats: [
    {
      // Format name for settings choice lookup
      name: 'SATS',
      // One of: 'SATS', 'BSV', 'mBSV'
      // 100,000,000 SATS === 1000 mBSV === 1 BSV
      unit: 'SATS',
      // string to insert between integer and fraction parts, null for locale default
      decimal: null,
      // string to insert every three digits from decimal, null for locale default
      group: null,
      // full unit label
      label: 'satoshis',
      // abbreviated unit label
      abbrev: 'sats'
    },
    {
      name: 'SATS_Tone',
      unit: 'SATS',
      decimal: '.',
      group: '_',
      label: 'satoshis',
      abbrev: 'sats'
    },
    {
      name: 'mBSV',
      unit: 'mBSV',
      decimal: null,
      group: null,
      label: 'mBSV',
      abbrev: ''
    },
    {
      name: 'mBSV_Tone',
      unit: 'mBSV',
      decimal: '.',
      group: '_',
      label: 'mBSV',
      abbrev: ''
    },
    {
      name: 'BSV',
      unit: 'BSV',
      decimal: null,
      group: null,
      label: 'BSV',
      abbrev: ''
    },
    {
      name: 'BSV_Tone',
      unit: 'BSV',
      decimal: '.',
      group: '_',
      label: 'BSV',
      abbrev: ''
    }
  ],
  isFiatPreferred: false // If true, fiat format is preferred, else satsFormat
}

// Format number as currency with fallback for platforms where Intl is not fully supported
const formatCurrency = (
  value: number,
  currency: string,
  locale: string,
  minDigits: number,
  maxDigits?: number
): string => {
  try {
    const options: Intl.NumberFormatOptions = {
      currency,
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
    let symbol = '$'

    if (currency === 'EUR') symbol = '€'
    else if (currency === 'GBP') symbol = '£'

    return `${symbol}${fixed}`
  }
}

export const formatSatoshisAsFiat = (
  satoshis = NaN,
  satoshisPerUSD = null,
  format: any = null,
  settingsCurrency = 'SATS',
  eurPerUSD = 0.93,
  gbpPerUSD = 0.79,
  showFiatAsInteger = false
) => {
  if (settingsCurrency) {
    // See if requested currency matches a known fiat format, if not use 'USD'
    let fiatFormat = satoshisOptions.fiatFormats.find(f => f.name === settingsCurrency)
    if (!fiatFormat) fiatFormat = satoshisOptions.fiatFormats.find(f => f.name === 'USD')
    format = fiatFormat
  }
  format ??= satoshisOptions.fiatFormats[0]
  const locale = format.locale ?? localeDefault

  const usd = satoshisPerUSD && Number.isInteger(Number(satoshis)) ? satoshis / satoshisPerUSD : NaN

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

  if (!format || format.currency === 'USD') {
    return formatCurrency(usd, 'USD', locale, minDigits, maxDigits)
  } else if (format.currency === 'EUR') {
    const eur = usd * eurPerUSD
    if (isNaN(eur)) return '...'
    return formatCurrency(eur, 'EUR', locale, minDigits, maxDigits)
  } else if (format.currency === 'GBP') {
    const gbp = usd * gbpPerUSD
    if (isNaN(gbp)) return '...'
    return formatCurrency(gbp, 'GBP', locale, minDigits, maxDigits)
  }

  // Default fallback
  return formatCurrency(usd, 'USD', locale, minDigits, maxDigits)
}
/**
 * Format a satoshi amount according to the specified format.
 * React Native compatible with proper error handling.
 */
export const formatSatoshis = (
  satoshis: any,
  showPlus = false,
  abbreviate = false,
  format: any = null,
  settingsCurrency = 'SATS'
): string => {
  try {
    if (settingsCurrency) {
      // See if requested currency matches a known satoshis format, if not use 'SATS'
      let satsFormat = satoshisOptions.satsFormats.find(f => f.name === settingsCurrency)
      if (!satsFormat) satsFormat = satoshisOptions.satsFormats.find(f => f.name === 'SATS')
      format = satsFormat
    }
    format = format ?? satoshisOptions.satsFormats[0]

    // Convert to number and validate
    const numValue = Number(satoshis)
    let s: any = Number.isInteger(numValue) ? numValue : null
    if (s === null) {
      return '---'
    }

    // Determine sign prefix
    const sign = s < 0 ? '-' : showPlus ? '+' : ''

    // Convert to absolute string value
    s = Math.abs(s).toFixed(0)

    // There are at most 21 some odd million hundred million satoshis.
    // We format this with the following separators.
    // Note that the decimal only appears after a hundred million satoshis.
    // 21_000_000.000_000_00
    const g = format.group ?? groupDefault
    const d = format.decimal ?? decimalDefault

    // Determine formatting pattern based on unit
    let p: [number, string][], sMinLen: number
    switch (format.unit) {
      case 'BSV':
        sMinLen = 9
        p = [
          [2, g],
          [3, g],
          [3, d],
          [3, g],
          [3, g]
        ]
        break
      case 'mBSV':
        sMinLen = 6
        p = [
          [2, g],
          [3, d],
          [3, g],
          [3, g],
          [3, g]
        ]
        break
      default:
        sMinLen = 0
        p = [
          [3, g],
          [3, g],
          [3, g],
          [3, g],
          [3, g]
        ]
        break
    }

    // Ensure minimum length by padding with zeros
    let r = ''
    while (s.length < sMinLen) s = '0' + s

    // Format the number with appropriate separators
    const pCopy = [...p] // Create a copy to avoid mutating the original array
    while (s.length > 0) {
      if (pCopy.length === 0) {
        r = s + r
        s = ''
      } else {
        const q = pCopy.shift()!
        r = s.substring(s.length - Math.min(q[0], s.length)) + r
        if (s.length > q[0]) {
          r = q[1] + r
          s = s.substring(0, s.length - q[0])
        } else {
          s = ''
        }
      }
    }

    // Combine sign, formatted value, and label
    r = `${sign}${r}`
    const label = abbreviate ? format.abbrev : format.label
    if (label && label.length > 0) {
      r = `${r} ${label}`
    }

    return r
  } catch (error) {
    // Fallback for any unexpected errors
    console.error('Error formatting satoshis:', error)
    const numValue = Number(satoshis)
    if (Number.isNaN(numValue)) return '---'

    // Very basic fallback formatting
    const sign = numValue < 0 ? '-' : showPlus ? '+' : ''
    const formatted = `${sign}${Math.abs(numValue).toLocaleString()}`
    const unit = format?.unit || 'SATS'
    return `${formatted} ${unit.toLowerCase()}`
  }
}
