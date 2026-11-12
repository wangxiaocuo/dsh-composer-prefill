/**
 * Verify that the three things that name a release agree with each other:
 * `package.json`, the newest versioned `CHANGELOG.md` heading, and (when
 * released from CI) the pushed git tag.
 *
 * Run locally before tagging:      node scripts/check-release.mjs
 * Run in the release workflow:      node scripts/check-release.mjs   (reads GITHUB_REF_NAME)
 * Run against an explicit tag:      node scripts/check-release.mjs v0.4.0
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @param {string} message failure description.
 * @returns {never} exits with status 1.
 */
function fail(message) {
  console.error(`release check failed: ${message}`)
  process.exit(1)
}

/**
 * @param {string} name file name in the repository root.
 * @returns {string} file contents.
 */
function read(name) {
  try {
    return fs.readFileSync(path.join(root, name), 'utf8')
  } catch (error) {
    fail(`cannot read ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const pkg = JSON.parse(read('package.json'))
const changelog = read('CHANGELOG.md')
const version = pkg.version

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`package.json version ${JSON.stringify(version)} is not a plain x.y.z version`)
}

// The changelog must keep an Unreleased bucket and record this version as the
// newest released one, otherwise a tag would publish undocumented code.
if (!/^## \[Unreleased\]$/m.test(changelog)) {
  fail('CHANGELOG.md has no "## [Unreleased]" section')
}
const released = changelog.match(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/m)
if (released === null) {
  fail('CHANGELOG.md has no "## [x.y.z] - YYYY-MM-DD" released section')
}
if (released[1] !== version) {
  fail(`CHANGELOG.md newest release is ${released[1]}, package.json says ${version}`)
}

// Link references keep the compare/release links on GitHub working. They are
// cheap to get wrong by hand, so the check insists on both ends of the chain.
if (!/^\[Unreleased\]: /m.test(changelog)) {
  fail('CHANGELOG.md has no "[Unreleased]:" link reference definition')
}
if (!new RegExp(`^\\[${version.replaceAll('.', '\\.')}\\]: `, 'm').test(changelog)) {
  fail(`CHANGELOG.md has no "[${version}]:" link reference definition`)
}

const tag = process.env.GITHUB_REF_NAME ?? process.argv[2]
if (typeof tag === 'string' && tag !== '') {
  if (tag !== `v${version}`) {
    fail(`git tag ${tag} does not match package version v${version}`)
  }
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    if (branch !== 'HEAD' && branch !== 'main') {
      console.warn(`warning: releasing from branch ${branch}, not main`)
    }
  } catch {
    // Not a git checkout (for example an npm tarball); the tag check is still valid.
  }
}

console.log(`release check ok: v${version} (${released[2]})`)
