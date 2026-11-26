/** Perceptually spaced, vivid sRGB colors for peer identities (no UI dependencies). */
type Lab = readonly [number, number, number]
type Rgb = readonly [number, number, number]
const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value))
const gamma = (value: number): number =>
  value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055
const linear = (value: number): number =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4

const oklabToLinearRgb = ([L, a, b]: Lab): Rgb => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}
const rgbToLab = ([r, g, b]: Rgb): Lab => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
const toHex = (values: Rgb): string =>
  '#' +
  values
    .map((channel) =>
      Math.round(clamp(gamma(channel)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
const parseHex = (value: string): Rgb | undefined =>
  /^#[\da-f]{6}$/i.test(value)
    ? ([1, 3, 5].map((index) =>
        linear(parseInt(value.slice(index, index + 2), 16) / 255),
      ) as unknown as Rgb)
    : undefined

export const oklabDistance = (left: string, right: string): number => {
  const a = parseHex(left)
  const b = parseHex(right)
  if (!a || !b) return 0
  const p = rgbToLab(a)
  const q = rgbToLab(b)
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}

const vividCandidate = (hueDegrees: number, lightness: number, chroma: number): string => {
  const radians = (hueDegrees * Math.PI) / 180
  const a = Math.cos(radians)
  const b = Math.sin(radians)
  const inGamut = (rgb: Rgb): boolean => rgb.every((channel) => channel >= 0 && channel <= 1)
  let low = 0
  let high = chroma
  // Preserve the selected hue/lightness while mapping out-of-gamut colors into sRGB.
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const mid = (low + high) / 2
    if (inGamut(oklabToLinearRgb([lightness, a * mid, b * mid]))) low = mid
    else high = mid
  }
  return toHex(oklabToLinearRgb([lightness, a * low, b * low]))
}

/** Maximize the least perceptual distance to already-assigned peer colors. */
export const randomVividPeerColor = (
  existingColors: readonly string[],
  random: () => number = Math.random,
): string => {
  const occupied = existingColors.filter((color) => parseHex(color) !== undefined)
  const candidates = occupied.length === 0 ? 1 : 48
  let bestColor = ''
  let bestDistance = -1
  for (let index = 0; index < candidates; index += 1) {
    const hue = random() * 360
    const L = 0.68 + random() * 0.08
    const C = 0.17 + random() * 0.055
    const color = vividCandidate(hue, L, C)
    const nearest = occupied.length
      ? Math.min(...occupied.map((other) => oklabDistance(color, other)))
      : Infinity
    if (nearest > bestDistance) {
      bestColor = color
      bestDistance = nearest
    }
  }
  return bestColor
}
