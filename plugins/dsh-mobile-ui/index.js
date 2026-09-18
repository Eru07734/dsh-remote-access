/**
 * dsh-mobile-ui — local plugin (our own code, no third-party package).
 *
 * Why: the Settings dialog ships as a fixed desktop two-pane layout. Measured
 * at a 412x915 phone viewport (headless Edge + CDP), before this stylesheet:
 *
 *   [role=dialog][aria-modal]   364x800 at (24,58), flex-direction: row
 *     ├── nav                   188px wide  (section list)
 *     └── div (content)         176px wide  ← header + a 2023px-tall options
 *                                              pane scrolled inside 738px
 *
 * With a 176px content pane every label wraps to one character per line and 32
 * elements overflow the viewport bottom, so the settings are effectively
 * unreadable on a phone.
 *
 * What this does: contributes one `style` row to the webserver's structured
 * index-injection table (the same mechanism first-party plugins use; see
 * dsh-host-webserver's `renderRow`, kind `style` → <style> in <head>). The CSS
 * is scoped to `max-width: 820px`, so desktop rendering is untouched.
 *
 * Selectors are STRUCTURAL on purpose: the shipped class names are build
 * hashes (e.g. `VOzbGW_nav`) that change on every frontend rebuild, while the
 * `role=dialog[aria-modal]` → `nav` + content-child structure is the actual
 * contract this layout relies on.
 *
 * Deleting this row from the profile's cordis.patch.yml restores stock layout.
 */

/** Stable Cordis plugin name. */
const name = 'mobile-ui'

/** The row must land in the webserver's injection table. */
const inject = ['webServer']

/** Narrow-viewport layout for the modal dialogs (currently the Settings panel). */
const MOBILE_CSS = `@media (max-width: 820px) {
  /* Panel takes the whole screen instead of a 364x800 box centred in it. */
  [role="dialog"][aria-modal="true"] {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100dvh;
    max-width: none;
    max-height: none;
    border-radius: 0;
    flex-direction: column;
  }

  /* Section list moves to a full-width, horizontally scrollable tab strip. */
  [role="dialog"][aria-modal="true"] > nav {
    width: 100%;
    flex: none;
    padding: 8px 12px 4px;
  }
  [role="dialog"][aria-modal="true"] > nav > div:last-child {
    flex-direction: row;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    gap: 4px;
    -webkit-overflow-scrolling: touch;
  }

  /* Content pane reclaims the full width and the remaining height. */
  [role="dialog"][aria-modal="true"] > div:last-child {
    flex: 1;
    min-height: 0;
    min-width: 0;
    width: 100%;
  }
  [role="dialog"][aria-modal="true"] > div:last-child > div:last-child {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  /* Comfortable touch targets and no accidental text-size inflation. */
  [role="dialog"][aria-modal="true"] input,
  [role="dialog"][aria-modal="true"] select,
  [role="dialog"][aria-modal="true"] textarea {
    font-size: 16px;
  }
}`

/**
 * Contribute the stylesheet into the webserver's index injection table.
 * @param ctx - plugin context; `inject: ['webServer']` guarantees the service.
 */
function apply(ctx) {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'style', text: MOBILE_CSS })
  })
}

export { MOBILE_CSS, apply, inject, name }
