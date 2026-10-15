#!/bin/bash
#
# Removes the RouteSwitch helper daemon and every file it or install-helper.sh put on the system.
#
#   sudo /bin/bash uninstall.sh [--force]
#
# Order:
# 1. `com.routeswitch.helper --uninstall`: the running helper removes every
#    route and managed /etc/resolver file it applied and confirms it (at most
#    60 s); when no helper runs, the binary cleans up after the last run itself
#    (routes of state.json, managed resolver files).
#    If that fails, nothing is removed and the script stops: state.json still
#    lists the routes, so running it again can finish the job. `--force` goes
#    on anyway (leftover routes vanish at the next restart of the Mac; leftover
#    resolver files are the ones holding the `# managed-by: routeswitch` line).
# 2. `launchctl bootout`, and wait until launchd has let the helper go.
# 3. Remove the files: plist, binary, newsyslog file, config.json, state.json,
#    the log and its rotated copies, the socket, then the two directories when
#    empty. Only files of ours, by exact name; never a recursive delete. A
#    directory that still holds something else is left in place, with a warning.
#
# Idempotent: what is already gone is skipped, so it can run again; on a
# clean system it changes nothing and exits 0.

# `loaded` is a predicate, only ever used as a condition (where set -e is off by design).
# shellcheck disable=SC2310
set -euo pipefail
umask 022
# The helper binary is Node: it must not take options from the caller's environment (sudo-prompt, a shell).
unset NODE_OPTIONS

# Paths: equal to PATHS in packages/shared/src/paths.ts; tests/helper-install.test.ts compares them.
readonly LABEL='com.routeswitch.helper'
readonly HELPER_BINARY='/Library/PrivilegedHelperTools/com.routeswitch.helper'
readonly LAUNCH_DAEMON_PLIST='/Library/LaunchDaemons/com.routeswitch.helper.plist'
readonly SUPPORT_DIR='/Library/Application Support/RouteSwitch'
readonly CONFIG_FILE='/Library/Application Support/RouteSwitch/config.json'
readonly STATE_FILE='/Library/Application Support/RouteSwitch/state.json'
readonly LOG_DIR='/Library/Logs/RouteSwitch'
readonly LOG_FILE='/Library/Logs/RouteSwitch/helper.log'
readonly SOCKET='/var/run/routeswitch.sock'
readonly NEWSYSLOG_CONF='/etc/newsyslog.d/com.routeswitch.helper.conf'
# SHUTDOWN_EXIT_TIMEOUT_SEC of packages/helper/src/main.ts (the plist's ExitTimeOut), plus a margin.
readonly HELPER_EXIT_TIMEOUT_SEC=60
readonly STOP_WAIT_SEC=$((HELPER_EXIT_TIMEOUT_SEC + 10))
readonly SERVICE="system/${LABEL}"

say() { printf 'uninstall: %s\n' "$*"; }
warn() { printf 'uninstall: warning: %s\n' "$*" >&2; }
die() {
  printf 'uninstall: error: %s\n' "$*" >&2
  exit 1
}

