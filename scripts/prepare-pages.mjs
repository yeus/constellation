import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const assetLinksFor = (fingerprint, packageName) => {
  if (!/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)) {
    throw new Error('Android App Links need an uppercase SHA-256 certificate fingerprint.')
  }
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}$/.test(packageName)) {
    throw new Error('Android App Links need a valid application identifier.')
  }
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: packageName,
        sha256_cert_fingerprints: [fingerprint],
      },
    },
  ]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.copyFileSync('dist/index.html', 'dist/404.html')
  const fingerprint = process.env.ANDROID_APP_LINK_SHA256
  if (fingerprint) {
    const packageName = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')).identifier
    const assetLinks = assetLinksFor(fingerprint, packageName)
    fs.mkdirSync('dist/.well-known', { recursive: true })
    fs.writeFileSync('dist/.well-known/assetlinks.json', JSON.stringify(assetLinks))
  } else {
    process.stderr.write(
      'Android App Links are not verified: set ANDROID_APP_LINK_SHA256 in GitLab CI.\n',
    )
  }
}
