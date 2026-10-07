import QRCode from 'qrcode'

// Integer pixels per module preserve sharp edges; CSS controls the display size.
export const createShareQr = (url: string): Promise<string> =>
  QRCode.toDataURL(url, { scale: 8, margin: 4, errorCorrectionLevel: 'M' })
