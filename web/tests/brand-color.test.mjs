import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('../src/utils/brand-color.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
})
const module = { exports: {} }
// eslint-disable-next-line no-new-func
new Function('exports', outputText)(module.exports)
const { BRAND_PRESETS, contrastRatio, deriveBrandPalette, readableTextColor } = module.exports

test('presets and extreme custom colors keep readable text in both modes', () => {
  const colors = [...BRAND_PRESETS.map(preset => preset.color), '#000', '#fff', '#ff0', '#00f', '#f00', '#777']
  for (const dark of [false, true]) {
    for (const color of colors) {
      const palette = deriveBrandPalette(color, dark)
      const surface = dark ? '#303b47' : '#e8edf2'
      assert.ok(contrastRatio(palette.primary, surface) >= 4.5, `${color} on ${surface}`)
      assert.ok(contrastRatio(palette.onFill, palette.fill) >= 4.5, `${color} fill`)
      assert.ok(contrastRatio(readableTextColor(palette.fillHover), palette.fillHover) >= 4.5, `${color} hover`)
      assert.ok(contrastRatio(readableTextColor(palette.fillPressed), palette.fillPressed) >= 4.5, `${color} pressed`)
    }
  }
})
