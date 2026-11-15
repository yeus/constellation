import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const plugin = fs.readFileSync(
  'src-tauri/plugins/constellation-android/android/src/main/java/space/taskyon/constellation/plugin/ConstellationAndroidPlugin.kt',
  'utf8',
)
const manifest = fs.readFileSync(
  'src-tauri/plugins/constellation-android/android/src/main/AndroidManifest.xml',
  'utf8',
)
const paths = fs.readFileSync(
  'src-tauri/plugins/constellation-android/android/src/main/res/xml/constellation_file_paths.xml',
  'utf8',
)
const mobile = fs.readFileSync('src-tauri/plugins/constellation-android/src/mobile.rs', 'utf8')
const root = fs.readFileSync('src-tauri/src/lib.rs', 'utf8')
const ui = fs.readFileSync('src/views/MapView.vue', 'utf8')

test('logs are shared as a file, not an Android clipboard payload', () => {
  assert.match(ui, /Share logs as file/)
  assert.match(ui, /android_share_session_logs/)
  assert.match(ui, /sessionLog\.format/)
  assert.match(root, /android_share_session_logs/)
  assert.match(mobile, /shareSessionLogs/)
  assert.match(plugin, /fun shareSessionLogs\(invoke: Invoke\)/)
  assert.match(plugin, /Intent\(Intent\.ACTION_SEND\)/)
  assert.match(plugin, /Intent\.EXTRA_STREAM/)
  assert.match(plugin, /Intent\.FLAG_GRANT_READ_URI_PERMISSION/)
  assert.match(plugin, /ClipData\.newRawUri/)
})

test('file provider is private and can share only the session-log cache directory', () => {
  assert.match(manifest, /android:authorities="\$\{applicationId\}\.sessionlogs"/)
  assert.match(manifest, /ConstellationLogFileProvider/)
  assert.match(manifest, /android:exported="false"/)
  assert.match(manifest, /android:grantUriPermissions="true"/)
  assert.match(manifest, /@xml\/constellation_file_paths/)
  assert.match(paths, /<cache-path name="session_logs" path="shared-logs\/"\s*\/>/)
  assert.doesNotMatch(paths, /external-path|root-path|<files-path/)
  assert.match(plugin, /10_000_000/)
  assert.match(plugin, /ReliabilityJournal\(activity\.applicationContext\)\.writeTo\(writer\)/)
  assert.match(plugin, /activity\.cacheDir/)
})
