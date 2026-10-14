import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    // main.js is generated, relay/ is a mirror of a plain-JS service.
    ignores: ["main.js", "styles.css", "relay/**", "node_modules/**"],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*", "jest.config.*", "esbuild.config.mjs"],
        },
      },
    },
  },
  {
    // The DOM shim deliberately traffics in `any`: it patches the prototype.
    files: ["tests/dom-helpers.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // The shim implements createEl; it must use the DOM directly.
      "obsidianmd/prefer-create-el": "off",
    },
  },
  {
    // Build/CI config files run in Node, not in the plugin sandbox, so the
    // mobile-facing rules and the logging rule do not apply to them.
    files: ["*.js", "*.mjs", "*.cjs"],
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/hardcoded-config-path": "off",
      // These run against a plain DOM, not inside Obsidian: --fix rewriting
      // document.createElement into createDiv() broke the mock outright.
      "obsidianmd/prefer-create-el": "off",
      "obsidianmd/rule-custom-message": "off",
    },
    languageOptions: { globals: { module: "readonly", require: "readonly", __dirname: "readonly", process: "readonly" } },
  },
  {
    // Jest globals, so the suites lint as cleanly as src/.
    files: ["tests/**/*.ts"],
    languageOptions: {
      globals: {
        describe: "readonly", it: "readonly", test: "readonly", expect: "readonly",
        jest: "readonly", beforeEach: "readonly", afterEach: "readonly",
        beforeAll: "readonly", afterAll: "readonly",
        process: "readonly", require: "readonly", __dirname: "readonly",
      },
    },
    rules: {
      // The suites run in Node and stub Obsidian, so the mobile-facing rules
      // and the strict typing rules do not apply to them.
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/hardcoded-config-path": "off",
      // These run against a plain DOM, not inside Obsidian: --fix rewriting
      // document.createElement into createDiv() broke the mock outright.
      "obsidianmd/prefer-create-el": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
]);
