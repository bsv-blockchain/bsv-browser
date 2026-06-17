// Custom reanimated mock that extends the official mock with useReducedMotion.
// The official mock at node_modules/react-native-reanimated/mock.js does not
// include useReducedMotion (it is only a comment placeholder in src/mock.ts).
// We spread the official mock and add the missing export so PressableScale
// and any other components using useReducedMotion work in tests.

const officialMock = require('../../node_modules/react-native-reanimated/mock.js');

module.exports = {
  ...officialMock,
  default: {
    ...officialMock.default,
  },
  useReducedMotion: () => false,
};
