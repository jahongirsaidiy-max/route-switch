import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const WORKSPACE_PACKAGES = ['shared', 'helper', 'app'];

// Which workspace packages each package may import. `app` and `helper` talk
// only over the unix socket, so neither may import the other.
const ALLOWED_WORKSPACE_IMPORTS = {
  shared: [],
  helper: ['shared'],
  app: ['shared'],
};

const CHILD_PROCESS_RESTRICTION = ['child_process', 'node:child_process'].map((name) => ({
  name,
  importNames: ['exec', 'execSync', 'default'],
  message:
    'No shell: import { execFile } (or spawn) by name and call it with an absolute path and an argument array.',
}));

// Matches the package name (`@routeswitch/helper`, `@routeswitch/helper/x`) and
// relative paths that climb into the sibling package (`../../helper/src/x`).
const importsOfPackage = (target) => ({
  regex: `^(?:@routeswitch/${target}(?:/|$)|(?:\\.\\./)+(?:packages/)?${target}(?:/?$|/(?:src|dist|package\\.json)(?:/|$)))`,
  message: `Package boundary: this package must not import @routeswitch/${target}.`,
});

// `no-restricted-imports` does not merge across config objects, so every
// package block carries the child_process restriction together with its own
// boundary patterns.
const restrictedImports = (forbiddenPackages) => [
  'error',
  {
    paths: CHILD_PROCESS_RESTRICTION,
    patterns: forbiddenPackages.map(importsOfPackage),
  },
];

const boundaryConfigs = WORKSPACE_PACKAGES.map((name) => ({
  name: `routeswitch/boundaries/${name}`,
  files: [`packages/${name}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}`],
  rules: {
    'no-restricted-imports': restrictedImports(
      WORKSPACE_PACKAGES.filter(
        (other) => other !== name && !ALLOWED_WORKSPACE_IMPORTS[name].includes(other),
      ),
    ),
  },
}));

const CHILD_PROCESS_SOURCE = '/^(node:)?child_process$/';

export default defineConfig(
  {
    name: 'routeswitch/ignores',
    ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/build/**', '**/release/**', '**/coverage/**'],
  },
  {
    name: 'routeswitch/linter-options',
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    name: 'routeswitch/type-aware',
    files: ['packages/*/src/**/*.{ts,tsx,mts,cts}'],
    extends: [tseslint.configs.strictTypeCheckedOnly],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    name: 'routeswitch/rules',
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-imports': restrictedImports([]),
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ObjectExpression > Property[key.name="shell"]:not([value.value=false])',
          message: 'No shell: the `shell` option is forbidden. Use execFile/spawn with an argument array.',
        },
        {
          selector: 'ObjectExpression > Property[key.value="shell"]:not([value.value=false])',
          message: 'No shell: the `shell` option is forbidden. Use execFile/spawn with an argument array.',
        },
        {
          selector: `ImportExpression[source.value=${CHILD_PROCESS_SOURCE}]`,
          message: 'Import child_process statically by name so exec/execSync stay blocked.',
        },
        {
          selector: `CallExpression[callee.name="require"][arguments.0.value=${CHILD_PROCESS_SOURCE}]`,
          message: 'Import child_process statically by name so exec/execSync stay blocked.',
        },
      ],
    },
  },
  ...boundaryConfigs,
);
