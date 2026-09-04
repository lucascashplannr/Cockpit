import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Cutting a release, which is one number in one file and a tag that agrees
 * with it. The version in apps/desktop/package.json is what electron-builder
 * stamps into the artifacts and what electron-updater compares against, so it
 * is the only version that decides anything — the workflow refuses a tag that
 * disagrees with it rather than shipping a build nobody is offered.
 *
 * Stops before pushing. Pushing the tag is what starts the build and puts
 * installers in front of people, and that is a decision, not a step.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(ROOT, 'apps', 'desktop', 'package.json')

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: pnpm release <x.y.z>    (e.g. pnpm release 0.2.0)')
  process.exit(1)
}

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch (e) {
    // git's own words, not a Node stack trace pointing at this file — the
    // failure is always something about the repository, never about the script.
    console.error('git ' + args.join(' ') + ' failed:\n')
    console.error((e.stdout || '') + (e.stderr || ''))
    process.exit(1)
  }
}

if (git('status', '--porcelain')) {
  console.error('The tree is dirty. A release should be a commit that exists already.')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const previous = pkg.version

/**
 * Both ways of asking for a release that already exists. Running this twice is
 * the normal way to reach them — the first run leaves nothing to commit, and
 * without these the second dies on `git commit` with a stack trace that says
 * nothing about what actually happened.
 */
if (previous === version) {
  console.error(`Already at ${version}. Nothing to bump.`)
  console.error(`\n  If the tag is made, what is left is:\n\n      git push origin main v${version}\n`)
  process.exit(1)
}

if (git('tag', '--list', `v${version}`)) {
  console.error(`The tag v${version} already exists, on a different commit than this would make.`)
  console.error('Pick the next version, or delete that tag if it was never pushed.')
  process.exit(1)
}
pkg.version = version
writeFileSync(MANIFEST, JSON.stringify(pkg, null, 2) + '\n')

git('add', MANIFEST)
git('commit', '-m', `release: v${version}`)
git('tag', '-a', `v${version}`, '-m', `Cockpit ${version}`)

console.log(`\n  ${previous} → ${version}, committed and tagged v${version}.`)
console.log('\n  Nothing has left this machine. To build and publish the installers:\n')
console.log(`      git push origin main v${version}\n`)
