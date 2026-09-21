export const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const base64UrlToBytes = (value: string): Uint8Array => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const textToBase64Url = (value: string): string =>
  bytesToBase64Url(new TextEncoder().encode(value));

export const base64UrlToText = (value: string): string =>
  new TextDecoder().decode(base64UrlToBytes(value));
