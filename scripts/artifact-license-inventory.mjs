import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const knownLibraries = [
  {
    pattern: /^libwebkit2gtk|^libjavascriptcoregtk/,
    component: 'WebKitGTK / JavaScriptCore',
    family: 'LGPL-2.1-or-later',
  },
  {
    pattern:
      /^libgtk-3|^libgdk-3|^libatk|^libatk-bridge|^libgail|^libpangocairo|^libpango-1|^libgdk_pixbuf|^libatspi/,
    component: 'GTK / ATK / Pango / GdkPixbuf',
    family: 'LGPL-2.1-or-later',
  },
  {
    pattern: /^libglib-2|^libgio-2|^libgobject-2|^libgmodule-2|^libgthread-2/,
    component: 'GLib / GIO / GObject',
    family: 'LGPL-2.1-or-later',
  },
  { pattern: /^libsoup-/, component: 'libsoup', family: 'LGPL-2.0-or-later' },
  {
    pattern: /^libgiognutls|^libgnutls/,
    component: 'GnuTLS / glib-networking',
    family: 'LGPL-2.1-or-later',
  },
  { pattern: /^libsecret/, component: 'libsecret', family: 'LGPL-2.1-or-later' },
  {
    pattern: /^libavcodec|^libavformat|^libavutil|^libswscale|^libswresample/,
    component: 'FFmpeg',
    family: 'LGPL-2.1-or-later',
  },
  {
    pattern: /^libaom|^libavif|^libdav1d/,
    component: 'AV1/AVIF codecs',
    family: 'BSD-2-Clause or permissive',
  },
  { pattern: /^libX|^libx/, component: 'X11 libraries', family: 'MIT' },
  {
    pattern: /^libpng|^libjpeg|^libwebp|^libtiff|^libexif/,
    component: 'Image codecs',
    family: 'BSD-like or permissive',
  },
  { pattern: /^libicu/, component: 'ICU', family: 'Unicode-3.0' },
  { pattern: /^libfreetype/, component: 'FreeType', family: 'FTL or GPL-2.0-or-later' },
  { pattern: /^libharfbuzz/, component: 'HarfBuzz', family: 'MIT' },
  { pattern: /^libfontconfig/, component: 'fontconfig', family: 'MIT-like' },
  { pattern: /^libsqlite3/, component: 'SQLite', family: 'Public domain' },
  { pattern: /^libnss|^libnspr/, component: 'NSS/NSPR', family: 'MPL-2.0' },
  {
    pattern: /^libstdc\+\+|^libgcc/,
    component: 'GCC runtime',
    family: 'GPL-3.0-with-GCC-exception',
  },
  {
    pattern: /^libc\.|^libm\.|^libdl|^libpthread|^librt/,
    component: 'glibc',
    family: 'LGPL-2.1-or-later',
  },
  { pattern: /^libz\.|^libzstd|^liblzma|^libbz2/, component: 'Compression', family: 'permissive' },
  { pattern: /^libepoxy/, component: 'libepoxy', family: 'MIT' },
  { pattern: /^libwayland/, component: 'Wayland', family: 'MIT' },
  { pattern: /^libcairo/, component: 'Cairo', family: 'LGPL-2.1-or-later or MPL-1.1' },
  { pattern: /^libgstreamer|^libgst/, component: 'GStreamer', family: 'LGPL-2.1-or-later' },
  { pattern: /^im-/, component: 'GTK input methods', family: 'LGPL-2.1-or-later' },
  {
    pattern: /^libEGL|^libGLX|^libGLdispatch|^libGL\.|^libgbm|^libglapi|^libgallium/,
    component: 'Mesa',
    family: 'MIT',
  },
  {
    pattern: /^libFLAC|^libogg|^libvorbis|^libopus|^libsndfile|^libspeex/,
    component: 'Xiph codecs',
    family: 'BSD-like',
  },
  { pattern: /^libLerc|^libcups/, component: 'Lerc / CUPS', family: 'Apache-2.0' },
  {
    pattern:
      /^libaspell|^libhunspell|^libdatrie|^libthai|^libavahi|^libblkid|^libmount|^libuuid|^libfdisk/,
    component: 'Desktop support libraries',
    family: 'LGPL-2.1-or-later',
  },
  {
    pattern: /^libatomic|^libgomp|^libquadmath/,
    component: 'GCC runtime',
    family: 'GPL-3.0-with-GCC-exception',
  },
  {
    pattern: /^libbacktrace|^libbrotli|^libexpat|^libffi/,
    component: 'Support libraries',
    family: 'permissive',
  },
  { pattern: /^libdbus-1/, component: 'D-Bus', family: 'AFL-2.1 or GPL-2.0-or-later' },
  {
    pattern: /^libdeflate|^libdrm|^libevdev|^liblcms2|^libpixman|^libpcre2/,
    component: 'Support libraries',
    family: 'permissive',
  },
  {
    pattern: /^libdw|^libelf/,
    component: 'elfutils',
    family: 'LGPL-2.1-or-later or GPL-2.0-or-later',
  },
  {
    pattern:
      /^libenchant|^libhyphen|^libfribidi|^libgraphite2|^libgudev|^libjson-glib|^libmanette|^libpulse|^libmpg123|^libpangoft2/,
    component: 'Desktop support libraries',
    family: 'LGPL-2.1-or-later',
  },
  { pattern: /^libflite/, component: 'Flite', family: 'BSD-like' },
  {
    pattern:
      /^libgcrypt|^libgpg-error|^libgmp|^libnettle|^libhogweed|^libp11-kit|^libidn2|^libpsl|^libnghttp2/,
    component: 'Crypto/network support',
    family: 'LGPL-2.1-or-later or permissive',
  },
  {
    pattern: /^libhidapi|^libhwy|^libjxl|^liborc/,
    component: 'Support libraries',
    family: 'permissive',
  },
  { pattern: /^libmp3lame/, component: 'LAME', family: 'LGPL-2.0-or-later' },
  {
    pattern: /^libpixbufloader|^libprintbackend/,
    component: 'GdkPixbuf loaders / GTK print backends',
    family: 'LGPL-2.1-or-later',
  },
  {
    pattern: /^librsvg|^libseccomp|^libsystemd|^libudev|^libtasn1|^libtinysparql/,
    component: 'Desktop support libraries',
    family: 'LGPL-2.1-or-later',
  },
  { pattern: /^libselinux/, component: 'libselinux', family: 'Public domain' },
  {
    pattern: /^libsharpyuv|^libvmaf|^libyuv/,
    component: 'Image/video support',
    family: 'BSD-like',
  },
  { pattern: /^libssp/, component: 'GCC runtime', family: 'GPL-3.0-with-GCC-exception' },
  {
    pattern: /^libunistring/,
    component: 'libunistring',
    family: 'LGPL-3.0-or-later or GPL-2.0-or-later',
  },
  { pattern: /^libunwind/, component: 'libunwind', family: 'MIT' },
]

