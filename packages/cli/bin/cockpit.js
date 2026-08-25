#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'src', 'index.ts')
const r = spawnSync('npx', ['tsx', entry, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(r.status ?? 0)
