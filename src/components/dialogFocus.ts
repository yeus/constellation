/** Keep keyboard focus inside the currently active modal. */
export const trapDialogFocus = (event: KeyboardEvent, root: HTMLElement): void => {
  const controls = [
    ...root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
    ),
  ].filter((element) => element.getClientRects().length > 0)
  const first = controls[0]
  const last = controls.at(-1)
  if (!first || !last) return
  const active = root.ownerDocument.activeElement
  if (event.shiftKey && (active === first || active === root)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || active === root)) {
    event.preventDefault()
    first.focus()
  }
}
