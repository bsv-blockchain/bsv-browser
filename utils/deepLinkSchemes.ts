/**
 * Schemes that open this app for a pairing QR.
 *
 * `bsv-wallet` is accepted as well as our own so a code minted by BSV Wallet
 * still pairs when BSV Browser is the app the scanner has installed. Both are
 * registered in app.json and — because ios/ is committed, so EAS runs the
 * generic workflow and prebuild never regenerates it — in
 * ios/BSVBrowser/Info.plist directly.
 *
 * bsv-browser stays first: it is the canonical scheme this app mints.
 */
export const PAIRING_SCHEMES = ['bsv-browser://', 'bsv-wallet://'] as const

/** The pairing scheme this URL uses, or undefined if it is not a pairing link. */
export const pairingSchemeOf = (url: string): string | undefined => {
  const lower = url.toLowerCase()
  return PAIRING_SCHEMES.find(scheme => lower.startsWith(`${scheme}pair`))
}
