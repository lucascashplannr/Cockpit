import type { Component } from 'vue'
import {
  File, FileArchive, FileBraces, FileCode, FileCog, FileImage, FileKey, FileLock, FileMusic, FileSpreadsheet, FileTerminal,
  FileText, FileVideoCamera,
} from '@lucide/vue'
import {
  siC, siCplusplus, siCss, siDart, siDocker, siDotenv, siDotnet, siGit, siGnubash, siGo, siHtml5, siJavascript, siJson, siKotlin,
  siLess, siLua, siMarkdown, siNpm, siOpenjdk, siPhp, siPnpm, siPython, siReact, siRuby, siRust, siSass, siSvelte, siSvg,
  siSwift, siToml, siTypescript, siVite, siVuedotjs, siXml, siYaml,
} from 'simple-icons'

/** A language's own mark (Simple Icons, CC0): one 24×24 path, and its brand colour. */
export interface Brand {
  path: string
  hex: string
}
const b = (i: { path: string; hex: string }): Brand => ({ path: i.path, hex: '#' + i.hex })

const BRAND_BY_EXT: Record<string, Brand> = {
  ts: b(siTypescript), mts: b(siTypescript), cts: b(siTypescript), tsx: b(siReact), jsx: b(siReact),
  js: b(siJavascript), mjs: b(siJavascript), cjs: b(siJavascript),
  vue: b(siVuedotjs), svelte: b(siSvelte), html: b(siHtml5), htm: b(siHtml5),
  css: b(siCss), scss: b(siSass), sass: b(siSass), less: b(siLess),
  php: b(siPhp), py: b(siPython), go: b(siGo), rs: b(siRust), rb: b(siRuby), swift: b(siSwift), kt: b(siKotlin),
  c: b(siC), h: b(siC), cpp: b(siCplusplus), cs: b(siDotnet), java: b(siOpenjdk), lua: b(siLua), dart: b(siDart),
  json: b(siJson), jsonc: b(siJson), md: b(siMarkdown), mdx: b(siMarkdown), yml: b(siYaml), yaml: b(siYaml),
  toml: b(siToml), xml: b(siXml), svg: b(siSvg), sh: b(siGnubash), bash: b(siGnubash), zsh: b(siGnubash),
}
const BRAND_BY_NAME: Record<string, Brand> = {
  dockerfile: b(siDocker), 'docker-compose.yml': b(siDocker), 'docker-compose.yaml': b(siDocker),
  '.gitignore': b(siGit), '.gitattributes': b(siGit), '.npmrc': b(siNpm), 'package-lock.json': b(siNpm),
  'pnpm-lock.yaml': b(siPnpm), 'pnpm-workspace.yaml': b(siPnpm),
}

/**
 * What a file is, said by its icon: the glyph is the kind (code, data,
 * config, prose, image…), the ink is the language — the same muted hues the
 * editor colours code with, so a `.ts` in the tree and its keywords on screen
 * are of one family. Nothing here is a semantic colour.
 */
export interface FileLook {
  icon: Component
  /** A CSS colour, or null for the tree's own dim ink. */
  ink: string | null
  /** Two or three letters, for where a word reads better than a glyph. */
  badge: string | null
  /** The language's own mark, when it has one. */
  brand: Brand | null
}

const ink = (light: string, dark: string) => `light-dark(${light}, ${dark})`
const BLUE = ink('#51709f', '#92b0e0')
const TEAL = ink('#23879a', '#5cc3d4')
const OLIVE = ink('#86772a', '#d2bf61')
const PINK = ink('#b0487b', '#ee8cba')
const BROWN = ink('#98603a', '#dea27a')

