export type BuildDetails = {
  version: string
  commit: string
  builtAt: string
}

export type BrowserDetails = {
  runtime: string
  userAgent: string
  appVersion: string
  platform: string
  mobile: string
  language: string
  timezone: string
  screen: string
  viewport: string
  online: string
  secureContext: string
  capabilities: string
}

export type DiagnosticSection = {
  title: string
  items: { label: string; value: string }[]
}

export const createDiagnosticSections = (
  build: BuildDetails,
  browser: BrowserDetails,
): DiagnosticSection[] => {
  const builtAt = new Date(build.builtAt)
  const localBuiltAt = new Intl.DateTimeFormat(browser.language || undefined, {
    dateStyle: 'medium',
    timeStyle: 'long',
    timeZone: browser.timezone && browser.timezone !== 'Unavailable' ? browser.timezone : undefined,
  }).format(builtAt)

  return [
    {
      title: 'Constellation build',
      items: [
        { label: 'Version', value: build.version },
        { label: 'Commit', value: build.commit },
        { label: 'Built (UTC)', value: builtAt.toISOString() },
        { label: 'Built (local)', value: localBuiltAt },
      ],
    },
    {
      title: 'Browser environment',
      items: [
        { label: 'Runtime', value: browser.runtime },
        { label: 'User agent', value: browser.userAgent },
        { label: 'App version', value: browser.appVersion },
        { label: 'Platform', value: browser.platform },
        { label: 'Mobile device', value: browser.mobile },
        { label: 'Language', value: browser.language },
        { label: 'Time zone', value: browser.timezone },
        { label: 'Screen', value: browser.screen },
        { label: 'Viewport', value: browser.viewport },
        { label: 'Network', value: browser.online },
        { label: 'Secure context', value: browser.secureContext },
        { label: 'Capabilities', value: browser.capabilities },
      ],
    },
  ]
}

export const formatDiagnosticReport = (sections: DiagnosticSection[]): string =>
  sections
    .flatMap(({ title, items }) => [
      title,
      ...items.map(({ label, value }) => `${label}: ${value}`),
    ])
    .join('\n')
