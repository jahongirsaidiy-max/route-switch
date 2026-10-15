/** `-psn_<high>_<low>`, exactly: what LaunchServices passes, nothing that could carry a value. */
const PROCESS_SERIAL_NUMBER = /^-psn_\d+_\d+$/;

/**
 * The packaged app takes no command-line arguments (TASK-301). Chromium and Node read their
 * switches from argv (`--remote-debugging-port`, `--log-net-log`, `--proxy-server`,
 * `--host-resolver-rules`, …); fuses only close the Node ones. Launched from Finder, the
 * Dock, login items or `open`, the app gets no argument at all, so any argument means
 * someone is starting it by hand: refuse to start. The one exception is the process serial
 * number LaunchServices may add (`-psn_0_12345`, e.g. on the first Open of a quarantined app).
 *
 * Pure function, no Electron import: tests/packaging.test.ts checks it.
 *
 * @param {readonly string[]} argv `process.argv` of the main process.
 * @returns {string[]} What to report for each refused argument: a switch's name (never its
 *   value), or `<argument>` for anything else (never the text itself). Empty when clean.
 */
export const forbiddenArguments = (argv) =>
  argv
    .slice(1)
    .filter((arg) => !PROCESS_SERIAL_NUMBER.test(arg))
    .map((arg) => (arg.startsWith('-') ? (arg.split('=')[0] ?? arg) : '<argument>'));
