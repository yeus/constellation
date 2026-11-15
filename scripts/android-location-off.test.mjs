import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (path) => fs.readFileSync(path, 'utf8')
const plugin = read(
  'src-tauri/plugins/constellation-android/android/src/main/java/space/taskyon/constellation/plugin/ConstellationAndroidPlugin.kt',
)
const service = read(
  'src-tauri/plugins/constellation-android/android/src/main/java/space/taskyon/constellation/plugin/LocationShareService.kt',
)
const view = read('src/views/MapView.vue')

test('Android never opens system settings as a side effect of attempting a share', () => {
  const requireLocation = plugin
    .split('private fun requireLocationPermission(')[1]
    ?.split('private fun requireNotificationPermission(')[0]
  assert.ok(requireLocation)
  assert.doesNotMatch(requireLocation, /activity\.startActivity/)
  assert.match(requireLocation, /Location services are switched off|Device location is turned off/)
})

test('saving sharing preferences with Location switched off never starts a location foreground service', () => {
  assert.match(
    plugin,
    /if \(!locationManager\.isLocationEnabled \|\| locationGrant\(activity\) == "none"\)/,
  )
  assert.match(
    service,
    /locationGrant\(this\) != "none" &&[\s\S]{0,120}(?:isLocationEnabled|availableLocationProviders)/,
  )
  assert.doesNotMatch(
    plugin.split('fun setSharingBehavior(invoke: Invoke)')[1]?.split('@Command')[0] ?? '',
    /servicesEnabled"\)\.all/,
  )
})

test('Android exposes explicit Location-off recovery instead of background-launching Settings', () => {
  assert.match(view, /Device location is off/)
  assert.match(view, /Open Android location settings/)
})
