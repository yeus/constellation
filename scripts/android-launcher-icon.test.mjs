import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const res = 'src-tauri/gen/android/app/src/main/res'
const launcher = fs.readFileSync(`${res}/mipmap-anydpi-v26/ic_launcher.xml`, 'utf8')

test('Android launcher separates the background and the maskable foreground', () => {
  const background = fs.readFileSync(`${res}/values/ic_launcher_background.xml`, 'utf8')
  const foreground = fs.readFileSync(`${res}/drawable/ic_launcher_constellation.xml`, 'utf8')
  assert.match(launcher, /<adaptive-icon/)
  assert.match(launcher, /@drawable\/ic_launcher_constellation/)
  assert.match(launcher, /@color\/ic_launcher_background/)
  assert.match(background, /#2a3548/i)
  assert.match(foreground, /android:viewportWidth="108"/)
  assert.match(foreground, /android:viewportHeight="108"/)
  assert.match(foreground, /#f78f3b/i)
  assert.doesNotMatch(foreground, /#2a3548/i)
})

test('Android foreground details remain inside the circular safe zone', () => {
  const foreground = fs.readFileSync(`${res}/drawable/ic_launcher_constellation.xml`, 'utf8')
  const paths = [...foreground.matchAll(/<path([\s\S]*?)\/>/g)].map((match) => match[1])
  assert.equal(paths.length, 5, 'central star, white center and three satellite stars')
  for (const attributes of paths) {
    const path = attributes.match(/android:pathData="([^"]+)"/)?.[1]
    assert.ok(path, 'each path must expose its geometry to this check')
    const coordinates = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]))
    const stroke = Number(attributes.match(/android:strokeWidth="([^"]+)"/)?.[1] ?? 0)
    assert.equal(coordinates.length % 2, 0, 'path coordinates must come in pairs')
    for (let i = 0; i < coordinates.length; i += 2) {
      const x = coordinates[i]
      const y = coordinates[i + 1]
      assert.ok(
        Math.hypot(x - 54, y - 54) + stroke / 2 <= 32,
        `foreground point (${x}, ${y}) exceeds the 32dp safe radius`,
      )
    }
  }
})
