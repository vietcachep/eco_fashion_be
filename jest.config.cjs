/*
 * Jest: unit + integration test trong src/** (đuôi .spec.ts). Test e2e nằm ở test/ (jest-e2e.json).
 * Path alias @common/@modules… map qua moduleNameMapper để khớp tsconfig paths.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/scripts'],
  testRegex: '.*\.spec\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@common/(.*)$': '<rootDir>/src/common/$1',
    '^@config/(.*)$': '<rootDir>/src/config/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
  },
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/**/migration/**', '!src/main.ts', '!src/worker.ts'],
  coverageDirectory: 'coverage',
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  testTimeout: 30000,
};
