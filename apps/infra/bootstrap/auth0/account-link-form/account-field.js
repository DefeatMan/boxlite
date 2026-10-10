// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

// Auth0 Forms custom field for the account link Form: the address being
// linked, greyed out and not editable, the way the login page shows an
// identifier it will not let you change. It also adds the page's styles as a
// style element, which reaches every component on the page; the custom field's
// own CSS setting is not documented to.
function linkAccountField(context) {
  const input = document.createElement('input')
  input.type = 'email'
  input.disabled = true
  input.className = 'bl-link-account'

  function addStyles() {
    if (document.getElementById('bl-link-styles')) return
    const style = document.createElement('style')
    style.id = 'bl-link-styles'
    style.textContent = __LINK_FORM_CSS_JSON__
    document.head.appendChild(style)
  }

  // The address and the mode arrive as params, `{{vars.address}}` and
  // `{{vars.mode}}` resolved from the Action's render. Forms throws until it
  // has resolved the params, and calls update() once it has.
  function showParams() {
    let params
    try {
      params = context.custom.getParams()
    } catch {
      return
    }
    const address = params?.address
    input.value = typeof address === 'string' && !address.includes('{{') ? address : ''
    // In code mode the page asks for no password: its field stays, hidden.
    document.documentElement.classList.toggle('bl-link-code', params?.mode === 'code')
  }

  return {
    init() {
      addStyles()
      showParams()
      return input
    },
    update() {
      showParams()
    },
    getValue() {
      return input.value
    },
  }
}
