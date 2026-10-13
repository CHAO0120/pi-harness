/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "jsdom",
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^obsidian$": "<rootDir>/tests/obsidian-mock.ts",
  },
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  // The relay caps concurrent sessions, so live tests must not race each other
  // for a slot.
  maxWorkers: 1,
};
