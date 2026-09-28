export const redactAndroidTestError = (message) =>
  message.replace(/#share=[A-Za-z0-9_-]+/g, '#share=<redacted>')