export const classifyBundledLibrary = (basename) => {
  const match = knownLibraries.find((entry) => entry.pattern.test(basename))
  return match ? { component: match.component, family: match.family } : undefined
}

export const apkInventory = (apkPath) => {
  const entries = execFileSync('unzip', ['-Z1', apkPath], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  return {
    dex: entries.filter((entry) => /^classes\d*\.dex$/.test(entry)),
    native: entries.filter((entry) => /^lib\/.*\.so$/.test(entry)),
    assets: entries.filter((entry) => entry.startsWith('assets/')),
    notices: entries.filter(
      (entry) => entry.startsWith('META-INF/') && /(LICENSE|NOTICE)/i.test(entry),
    ),
    resources: entries.filter((entry) => entry.startsWith('res/')).length,
  }
}

export const appImageInventory = (root) => {
  const libraries = new Set()
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(fullPath)
      else if (entry.name.includes('.so')) libraries.add(entry.name)
    }
  }
  const libDirectory = path.join(root, 'usr', 'lib')
  if (fs.existsSync(libDirectory)) visit(libDirectory)
  return [...libraries].sort().map((name) => ({
    name,
    ...(classifyBundledLibrary(name) ?? { component: 'unknown', family: 'unknown' }),
  }))
}

export const flatpakInputs = (manifestPath) => {
  const manifest = fs.readFileSync(manifestPath, 'utf8')
  const read = (key) => manifest.match(new RegExp(`^${key}:\\s*(\\S+)`, 'm'))?.[1] ?? ''
  const buildOptions =
    manifest.match(/^\s+build-options:\s*\n([\s\S]*?)^\s+build-commands:/m)?.[1] ?? ''
  return {
    runtime: read('runtime'),
    runtimeVersion: manifest.match(/^runtime-version:\s*['"]?([^'"\n]+)['"]?/m)?.[1] ?? '',
    sdk: read('sdk'),
    modules: [...manifest.matchAll(/^\s*-\s+name:\s*(\S+)/gm)].map((match) => match[1]),
    networkBuildArgs: /--share=network/.test(buildOptions),
    localSource: /type:\s*dir/.test(manifest),
  }
}