const BY_EXT: Record<string, [Component, string | null, string | null]> = {
  ts: [FileCode, BLUE, 'TS'], tsx: [FileCode, BLUE, 'TSX'], mts: [FileCode, BLUE, 'TS'], cts: [FileCode, BLUE, 'TS'],
  js: [FileCode, OLIVE, 'JS'], jsx: [FileCode, OLIVE, 'JSX'], mjs: [FileCode, OLIVE, 'JS'], cjs: [FileCode, OLIVE, 'JS'],
  vue: [FileCode, TEAL, 'VUE'], svelte: [FileCode, BROWN, 'SV'],
  html: [FileCode, BROWN, 'HTM'], htm: [FileCode, BROWN, 'HTM'],
  css: [FileCode, PINK, 'CSS'], scss: [FileCode, PINK, 'SCS'], sass: [FileCode, PINK, 'SAS'], less: [FileCode, PINK, 'LES'],
  php: [FileCode, ink('#6b5fb5', '#a99cf0'), 'PHP'], py: [FileCode, BLUE, 'PY'], rb: [FileCode, PINK, 'RB'],
  go: [FileCode, TEAL, 'GO'], rs: [FileCode, BROWN, 'RS'], java: [FileCode, BROWN, 'JV'], kt: [FileCode, PINK, 'KT'],
  swift: [FileCode, BROWN, 'SW'], c: [FileCode, BLUE, 'C'], h: [FileCode, BLUE, 'H'], cpp: [FileCode, BLUE, 'C++'],
  cs: [FileCode, TEAL, 'C#'],
  json: [FileBraces, OLIVE, '{}'], jsonc: [FileBraces, OLIVE, '{}'], json5: [FileBraces, OLIVE, '{}'],
  yml: [FileCog, null, 'YML'], yaml: [FileCog, null, 'YML'], toml: [FileCog, null, 'TML'], ini: [FileCog, null, 'INI'],
  xml: [FileCode, BROWN, 'XML'],
  md: [FileText, null, 'MD'], markdown: [FileText, null, 'MD'], mdx: [FileText, null, 'MDX'], txt: [FileText, null, 'TXT'],
  rst: [FileText, null, 'RST'], pdf: [FileText, PINK, 'PDF'],
  sh: [FileTerminal, null, 'SH'], bash: [FileTerminal, null, 'SH'], zsh: [FileTerminal, null, 'SH'], ps1: [FileTerminal, null, 'PS'],
  sql: [FileSpreadsheet, TEAL, 'SQL'], csv: [FileSpreadsheet, TEAL, 'CSV'], tsv: [FileSpreadsheet, TEAL, 'TSV'],
  xlsx: [FileSpreadsheet, TEAL, 'XLS'], xls: [FileSpreadsheet, TEAL, 'XLS'],
  svg: [FileImage, BROWN, 'SVG'], png: [FileImage, BROWN, 'PNG'], jpg: [FileImage, BROWN, 'JPG'], jpeg: [FileImage, BROWN, 'JPG'],
  gif: [FileImage, BROWN, 'GIF'], webp: [FileImage, BROWN, 'IMG'], avif: [FileImage, BROWN, 'IMG'], ico: [FileImage, BROWN, 'ICO'],
  mp4: [FileVideoCamera, null, 'MP4'], mov: [FileVideoCamera, null, 'MOV'], mp3: [FileMusic, null, 'MP3'], wav: [FileMusic, null, 'WAV'],
  zip: [FileArchive, null, 'ZIP'], gz: [FileArchive, null, 'GZ'], tar: [FileArchive, null, 'TAR'],
  lock: [FileLock, null, 'LCK'], pem: [FileKey, null, 'KEY'], key: [FileKey, null, 'KEY'],
}

/** Names that say more than their extension does. */
const BY_NAME: Record<string, [Component, string | null, string | null]> = {
  'pnpm-lock.yaml': [FileLock, null, 'LCK'], 'package-lock.json': [FileLock, null, 'LCK'], 'yarn.lock': [FileLock, null, 'LCK'],
  'composer.lock': [FileLock, null, 'LCK'], 'cargo.lock': [FileLock, null, 'LCK'],
  dockerfile: [FileCog, null, 'DCK'], makefile: [FileTerminal, null, 'MK'],
  '.gitignore': [FileCog, null, 'GIT'], '.gitattributes': [FileCog, null, 'GIT'], '.npmrc': [FileCog, null, 'NPM'],
  '.editorconfig': [FileCog, null, 'CFG'], '.prettierrc': [FileCog, null, 'CFG'], '.nvmrc': [FileCog, null, 'CFG'],
}

export function fileLook(name: string): FileLook {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  const brand =
    BRAND_BY_NAME[lower] ??
    (lower === '.env' || lower.startsWith('.env.') ? b(siDotenv) : undefined) ??
    (/^vite\.config\./.test(lower) ? b(siVite) : undefined) ??
    BRAND_BY_EXT[ext] ??
    null
  const hit =
    BY_NAME[lower] ??
    // `.env`, `.env.local`, `.env.example`: secrets, or the shape of them.
    (lower === '.env' || lower.startsWith('.env.') ? [FileKey, null, 'ENV'] as [Component, null, string] : undefined) ??
    BY_EXT[ext]
  return hit ? { icon: hit[0], ink: hit[1], badge: hit[2], brand } : { icon: File, ink: null, badge: null, brand }
}
