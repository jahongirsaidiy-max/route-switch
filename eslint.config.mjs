import { builtinModules } from 'node:module';

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
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
// block that sets it carries the child_process restriction and the package
// boundary together with its own extra patterns.
const restrictedImports = (forbiddenPackages, extraPatterns = []) => [
  'error',
  {
    paths: CHILD_PROCESS_RESTRICTION,
    patterns: [...forbiddenPackages.map(importsOfPackage), ...extraPatterns],
  },
];

const forbiddenPackagesFor = (name) =>
  WORKSPACE_PACKAGES.filter((other) => other !== name && !ALLOWED_WORKSPACE_IMPORTS[name].includes(other));

const SOURCE_FILES = '*.{ts,tsx,mts,cts,js,mjs,cjs}';

const boundaryConfigs = WORKSPACE_PACKAGES.map((name) => ({
  name: `routeswitch/boundaries/${name}`,
  files: [`packages/${name}/**/${SOURCE_FILES}`],
  rules: {
    'no-restricted-imports': restrictedImports(forbiddenPackagesFor(name)),
  },
}));

// The Electron app's three contexts. The renderer is a sandboxed web page: it
// reaches the system only through the preload API, so it may not import
// Electron, Node built-ins or the code of the other two contexts. The preload
// is bundled on its own and must not pull in main-process code.
const BARE_NODE_BUILTINS = builtinModules.filter((name) => !name.startsWith('node:') && !name.startsWith('_'));

// Relative paths that climb out to `src/main` (or `src/preload`).
const importsOfAppContext = (contexts, from) => ({
  regex: `^(?:\\.\\./)+(?:src/)?(?:${contexts.join('|')})(?:/|$)`,
  message: `Electron context boundary: ${from} code must not import ${contexts.join(' or ')}-process code.`,
});

const RENDERER_RESTRICTIONS = [
  {
    regex: '^electron(?:/|$)',
    message: 'The renderer must not import electron. Use the API the preload exposes.',
  },
  {
    regex: `^(?:node:|(?:${BARE_NODE_BUILTINS.join('|')})(?:/|$))`,
    message: 'The renderer must not import Node built-ins. Use the API the preload exposes.',
  },
  importsOfAppContext(['main', 'preload'], 'renderer'),
];

const PRELOAD_RESTRICTIONS = [importsOfAppContext(['main'], 'preload')];

// `src/i18n` is imported by both the main process and the renderer, so it may
// depend on neither: no Electron, no Node built-ins, no React, no code of the
// three contexts — only `@routeswitch/shared` and the types of `rs.d.ts`.
const I18N_RESTRICTIONS = [
  {
    regex: '^(?:electron|react|react-dom)(?:/|$)',
    message: 'src/i18n is shared by main and renderer: no Electron, no React.',
  },
  {
    regex: `^(?:node:|(?:${BARE_NODE_BUILTINS.join('|')})(?:/|$))`,
    message: 'src/i18n is shared by main and renderer: no Node built-ins.',
  },
  {
    regex: '^(?:\\.\\./)+(?:src/)?(?:main|preload)(?:/|$)',
    message: 'src/i18n is shared by main and renderer: it must not import main or preload code.',
  },
  {
    regex: '^(?:\\.\\./)+(?:src/)?renderer/(?!src/rs$)',
    message: 'src/i18n may take only the types of renderer/src/rs.d.ts from the renderer.',
  },
];

// Neither the DOM nor Node exists on both sides.
const I18N_GLOBALS = ['window', 'document', 'navigator', 'localStorage', 'process', 'Buffer', 'require', '__dirname', 'global'].map(
  (name) => ({ name, message: 'src/i18n runs in the main process and the renderer alike: no DOM or Node globals.' }),
);

const CHILD_PROCESS_SOURCE = '/^(node:)?child_process$/';

// `no-restricted-syntax` does not merge across config objects either.
const NO_SHELL_SYNTAX = [
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
];

// Every class that carries a webContents with its own webPreferences.
const WINDOW_CLASSES = '/^(?:BrowserWindow|BaseWindow|WebContentsView|BrowserView)$/';

const BROWSER_WINDOW_SYNTAX = [
  {
    selector: `NewExpression:matches([callee.name=${WINDOW_CLASSES}], [callee.property.name=${WINDOW_CLASSES}])`,
    message: 'Windows are created only by createWindowFactory() in packages/app/src/main/windows.ts.',
  },
];

// The static-import restrictions above do not see `import()` or `require()`.
// `\\u002f` is a slash: esquery ends a regex at the first literal one.
const RENDERER_FORBIDDEN_SOURCE = `/^(?:electron|node:.*|${BARE_NODE_BUILTINS.filter((name) => !name.includes('/')).join('|')})(?:\\u002f.*)?$/`;

const RENDERER_SYNTAX = [
  {
    selector: `ImportExpression[source.value=${RENDERER_FORBIDDEN_SOURCE}]`,
    message: 'The renderer must not import electron or Node built-ins. Use the API the preload exposes.',
  },
  {
    selector: 'CallExpression[callee.name="require"]',
    message: 'The renderer has no require(). Use ES imports, and the API the preload exposes.',
  },
];

const appConfigs = [
  {
    name: 'routeswitch/app/single-window-factory',
    files: [`packages/app/**/${SOURCE_FILES}`],
    ignores: ['packages/app/src/main/windows.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_SHELL_SYNTAX, ...BROWSER_WINDOW_SYNTAX],
    },
  },
  {
    name: 'routeswitch/app/renderer',
    files: [`packages/app/src/renderer/**/${SOURCE_FILES}`],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-restricted-syntax': ['error', ...NO_SHELL_SYNTAX, ...BROWSER_WINDOW_SYNTAX, ...RENDERER_SYNTAX],
      'no-restricted-imports': restrictedImports(forbiddenPackagesFor('app'), RENDERER_RESTRICTIONS),
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    name: 'routeswitch/app/i18n',
    files: [`packages/app/src/i18n/**/${SOURCE_FILES}`],
    rules: {
      'no-restricted-imports': restrictedImports(forbiddenPackagesFor('app'), I18N_RESTRICTIONS),
      'no-restricted-globals': ['error', ...I18N_GLOBALS],
      'no-restricted-syntax': ['error', ...NO_SHELL_SYNTAX, ...BROWSER_WINDOW_SYNTAX, ...RENDERER_SYNTAX],
    },
  },
  {
    name: 'routeswitch/app/preload',
    files: [`packages/app/src/preload/**/${SOURCE_FILES}`],
    rules: {
      'no-restricted-imports': restrictedImports(forbiddenPackagesFor('app'), PRELOAD_RESTRICTIONS),
    },
  },
];

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
      'no-restricted-syntax': ['error', ...NO_SHELL_SYNTAX],
    },
  },
  ...boundaryConfigs,
  ...appConfigs,
);
