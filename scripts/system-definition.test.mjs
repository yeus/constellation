import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const parseCsv = (text) => {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character !== '"') field += character
      else if (text[index + 1] === '"') {
        field += '"'
        index += 1
      } else quoted = false
    } else if (character === '"') quoted = true
    else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field.endsWith('\r') ? field.slice(0, -1) : field)
      rows.push(row)
      row = []
      field = ''
    } else field += character
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

test('system definition rows are complete and structurally valid', () => {
  const text = fs.readFileSync(new URL('../SYSTEM_DEFINITION.csv', import.meta.url), 'utf8')
  const rows = parseCsv(text).filter((row) => row.some((field) => field.length > 0))
  const [header, ...records] = rows
  assert.equal(header.length, 13, 'catalog header must contain 13 columns')
  const ids = new Set()
  for (const [index, row] of records.entries()) {
    const line = index + 2
    assert.equal(row.length, header.length, `catalog row ${line} (${row[0]}) must have 13 columns`)
    const record = Object.fromEntries(
      header.map((column, columnIndex) => [column, row[columnIndex]]),
    )
    for (const required of [
      'id',
      'category',
      'feature',
      'description',
      'status',
      'milestone',
      'target_release',
    ]) {
      assert.ok(record[required]?.length, `catalog row ${line} must define ${required}`)
    }
    assert.ok(
      ['planned', 'implemented', 'tracked'].includes(record.status),
      `catalog row ${line} has an unsupported status`,
    )
    assert.match(record.id, /^[a-z0-9-]+$/, `catalog row ${line} has an invalid id`)
    assert.equal(ids.has(record.id), false, `catalog id ${record.id} is duplicated`)
    ids.add(record.id)
  }
})
