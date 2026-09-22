import assert from "node:assert/strict";
import fs from "node:fs";

const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const tauri = readJson("src-tauri/tauri.conf.json");
const capability = readJson("src-tauri/capabilities/mobile.json");
const cargo = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
const manifest = fs.readFileSync(
  "src-tauri/gen/android/app/src/main/AndroidManifest.xml",
  "utf8",
);
const serviceManifest = fs.readFileSync(
  "src-tauri/plugins/constellation-android/android/src/main/AndroidManifest.xml",
  "utf8",
);

assert.equal(tauri.identifier, "space.taskyon.constellation");
assert.equal(tauri.bundle.android.minSdkVersion, 29);
assert.deepEqual(tauri.plugins["deep-link"].mobile, [
  {
    scheme: ["https"],
    host: "constellation.taskyon.space",
    pathPrefix: ["/"],
    appLink: true,
  },
]);
assert.equal(capability.platforms.includes("android"), true);
for (const permission of [
  "deep-link:default",
  "geolocation:allow-check-permissions",
  "geolocation:allow-request-permissions",
  "geolocation:allow-watch-position",
  "geolocation:allow-clear-watch",
]) {
  assert.equal(capability.permissions.includes(permission), true, permission);
}
assert.match(cargo, /tauri-plugin-deep-link = "=2\.4\.10"/);
assert.match(cargo, /tauri-plugin-geolocation = "=2\.3\.3"/);
assert.match(cargo, /tauri-plugin-constellation-android/);
for (const permission of [
  "android.permission.ACCESS_BACKGROUND_LOCATION",
  "android.permission.FOREGROUND_SERVICE_LOCATION",
  "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
  "android.permission.POST_NOTIFICATIONS",
]) {
  assert.match(manifest, new RegExp(permission));
}
assert.match(serviceManifest, /android:foregroundServiceType="location\|dataSync"/);
assert.match(serviceManifest, /android:stopWithTask="false"/);

console.log("Android configuration checks passed.");
