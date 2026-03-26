export default {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['**/tests/**/*.test.js', '**/?(*.)+(spec|test).js'],
  collectCoverageFrom: ['server.js'],
  coveragePathIgnorePatterns: ['/node_modules/'],
  testTimeout: 15000,
};
