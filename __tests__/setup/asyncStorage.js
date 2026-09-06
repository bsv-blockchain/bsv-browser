// Library components (theme, contexts, storage) import AsyncStorage at module
// scope, so rendering any of them pulls in the native module, which is null
// under Jest. Registering the official mock here covers every suite.
//
// Deliberately NOT a moduleNameMapper entry: several suites already call
// jest.mock() with a factory that requires this same mock path, and a mapper
// would redirect that require back onto itself — infinite recursion.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
