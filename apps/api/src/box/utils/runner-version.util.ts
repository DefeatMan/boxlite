/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * First runner release that binds a `readOnly` volume read-only. An older
 * runner drops the field and binds the volume read-write without an error.
 *
 * A runner reports the Cargo version it was built at plus its build ref
 * (`0.10.7+<ref>`), so every runner built between two releases reports the
 * same version whether or not it has this change. The gate therefore stays
 * closed until runners at this version are deployed. If the Cargo version has
 * already moved past 0.10.7 when this lands, raise this to the next release.
 */
export const READ_ONLY_VOLUMES_MIN_RUNNER_VERSION = [0, 10, 8]

/** Whether a runner reporting `appVersion` honours `readOnly` on a volume. */
export function runnerBindsReadOnlyVolumes(appVersion: string | null | undefined): boolean {
  // A pre-release (`-dev`, `-rc1`) or anything unparseable is not trusted.
  const match = /^v?(\d+)\.(\d+)\.(\d+)(\+.*)?$/.exec(appVersion ?? '')
  if (!match) {
    return false
  }
  const version = match.slice(1, 4).map(Number)
  for (let i = 0; i < READ_ONLY_VOLUMES_MIN_RUNNER_VERSION.length; i++) {
    if (version[i] !== READ_ONLY_VOLUMES_MIN_RUNNER_VERSION[i]) {
      return version[i] > READ_ONLY_VOLUMES_MIN_RUNNER_VERSION[i]
    }
  }
  return true
}
