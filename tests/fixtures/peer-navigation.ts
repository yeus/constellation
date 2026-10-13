import type { Page, Locator } from '@playwright/test'

export const openPeerList = async (page: Page) => {
  const peerList = page.locator('.peer-list')
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

export const saveLocationPreview = async (page: Page): Promise<void> => {
  const preview = page.getByRole('region', { name: 'Location preview' })
  await preview.getByRole('button', { name: 'Keep following' }).click()
  await page
    .getByRole('dialog', { name: 'Keep following' })
    .getByRole('button', { name: 'Save location' })
    .click()
  const shareBack = page.getByRole('region', { name: 'Share back invitation' })
  if (await shareBack.count()) await shareBack.getByRole('button', { name: 'Not now' }).click()
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
  const details = peer.locator('.peer-list__advanced')
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open)))
    await details.locator('summary').first().click()
}
