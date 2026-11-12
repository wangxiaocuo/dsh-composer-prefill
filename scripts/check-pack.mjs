/**
 * Inspect the would-be npm tarball and fail when it would ship the wrong set of
 * files (tests, CI config, dev tooling, caches) or when the `files` whitelist
 * no longer matches what the plugin actually loads at runtime.
 *
 * Run: node scripts/check-pack.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @param {string} message failure description.
 * @returns {never} exits with status 1.
 */
function fail(message) {
  console.error(`pack check failed: ${message}`)
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

// Always point npm at a throwaway cache: `npm run` may hand us the user's
// `~/.npm` cache, which can be unwritable in sandboxes and CI containers.
const env = {
  ...process.env,
  npm_config_cache: path.join(os.tmpdir(), 'dsh-composer-prefill-npm-cache'),
}

let packed
try {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  packed = JSON.parse(stdout)
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  fail(`npm pack --dry-run failed: ${detail}`)
}

const info = Array.isArray(packed) ? packed[0] : packed
if (info === undefined || typeof info !== 'object' || !Array.isArray(info.files)) {
  fail('npm pack --dry-run did not return a file list')
}

/** @type {Set<string>} */
const files = new Set(info.files.map((file) => file.path))
const required = [
  'package.json',
  'index.js',
  'client.js',
  'prompt.txt',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'LICENSE',
  'locale/en.json',
  'locale/zh.json',
]
for (const name of fs.readdirSync(path.join(root, 'lib'))) {
  if (name.endsWith('.js')) required.push(`lib/${name}`)
}

for (const name of required) {
  if (!files.has(name)) fail(`${name} is missing from the tarball`)
}

// Anything that belongs to development must stay out of the published package.
const forbiddenPrefixes = ['test/', 'scripts/', 'types/', '.github/', 'node_modules/']
const forbiddenNames = new Set(['tsconfig.json', 'pnpm-lock.yaml', '.npmrc', '.gitignore', 'trace.log'])
for (const name of files) {
  if (forbiddenPrefixes.some((prefix) => name.startsWith(prefix))) {
    fail(`${name} must not be published`)
  }
  if (forbiddenNames.has(name)) fail(`${name} must not be published`)
  if (name.endsWith('.tsbuildinfo') || name.endsWith('.tgz')) fail(`${name} must not be published`)
}

// The entry points the bundle loader resolves must exist inside the tarball.
const staticEntries = [pkg.dsh?.bundle?.patch, pkg.exports?.['.'], pkg.exports?.['./client'], pkg.exports?.['./icon']]
for (const entry of staticEntries) {
  if (typeof entry !== 'string') continue
  const name = entry.replace(/^\.\//, '')
  if (!files.has(name)) fail(`entry point ${entry} is not in the tarball`)
}

// Locale exports are a wildcard: require every shipped JSON file to match it
// and at least the two locales the client fallback knows about.
for (const name of files) {
  if (name.startsWith('locale/') && !name.endsWith('.json')) fail(`${name}: locale files must be .json`)
}

if (info.version !== pkg.version) {
  fail(`tarball version ${info.version} does not match package.json ${pkg.version}`)
}

console.log(
  `pack check ok: ${info.name}@${info.version}, ${info.files.length} files, ` +
    `${(info.size / 1024).toFixed(1)} kB packed / ${(info.unpackedSize / 1024).toFixed(1)} kB unpacked`,
)
