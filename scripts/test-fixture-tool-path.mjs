import fs from 'node:fs'
import path from 'node:path'

// Keep shell fixtures independent of the developer's signing tools while making
// their ordinary POSIX utilities available on NixOS (which has no /bin/bash).
const fixtureTools = [
  'awk',
  'base64',
  'bash',
  'cat',
  'chmod',
  'cmp',
  'cp',
  'cut',
  'dirname',
  'grep',
  'head',
  'install',
  'ln',
  'mkdir',
  'mktemp',
  'mv',
  'rm',
  'rmdir',
  'sed',
  'tr',
  'uname',
]

const locateTool = (name) => {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Look in the next host tool directory.
    }
  }
  throw new Error(`Test fixture requires ${name} on the host PATH.`)
}

export const createFixtureToolPath = (root, ...prefixes) => {
  const toolsDir = path.join(root, 'fixture-tools')
  fs.mkdirSync(toolsDir)
  for (const name of fixtureTools) {
    fs.symlinkSync(locateTool(name), path.join(toolsDir, name))
  }
  fs.symlinkSync(process.execPath, path.join(toolsDir, 'node'))
  return [...prefixes, toolsDir].join(path.delimiter)
}