# Test mode: as in install-helper.sh. ROUTESWITCH_TEST_ROOT is put in front of
# every path and the commands come from the caller's PATH; refused as root.
ROOT=''
if [[ -n "${ROUTESWITCH_TEST_ROOT:-}" ]]; then
  [[ "${EUID}" -ne 0 ]] || die 'ROUTESWITCH_TEST_ROOT is for tests and is refused when running as root'
  [[ "${ROUTESWITCH_TEST_ROOT}" == /* && -d "${ROUTESWITCH_TEST_ROOT}" && ! -L "${ROUTESWITCH_TEST_ROOT}" ]] ||
    die 'ROUTESWITCH_TEST_ROOT must be an existing absolute directory'
  ROOT="${ROUTESWITCH_TEST_ROOT}"
else
  [[ "${EUID}" -eq 0 ]] || die 'must run as root: sudo /bin/bash uninstall.sh [--force]'
  PATH='/usr/bin:/bin:/usr/sbin:/sbin'
  export PATH
fi

FORCE=0
if [[ $# -eq 1 && "$1" == '--force' ]]; then
  FORCE=1
elif [[ $# -ne 0 ]]; then
  printf 'Usage: sudo /bin/bash uninstall.sh [--force]\n' >&2
  exit 2
fi

readonly BINARY="${ROOT}${HELPER_BINARY}"

loaded() { launchctl print "${SERVICE}" >/dev/null 2>&1; }

# 1. Routes and resolver files, while the helper and state.json are still there.
if [[ -f "${BINARY}" && ! -L "${BINARY}" && -x "${BINARY}" ]]; then
  say 'asking the helper to remove its routes and resolver files'
  if "${BINARY}" --uninstall; then
    say 'routes and resolver files removed'
  else
    status=$?
    if [[ "${FORCE}" -eq 1 ]]; then
      warn "the helper could not confirm the cleanup (exit ${status}); going on because of --force"
    else
      die "the helper could not confirm the cleanup (exit ${status}); nothing was removed. Run this script again, or with --force to remove the files anyway (see ${LOG_FILE})"
    fi
  fi
elif [[ ! -e "${ROOT}${STATE_FILE}" && ! -L "${ROOT}${STATE_FILE}" ]]; then
  # Already uninstalled, or never started: no route of ours is on record.
  say 'no helper binary and no state.json: no route of RouteSwitch is on record'
elif [[ "${FORCE}" -eq 1 ]]; then
  warn "no helper binary at ${HELPER_BINARY}; the routes in ${STATE_FILE} cannot be removed; going on because of --force"
else
  die "no helper binary at ${HELPER_BINARY}, so the routes in ${STATE_FILE} cannot be removed; run with --force to remove the remaining files anyway"
fi

# 2. The daemon. After step 1 its SIGTERM cleanup finds nothing left to remove.
if loaded; then
  say "stopping ${SERVICE}"
  bootout_status=0
  launchctl bootout "${SERVICE}" || bootout_status=$?
  waited=0
  while loaded; do
    [[ "${waited}" -lt "${STOP_WAIT_SEC}" ]] ||
      die "the helper did not stop within ${STOP_WAIT_SEC} s (launchctl bootout exit ${bootout_status}); nothing else was removed"
    sleep 1
    waited=$((waited + 1))
  done
fi

# 3. Files, by exact name.
remove_file() {
  local file="$1"
  # Through a linked directory the name would point somewhere else: never followed.
  if [[ -L "${file%/*}" ]]; then
    warn "left in place (its directory is a symbolic link): ${file}"
    return 0
  fi
  if [[ -e "${file}" || -L "${file}" ]]; then
    [[ ! -d "${file}" || -L "${file}" ]] || die "expected a file, found a directory: ${file}"
    rm -f -- "${file}"
    say "removed ${file}"
  fi
}

# Removes the directory when it is empty; anything else in it is not ours and stays.
remove_dir() {
  local dir="$1"
  if [[ -L "${dir}" ]]; then
    warn "left in place (a symbolic link, not created by RouteSwitch): ${dir}"
  elif [[ -d "${dir}" ]]; then
    if rmdir -- "${dir}" 2>/dev/null; then
      say "removed ${dir}"
    else
      warn "left in place (holds files RouteSwitch did not create): ${dir}"
    fi
  fi
}

# Temporary files our own code leaves behind after a crash (by name).
remove_temporaries() {
  local file
  for file in "$@"; do
    # An unmatched glob stays as the literal pattern: `-e` is false for it.
    if [[ -e "${file}" || -L "${file}" ]]; then remove_file "${file}"; fi
  done
}

remove_file "${ROOT}${LAUNCH_DAEMON_PLIST}"
remove_file "${ROOT}${HELPER_BINARY}"
remove_file "${ROOT}${NEWSYSLOG_CONF}"
remove_temporaries \
  "${ROOT}${LAUNCH_DAEMON_PLIST%/*}/.${LABEL}.plist.install."* \
  "${ROOT}${HELPER_BINARY%/*}/.${LABEL}.install."* \
  "${ROOT}${NEWSYSLOG_CONF%/*}/.${LABEL}.conf.install."*

remove_file "${ROOT}${CONFIG_FILE}"
remove_file "${ROOT}${STATE_FILE}"
remove_temporaries "${ROOT}${SUPPORT_DIR}/.config.json.routeswitch.tmp" "${ROOT}${SUPPORT_DIR}/.state.json.routeswitch.tmp"
remove_dir "${ROOT}${SUPPORT_DIR}"

remove_file "${ROOT}${LOG_FILE}"
# Archives of newsyslog: helper.log.0.bz2, helper.log.1.bz2, ...
remove_temporaries "${ROOT}${LOG_FILE}".[0-9]*
remove_dir "${ROOT}${LOG_DIR}"

# The helper removes its socket when it stops; one left by a killed helper goes here.
for socket_file in "${ROOT}${SOCKET}" "${ROOT}${SOCKET%/*}/.${SOCKET##*/}".*.tmp; do
  if [[ -S "${socket_file}" ]]; then remove_file "${socket_file}"; fi
done

if loaded; then die "${SERVICE} is still loaded"; fi
say 'done: the RouteSwitch helper is uninstalled'
