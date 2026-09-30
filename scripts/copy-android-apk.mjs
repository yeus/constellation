import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const architectureNames = {
  aarch64: 'arm64-v8a',
  x86_64: 'x86_64',
}

export const androidArtifactName = (mode, target) => {
  const architecture = architectureNames[target]
  if (!architecture) throw new Error(`Unsupported Android target: ${target}`)
  if (mode !== 'debug' && mode !== 'release') {
    throw new Error(`Unsupported Android build mode: ${mode}`)
  }
  return `constellation-android-${mode}-${architecture}.apk`
}

const apkPath = (root, variant, filename) =>
  path.join(root, 'src-tauri/gen/android/app/build/outputs/apk', variant, filename)

export const androidApkCandidates = (root, mode) => {
  const signed = [
    apkPath(root, `universal/${mode}`, `app-universal-${mode}.apk`),
    apkPath(root, mode, `app-${mode}.apk`),
  ]
  if (mode === 'release') return signed
  return [
    ...signed,
    apkPath(root, `universal/${mode}`, `app-universal-${mode}-unsigned.apk`),
    apkPath(root, mode, `app-${mode}-unsigned.apk`),
  ]
}

const unsignedReleaseCandidates = (root) => [
  apkPath(root, 'universal/release', 'app-universal-release-unsigned.apk'),
  apkPath(root, 'release', 'app-release-unsigned.apk'),
]

const copyAndroidApk = (root, mode, target) => {
  const candidates = androidApkCandidates(root, mode)
  const source = candidates.find((candidate) => fs.existsSync(candidate))
  if (!source) {
    const unsigned =
      mode === 'release'
        ? unsignedReleaseCandidates(root).find((candidate) => fs.existsSync(candidate))
        : undefined
    if (unsigned) {
      throw new Error(`Release APK is unsigned and cannot be published: ${unsigned}`)
    }
    throw new Error(
      [
        `Could not find the ${mode} Android APK. Checked:`,
        ...candidates.map((candidate) => `  - ${candidate}`),
      ].join('\n'),
    )
  }

  if (mode === 'release') {
    try {
      execFileSync('apksigner', ['verify', source], { stdio: 'pipe' })
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error('Android build tools apksigner is required to verify the release APK.')
      }
      throw new Error('Android release APK signature verification failed; refusing to copy it.')
    }
  }

  const outputDirectory = path.join(root, 'dist')
  const destination = path.join(outputDirectory, androidArtifactName(mode, target))
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.copyFileSync(source, destination)
  if (mode === 'release') {
    const hash = createHash('sha256').update(fs.readFileSync(destination)).digest('hex')
    fs.writeFileSync(`${destination}.sha256`, `${hash}  ${path.basename(destination)}\n`)
  }
  return destination
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    const destination = copyAndroidApk(
      process.cwd(),
      process.argv[2] ?? 'debug',
      process.argv[3] ?? 'x86_64',
    )
    console.log(`Copied Android APK to ${destination}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
