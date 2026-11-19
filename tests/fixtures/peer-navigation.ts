import { expect, type Page, type Locator } from '@playwright/test'

export const openPeerList = async (page: Page) => {
  const peerList = page.locator('.peer-list')
  await page.locator('.dock-peers').waitFor({ state: 'visible' })
  // Returning to a source page can show the general privacy introduction again.
  // This is NOT the per-invitation link consent dialog, which tests must still affirm.
  const privacyIntro = page.getByRole('region', { name: 'Privacy introduction' })
  if (await privacyIntro.isVisible())
    await privacyIntro.getByRole('button', { name: 'Got it' }).click()
  if (!(await peerList.isVisible())) await page.locator('.dock-peers').click()
  return peerList
}

export const openPeerFilter = async (
  page: Page,
  filter: 'All' | 'Sharing' | 'Viewing' | 'Both',
) => {
  const peerList = await openPeerList(page)
  await openPeerFilterMenu(page)
  await peerList.getByRole('button', { name: filter, exact: true }).click()
  return peerList
}

export const openShareCreator = async (page: Page): Promise<void> => {
  const peerList = await openPeerList(page)
  await peerList.getByRole('button', { name: 'Share location' }).click()
}

// Inject a test clipboard without granting unrelated location permissions to the viewer.
export const setTestClipboardText = async (page: Page, text: string): Promise<void> => {
  await page.evaluate((value) => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => value },
    })
  }, text)
}

export const pasteLocationLink = async (page: Page, url: string): Promise<void> => {
  await setTestClipboardText(page, url)
  await page
    .getByRole('dialog', { name: 'Follow a location' })
    .getByRole('button', { name: 'Paste link' })
    .click()
}

export const continueInBrowserIfOffered = async (page: Page): Promise<void> => {
  const intro = page.getByRole('dialog', { name: 'Location link introduction' })
  await intro.getByRole('button', { name: 'See location' }).click({ timeout: 30_000 })
}
export const openIncomingLink = async (page: Page, url: string): Promise<void> => {
  await page.goto(url)
  await continueInBrowserIfOffered(page)
}
// Preserve the actual, redacted connection error when an explicitly consented link fails.
// Never retry the invitation or bypass its separate approval/comparison requirements.
export const expectLocationPreviewReady = async (page: Page): Promise<void> => {
  const addPeer = page
    .getByRole('region', { name: 'Location preview' })
    .getByRole('button', { name: 'Add peer' })
  try {
    await expect(addPeer).toBeVisible({ timeout: 30_000 })
  } catch (error) {
    const retryDialog = page.getByRole('dialog', { name: 'Location link introduction' })
    const failed = await retryDialog.isVisible()
    const diagnostic = failed
      ? (
          await retryDialog
            .getByRole('alert')
            .textContent()
            .catch(() => null)
        )?.trim()
      : undefined
    throw new Error(
      `Consented location preview unavailable: ${failed ? `invitation failed (${diagnostic ?? 'no reason reported'})` : 'no preview or retry dialog'}`,
      { cause: error },
    )
  }
}

export const saveLocationPreview = async (page: Page): Promise<void> => {
  const preview = page.getByRole('region', { name: 'Location preview' })
  await preview.getByRole('button', { name: 'Add peer' }).click({ timeout: 30_000 })
  const saved = page.getByRole('region', { name: 'Peer added' })
  if (await saved.count()) await saved.getByRole('button', { name: 'Not now' }).click()
}

export const openPeerFilterMenu = async (page: Page): Promise<void> => {
  const list = await openPeerList(page)
  const menu = list.locator('.peer-list__filter-menu')
  if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open)))
    await menu.locator('summary').click()
}

export const expandPeerDetails = async (peer: Locator): Promise<void> => {
  if (!(await peer.evaluate((element) => (element as HTMLDetailsElement).open)))
    await peer.locator('.peer-list__summary').click()
  const sections = peer.locator('.peer-list__section')
  for (let index = 0; index < (await sections.count()); index += 1) {
    const section = sections.nth(index)
    if (!(await section.evaluate((element) => (element as HTMLDetailsElement).open)))
      await section.locator(':scope > summary').click()
  }
}
