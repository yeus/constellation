import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const desktopArtifactName = (version, architecture) =>
  `constellation-desktop-${version}-${architecture}.AppImage`

const copyDesktopArtifact = (root) => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const targetDirectory = process.env.CARGO_TARGET_DIR
    ? path.resolve(process.env.CARGO_TARGET_DIR)
    : path.join(root, 'src-tauri/target')
  const bundleDirectory = path.join(targetDirectory, 'release/bundle/appimage')
  const source = fs
    .readdirSync(bundleDirectory)
    .filter((name) => name.endsWith('.AppImage'))
    .map((name) => path.join(bundleDirectory, name))
    .sort()
    .at(-1)
  if (!source) throw new Error(`No AppImage found in ${bundleDirectory}.`)
  const outputDirectory = path.join(root, 'dist')
  const architecture = process.arch === 'x64' ? 'x86_64' : process.arch
  const destination = path.join(
    outputDirectory,
    desktopArtifactName(packageJson.version, architecture),
  )
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.copyFileSync(source, destination)
  return destination
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    console.log(`Copied AppImage to ${copyDesktopArtifact(process.cwd())}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
