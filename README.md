# BSV Browser

Enabling identity, micropayments, and use of BSV websites on mobile devices.

- Runs ReactNative substrate via WebView
- Lets web apps talk to a wallet
- Authenticates with WAB
- Permissions management
- Trust and identity management
- ...

## To Run

You need Expo and Node installed.

Clone the repo, then:

```
npm i
npm run configure
```

```
npm run start
```

- Choose your network (mainnet/testnet), WAB and pick your Auth Method (Twiloo Phone for now)
- Pick a Storage URL
- Proceed to the wallet greeter, enter your phone, code, password, save recovery key
- You are in! Now BSV apps will work.

## Recommended Dev Setup

- [VS Code](https://code.visualstudio.com/)
- [Expo Go](https://expo.dev/guides/development-environment/)

## License

The license for the code in this repository is the Open BSV License.

## Supported Languages

The app is localised into the following languages using `react-i18next`:

| Code | Language |
|------|----------|
| `en` | English |
| `zh` | Chinese (Simplified) |
| `hi` | Hindi |
| `es` | Spanish |
| `fr` | French |
| `ar` | Arabic |
| `pt` | Portuguese |
| `bn` | Bengali |
| `ru` | Russian |
| `id` | Indonesian |

Translations live in `context/i18n/translations.tsx`. The device locale is detected automatically via `expo-localization` and falls back to English.
