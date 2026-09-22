export const firstAllowedDeepLink = (
  candidates: readonly string[],
  publicShareBaseUrl: string,
): string | undefined => {
  const allowed = new URL(publicShareBaseUrl);
  return candidates.find((candidate) => {
    try {
      const url = new URL(candidate);
      return (
        url.origin === allowed.origin &&
        url.pathname === allowed.pathname &&
        url.hash.length > 1
      );
    } catch {
      return false;
    }
  });
};

export const subscribeTauriDeepLinks = async (
  publicShareBaseUrl: string,
  receive: (url: string) => void,
): Promise<() => void> => {
  if (!("__TAURI_INTERNALS__" in window)) return () => undefined;
  const { getCurrent, onOpenUrl } = await import(
    "@tauri-apps/plugin-deep-link"
  );
  const receiveAllowed = (urls: readonly string[]): void => {
    const url = firstAllowedDeepLink(urls, publicShareBaseUrl);
    if (url) receive(url);
  };
  const current = await getCurrent();
  if (current) receiveAllowed(current);
  return onOpenUrl(receiveAllowed);
};
