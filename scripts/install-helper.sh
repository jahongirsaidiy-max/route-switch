#!/bin/bash
#
# Installs or updates the RouteSwitch helper daemon.
#
#   sudo /bin/bash install-helper.sh <resources_dir>
#
# <resources_dir> holds `com.routeswitch.helper` (the binary, `npm run build:helper`)
# and `com.routeswitch.helper.plist` (packages/helper/launchd). The app runs this
# script once as root through sudo-prompt; an update runs it again.
#
# Idempotent: every run puts the same files with the same owner and mode in
# place, stops the helper that runs (its SIGTERM cleanup removes its routes)
# and starts the new one, which applies the kept config.json again.
# config.json and state.json are never touched here.
#
# Nothing is replaced until the new binary has answered `--version` and the
# new plist passed `plutil -lint`, so a broken package leaves the running
# helper as it was.

# `loaded` and `running` are predicates, only ever used as conditions (where set -e is off by design).
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
readonly LOG_DIR='/Library/Logs/RouteSwitch'
readonly LOG_FILE='/Library/Logs/RouteSwitch/helper.log'
readonly SOCKET='/var/run/routeswitch.sock'
readonly NEWSYSLOG_CONF='/etc/newsyslog.d/com.routeswitch.helper.conf'
# SHUTDOWN_EXIT_TIMEOUT_SEC of packages/helper/src/main.ts (the plist's ExitTimeOut), plus a margin.
readonly HELPER_EXIT_TIMEOUT_SEC=60
readonly STOP_WAIT_SEC=$((HELPER_EXIT_TIMEOUT_SEC + 10))
# How long the new helper gets to be running with its socket in place.
readonly START_WAIT_SEC=20
readonly SERVICE="system/${LABEL}"

say() { printf 'install-helper: %s\n' "$*"; }
die() {
  printf 'install-helper: error: %s\n' "$*" >&2
  exit 1
}

