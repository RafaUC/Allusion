module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '\\.(css|scss)$': '<rootDir>/tests/setup/styleMock.js',
    '^src/(.*)$': '<rootDir>/src/$1',
    '^widgets/(.*)$': '<rootDir>/widgets/$1',
    '^common/(.*)$': '<rootDir>/common/$1',
    '^resources/(.*)$': '<rootDir>/resources/$1',
  },
  setupFiles: [
    '<rootDir>/tests/setup/jest.globals.js',
    // FIXME: I did not manage to get Dexie working in an actual Electron test environment. Testing in JavaScript is
    // cursed, so indexeddb is replaced by an in-memory implementation.
    'fake-indexeddb/auto',
    // Crypto module is not stable in the node version we use, nor can we use the browser.
    '<rootDir>/tests/setup/jest.crypto.js',
  ],
};