export const defaultApkPath = (root = process.cwd()) => {
  const directory = path.join(root, 'dist')
  if (!fs.existsSync(directory)) return undefined
  const filename = fs
    .readdirSync(directory)
    .filter((entry) => entry.endsWith('.apk'))
    .sort()
    .at(-1)
  return filename ? path.join(directory, filename) : undefined
}

export const strictArtifactIssues = (report) => {
  const issues = []
  if (!report.apk) issues.push('No Android APK was inspected.')
  if (!report.appImage) {
    issues.push('No AppImage payload was inspected; pass --appimage-root <extracted-root>.')
  }
  if (!report.flatpak) issues.push('No Flatpak manifest was inspected.')
  const unknown = (report.appImage?.libraries ?? []).filter(
    (library) => library.family === 'unknown',
  )
  if (unknown.length > 0) {
    issues.push(
      `${unknown.length} bundled AppImage librar${unknown.length === 1 ? 'y needs' : 'ies need'} license review: ${unknown.map(({ name }) => name).join(', ')}`,
    )
  }
  return issues
}

const valueAfter = (args, flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const report = {}
  const apk = valueAfter(args, '--apk') ?? defaultApkPath()
  if (apk && fs.existsSync(apk)) {
    report.apk = { path: apk, ...apkInventory(apk) }
    console.log(`APK ${apk}: ${report.apk.dex.length} dex, ${report.apk.native.length} native libs`)
    console.log(`  native: ${report.apk.native.join(', ') || 'none'}`)
    console.log(`  notices: ${report.apk.notices.join(', ') || 'none'}`)
  }
  const appImageRoot = valueAfter(args, '--appimage-root')
  if (appImageRoot && fs.existsSync(appImageRoot)) {
    const libraries = appImageInventory(appImageRoot)
    const unknown = libraries.filter((library) => library.family === 'unknown')
    report.appImage = { root: appImageRoot, libraries }
    console.log(`AppImage payload ${appImageRoot}: ${libraries.length} bundled libraries`)
    for (const library of libraries.filter((entry) => entry.family !== 'unknown')) {
      console.log(`  ${library.family}: ${library.name} (${library.component})`)
    }
    if (unknown.length > 0) {
      console.log(`  unknown: ${unknown.map((library) => library.name).join(', ')}`)
    }
  }
  const manifestPath = 'packaging/flatpak/space.taskyon.constellation.yml'
  if (fs.existsSync(manifestPath)) {
    report.flatpak = flatpakInputs(manifestPath)
    console.log(
      `Flatpak: ${report.flatpak.runtime} ${report.flatpak.runtimeVersion}; modules ${report.flatpak.modules.join(', ')}`,
    )
    console.log(
      `  network build args: ${report.flatpak.networkBuildArgs}; local dir source: ${report.flatpak.localSource}`,
    )
  }
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  if (args.includes('--strict')) {
    const issues = strictArtifactIssues(report)
    for (const issue of issues) console.error(issue)
    if (issues.length > 0) process.exitCode = 1
  }
}