# Test mode: ROUTESWITCH_TEST_ROOT (an existing absolute directory) is put in
# front of every path, and the commands come from the caller's PATH (the
# tests put stubs of launchctl, chown and sleep there). It is refused as root,
# so a privileged run can never be pointed elsewhere.
ROOT=''
if [[ -n "${ROUTESWITCH_TEST_ROOT:-}" ]]; then
  [[ "${EUID}" -ne 0 ]] || die 'ROUTESWITCH_TEST_ROOT is for tests and is refused when running as root'
  [[ "${ROUTESWITCH_TEST_ROOT}" == /* && -d "${ROUTESWITCH_TEST_ROOT}" && ! -L "${ROUTESWITCH_TEST_ROOT}" ]] ||
    die 'ROUTESWITCH_TEST_ROOT must be an existing absolute directory'
  ROOT="${ROUTESWITCH_TEST_ROOT}"
else
  [[ "${EUID}" -eq 0 ]] || die 'must run as root: sudo /bin/bash install-helper.sh <resources_dir>'
  PATH='/usr/bin:/bin:/usr/sbin:/sbin'
  export PATH
fi

usage() {
  printf 'Usage: sudo /bin/bash install-helper.sh <resources_dir>\n' >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
SRC="$1"
[[ "${SRC}" == /* ]] || die 'the resources directory must be an absolute path'
[[ -d "${SRC}" ]] || die "not a directory: ${SRC}"
readonly SRC_BINARY="${SRC}/${LABEL}"
readonly SRC_PLIST="${SRC}/${LABEL}.plist"
for source_file in "${SRC_BINARY}" "${SRC_PLIST}"; do
  [[ -f "${source_file}" && ! -L "${source_file}" ]] || die "missing or not a regular file: ${source_file}"
done

readonly DEST_BINARY="${ROOT}${HELPER_BINARY}"
readonly DEST_PLIST="${ROOT}${LAUNCH_DAEMON_PLIST}"
readonly DEST_NEWSYSLOG="${ROOT}${NEWSYSLOG_CONF}"

# Temporary files of this run, next to their destinations (same volume: the
# final `mv` is a rename). Removed on any exit that did not move them.
TMP_BINARY=''
TMP_PLIST=''
TMP_NEWSYSLOG=''
remove_temporaries() {
  local file
  for file in "${TMP_BINARY}" "${TMP_PLIST}" "${TMP_NEWSYSLOG}"; do
    if [[ -n "${file}" && -f "${file}" ]]; then rm -f -- "${file}"; fi
  done
}
trap remove_temporaries EXIT

# A directory of ours: created when missing, root:wheel 0755 either way.
own_dir() {
  local dir="$1"
  [[ ! -L "${dir}" ]] || die "refusing a symbolic link: ${dir}"
  mkdir -p -- "${dir}"
  chown root:wheel "${dir}"
  chmod 0755 "${dir}"
}

# A system directory (/Library/LaunchDaemons, /etc/newsyslog.d): created only when missing, never changed.
system_dir() {
  local dir="$1"
  [[ ! -L "${dir}" ]] || die "refusing a symbolic link: ${dir}"
  if [[ ! -d "${dir}" ]]; then
    mkdir -p -- "${dir}"
    chown root:wheel "${dir}"
    chmod 0755 "${dir}"
  fi
}

# The temporary name of a destination: next to it, hidden, ours by name.
temporary_of() { printf '%s/.%s.install.%s' "${1%/*}" "${1##*/}" "$$"; }

# Copies $1 to the temporary file $2 (destination $3), root:wheel, mode $4,
# without extended attributes (a quarantine flag copied out of a downloaded
# app would stop launchd from running the binary).
stage_file() {
  local src="$1" tmp="$2" dest="$3" mode="$4"
  [[ ! -L "${dest}" ]] || die "refusing a symbolic link: ${dest}"
  rm -f -- "${tmp}"
  cp -- "${src}" "${tmp}"
  xattr -c "${tmp}"
  chown root:wheel "${tmp}"
  chmod "${mode}" "${tmp}"
}

loaded() { launchctl print "${SERVICE}" >/dev/null 2>&1; }

running() {
  local info
  info="$(launchctl print "${SERVICE}" 2>/dev/null)" || return 1
  [[ "${info}" == *"state = running"* ]]
}

# Boots the running helper out and waits until launchd has let it go: bootout
# may return while the helper still removes its routes (up to ExitTimeOut).
stop_helper() {
  local waited=0 status=0
  loaded || return 0
  say 'stopping the running helper (it removes its routes first)'
  launchctl bootout "${SERVICE}" || status=$?
  while loaded; do
    [[ "${waited}" -lt "${STOP_WAIT_SEC}" ]] ||
      die "the helper did not stop within ${STOP_WAIT_SEC} s (launchctl bootout exit ${status})"
    sleep 1
    waited=$((waited + 1))
  done
}

start_helper() {
  local attempt=1
  # A service the user disabled cannot be bootstrapped; installing it means wanting it enabled.
  launchctl enable "${SERVICE}"
  # Right after a bootout, launchd may still refuse the label for a moment.
  until launchctl bootstrap system "${DEST_PLIST}"; do
    [[ "${attempt}" -lt 5 ]] || die 'launchctl bootstrap failed'
    sleep 1
    attempt=$((attempt + 1))
  done
}

wait_until_running() {
  local waited=0
  until running && [[ -S "${ROOT}${SOCKET}" ]]; do
    [[ "${waited}" -lt "${START_WAIT_SEC}" ]] ||
      die "the helper is not running with its socket after ${START_WAIT_SEC} s; see ${LOG_FILE} and: launchctl print ${SERVICE}"
    sleep 1
    waited=$((waited + 1))
  done
}

say "installing from ${SRC}"
own_dir "${ROOT}${HELPER_BINARY%/*}"
system_dir "${ROOT}${LAUNCH_DAEMON_PLIST%/*}"
system_dir "${ROOT}${NEWSYSLOG_CONF%/*}"
own_dir "${ROOT}${SUPPORT_DIR}"
own_dir "${ROOT}${LOG_DIR}"

TMP_BINARY="$(temporary_of "${DEST_BINARY}")"
stage_file "${SRC_BINARY}" "${TMP_BINARY}" "${DEST_BINARY}" 0755
TMP_PLIST="$(temporary_of "${DEST_PLIST}")"
stage_file "${SRC_PLIST}" "${TMP_PLIST}" "${DEST_PLIST}" 0644

# Check the new files before anything that runs is touched.
version="$("${TMP_BINARY}" --version)" || die "the new helper binary does not run: ${SRC_BINARY}"
plutil -lint -s "${TMP_PLIST}" || die "the new plist is not valid: ${SRC_PLIST}"

# Log rotation by the system's newsyslog: 5 archives of up to 5 MiB, bzip2, no
# signal (the helper opens the log for every line). Ours by the marker line.
TMP_NEWSYSLOG="$(temporary_of "${DEST_NEWSYSLOG}")"
[[ ! -L "${DEST_NEWSYSLOG}" ]] || die "refusing a symbolic link: ${DEST_NEWSYSLOG}"
rm -f -- "${TMP_NEWSYSLOG}"
cat >"${TMP_NEWSYSLOG}" <<EOF
# managed-by: routeswitch (install-helper.sh): rotation of the RouteSwitch helper log
# logfilename                          [owner:group]  mode  count  size(KB)  when  flags
${LOG_FILE}   root:wheel     644   5      5120      *     JN
EOF
chown root:wheel "${TMP_NEWSYSLOG}"
chmod 0644 "${TMP_NEWSYSLOG}"

# Renames: a running helper keeps its old binary until it is stopped.
mv -f -- "${TMP_BINARY}" "${DEST_BINARY}"
TMP_BINARY=''
mv -f -- "${TMP_PLIST}" "${DEST_PLIST}"
TMP_PLIST=''
mv -f -- "${TMP_NEWSYSLOG}" "${DEST_NEWSYSLOG}"
TMP_NEWSYSLOG=''
say "installed helper ${version}: ${HELPER_BINARY}, ${LAUNCH_DAEMON_PLIST}, ${NEWSYSLOG_CONF}"

stop_helper
start_helper
wait_until_running
say "the helper is running (${SERVICE}); socket ${SOCKET}"
