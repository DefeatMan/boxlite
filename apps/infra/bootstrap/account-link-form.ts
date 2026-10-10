// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bootstrapRoot = dirname(fileURLToPath(import.meta.url))

/**
 * The account link Form with its custom fields' code read in: each CUSTOM
 * component names a file in `auth0/account-link-form/`, and the page's styles
 * fill the placeholder in the field that adds them.
 */
export function loadAccountLinkForm() {
  const directory = join(bootstrapRoot, 'auth0', 'account-link-form')
  const form = JSON.parse(readFileSync(join(bootstrapRoot, 'auth0', 'account-link-form.json'), 'utf8'))
  const styles = JSON.stringify(readFileSync(join(directory, 'link-form.css'), 'utf8'))
  for (const node of form.nodes) {
    for (const component of node.config?.components ?? []) {
      if (component.type !== 'CUSTOM') continue
      component.config.code = readFileSync(join(directory, component.config.code), 'utf8').replace(
        '__LINK_FORM_CSS_JSON__',
        () => styles,
      )
    }
  }
  return form
}
