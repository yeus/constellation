import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const submissionManifest = (
  source,
  { tag, commit, url = 'https://github.com/yeus/constellation.git' },
) => {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('Flathub submissions need a full 40-character lowercase commit hash.')
  }
  if (!/^v?\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error('Flathub submissions need a release tag such as v0.1.0.')
  }
  const begin = source.indexOf('      # BEGIN local-source\n')
  const endMarker = '      # END local-source\n'
  const end = source.indexOf(endMarker)
  if (begin < 0 || end < 0) {
    throw new Error('The local Flatpak manifest is missing its source markers.')
  }
  const replacement = [
    '      - type: git',
    `        url: ${url}`,
    `        tag: ${tag}`,
    `        commit: ${commit}`,
    '',
  ].join('\n')
  const draft = source.slice(0, begin) + replacement + source.slice(end + endMarker.length)
  return [
    '# REVIEW DRAFT ONLY',
    '# Flathub currently forbids AI-generated or AI-assisted manifest content.',
    '# This draft must be independently re-authored by a human before submission.',
    draft,
  ].join('\n')
}

const valueAfter = (args, flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const tag = valueAfter(args, '--tag')
  const commit = valueAfter(args, '--commit')
  const output =
    valueAfter(args, '--output') ??
    'packaging/flatpak/space.taskyon.constellation.flathub-review.yml'
  if (!tag || !commit) {
    console.error(
      'Usage: node scripts/flatpak-submission-manifest.mjs --tag v0.1.0 --commit <40-char-sha>',
    )
    process.exitCode = 1
  } else {
    const manifest = submissionManifest(
      fs.readFileSync('packaging/flatpak/space.taskyon.constellation.yml', 'utf8'),
      { tag, commit },
    )
    fs.writeFileSync(output, manifest)
    console.log(`Wrote Flathub review draft to ${output}; do not submit it directly.`)
  }
}
