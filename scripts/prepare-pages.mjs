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

export const tauriIdentifier = (tauriConfigPath = 'src-tauri/tauri.conf.json') =>
  JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8')).identifier

export const preparePages = ({
  distDir = 'dist',
  fingerprint = process.env.ANDROID_APP_LINK_SHA256,
  packageName = tauriIdentifier(),
  warn = (message) => process.stderr.write(message),
} = {}) => {
  fs.copyFileSync(path.join(distDir, 'index.html'), path.join(distDir, '404.html'))
  if (!fingerprint) {
    warn(
      'Android App Links are not verified: set the ANDROID_APP_LINK_SHA256 GitHub Actions secret.\n',
    )
    return { assetLinks: undefined }
  }
  const assetLinks = assetLinksFor(fingerprint, packageName)
  const wellKnown = path.join(distDir, '.well-known')
  fs.mkdirSync(wellKnown, { recursive: true })
  fs.writeFileSync(path.join(wellKnown, 'assetlinks.json'), JSON.stringify(assetLinks))
  return { assetLinks }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  preparePages()
}
