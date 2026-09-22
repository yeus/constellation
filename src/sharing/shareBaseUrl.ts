export const resolveShareBaseUrl = (
  configuredUrl: string | undefined,
  currentUrl: URL,
): string => {
  if (configuredUrl) {
    const configured = new URL(configuredUrl);
    configured.search = "";
    configured.hash = "";
    return configured.toString();
  }
  return `${currentUrl.origin}${currentUrl.pathname}`;
};
