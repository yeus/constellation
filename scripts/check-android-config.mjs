import assert from 'node:assert/strict'
import fs from 'node:fs'

const readJson = (path) => JSON.parse(fs.readFileSync(path, 'utf8'))
const tauri = readJson('src-tauri/tauri.conf.json')
const capability = readJson('src-tauri/capabilities/mobile.json')
const desktopCapability = readJson('src-tauri/capabilities/desktop.json')
const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8')
const manifest = fs.readFileSync('src-tauri/gen/android/app/src/main/AndroidManifest.xml', 'utf8')
const serviceManifest = fs.readFileSync(
  'src-tauri/plugins/constellation-android/android/src/main/AndroidManifest.xml',
  'utf8',
)
const androidPlugin = fs.readFileSync(
  'src-tauri/plugins/constellation-android/android/src/main/java/space/taskyon/constellation/plugin/ConstellationAndroidPlugin.kt',
  'utf8',
)
const locationService = fs.readFileSync(
  'src-tauri/plugins/constellation-android/android/src/main/java/space/taskyon/constellation/plugin/LocationShareService.kt',
  'utf8',
)

assert.equal(tauri.identifier, 'space.taskyon.constellation')
assert.equal(tauri.bundle.android.minSdkVersion, 29)
assert.deepEqual(tauri.plugins['deep-link'].mobile, [
  {
    scheme: ['https'],
    host: 'constellation.taskyon.space',
    pathPrefix: ['/'],
    appLink: true,
  },
])
assert.equal(capability.platforms.includes('android'), true)
assert.equal(tauri.app.security.capabilities.includes('desktop'), true)
assert.equal(desktopCapability.platforms.includes('linux'), true)
assert.equal(desktopCapability.permissions.includes('core:default'), true)
for (const permission of [
  'deep-link:default',
  'geolocation:allow-check-permissions',
  'geolocation:allow-request-permissions',
  'geolocation:allow-watch-position',
  'geolocation:allow-clear-watch',
]) {
  assert.equal(capability.permissions.includes(permission), true, permission)
}
assert.match(cargo, /tauri-plugin-deep-link = "=2\.4\.10"/)
assert.match(cargo, /tauri-plugin-geolocation = "=2\.3\.3"/)
assert.match(cargo, /tauri-plugin-constellation-android/)
for (const permission of [
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
]) {
  assert.match(manifest, new RegExp(permission))
}
assert.match(serviceManifest, /android:foregroundServiceType="location"/)
assert.match(manifest, /android\.intent\.action\.SEND/)
assert.match(manifest, /android:mimeType="text\/plain"/)
assert.match(androidPlugin, /fun takeSharedText\(invoke: Invoke\)/)
assert.match(androidPlugin, /fun loadPrivateState\(invoke: Invoke\)/)
assert.match(androidPlugin, /fun savePrivateState\(invoke: Invoke\)/)
assert.doesNotMatch(manifest, /FOREGROUND_SERVICE_DATA_SYNC/)
assert.match(serviceManifest, /android:stopWithTask="false"/)
assert.match(androidPlugin, /requireNotificationPermission\(\)/)
assert.match(androidPlugin, /Allow notifications, then create the share again\./)
assert.doesNotMatch(androidPlugin, /requestNotificationPermission\(\)/)
assert.match(locationService, /LOCATION_UPDATE_INTERVAL_MS = 5_000L/)
assert.match(locationService, /LOCATION_UPDATE_MINIMUM_DISTANCE_METRES = 5f/)
assert.equal(/\?: store\.loadRequest\(\)/.test(locationService), false)
assert.equal(/store\.saveStatus\(status\.toString\(\)\)/.test(locationService), false)
assert.match(locationService, /store\.saveStatus\(redactedStatus\(status\)\)/)

console.log('Android configuration checks passed.')
