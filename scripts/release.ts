#!/usr/bin/env bun

/**
 * Release Script — tag, GitHub release, npm publish
 *
 * Reads the current version from package.json.
 * Version bumping is done manually before merging to main.
 *
 * Usage (local):
 *   bun scripts/release.ts
 *
 * In CI this is called automatically by the release workflow after
 * the version-check gate passes.
 */

import { readFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'

interface CommitEntry {
  hash: string
  message: string
}

function getPackageInfo(): { name: string; version: string; repositorySlug: string } {
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))
  const repositoryUrl = pkg.repository?.url as string | undefined
  const repositorySlug = repositoryUrl
    ? repositoryUrl
        .replace(/^git\+https:\/\/github\.com\//, '')
        .replace(/^https:\/\/github\.com\//, '')
        .replace(/\.git$/, '')
    : 'emanspeaks/opencode-model-stats'
  return { name: pkg.name, version: pkg.version, repositorySlug }
}

function runCommand(cmd: string, description: string): void {
  console.log(`\n📦 ${description}...`)
  try {
    execSync(cmd, { stdio: 'inherit' })
    console.log(`✓ ${description} completed`)
  } catch (error) {
    console.error(`✗ ${description} failed`)
    throw error
  }
}

function getPreviousTag(): string | null {
  try {
    return execSync('git describe --tags --abbrev=0 HEAD^', { encoding: 'utf-8' }).trim() || null
  } catch {
    return null
  }
}

function getReleaseCommits(previousTag: string | null): CommitEntry[] {
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD'
  const output = execSync(`git log ${range} --pretty=format:%h%x09%s`, { encoding: 'utf-8' })
  return output
    .split('\n')
    .filter(Boolean)
    .map((line: string) => {
      const [hash, message] = line.split('\t')
      return { hash, message }
    })
    .filter((commit: CommitEntry) => !commit.message.startsWith('chore: bump version to '))
}

function formatCommitList(commits: CommitEntry[]): string {
  if (commits.length === 0) return '- No user-facing changes recorded in this release.'
  return commits.map((commit) => `- ${commit.message} (${commit.hash})`).join('\n')
}

function groupCommits(commits: CommitEntry[]): Array<{ title: string; commits: CommitEntry[] }> {
  const remaining = [...commits]
  const groups = [
    { title: 'Features', matcher: (m: string) => m.startsWith('feat:') },
    { title: 'Fixes', matcher: (m: string) => m.startsWith('fix:') },
    { title: 'Documentation', matcher: (m: string) => m.startsWith('docs:') },
  ]

  const grouped = groups
    .map((group) => {
      const matched = remaining.filter((c) => group.matcher(c.message))
      matched.forEach((c) => remaining.splice(remaining.indexOf(c), 1))
      return { title: group.title, commits: matched }
    })
    .filter((g) => g.commits.length > 0)

  if (remaining.length > 0) grouped.push({ title: 'Maintenance', commits: remaining })
  return grouped
}

function generateReleaseNotes(version: string, name: string): string {
  const previousTag = getPreviousTag()
  const commits = getReleaseCommits(previousTag)
  const grouped = groupCommits(commits)
  const compareText = previousTag
    ? `Changes since \`${previousTag}\`.`
    : 'Changes included in the first tagged release.'
  const changesSection = grouped.length > 0
    ? grouped.map((g) => `### ${g.title}\n\n${formatCommitList(g.commits)}`).join('\n\n')
    : '### Changes\n\n- No user-facing changes recorded in this release.'

  return `## 🎉 Release v${version}

${compareText}

${changesSection}

### Installation

\`\`\`bash
npm install ${name}@${version}
# or
bun add ${name}@${version}
\`\`\``
}

async function main() {
  const { name, version, repositorySlug } = getPackageInfo()
  const tagName = `v${version}`

  console.log(`\n🚀 Releasing ${name}@${version}`)

  runCommand(`git tag ${tagName} -m "Release ${tagName}"`, `Creating git tag ${tagName}`)
  runCommand(`git push origin ${tagName}`, `Pushing tag ${tagName}`)

  console.log('\n📝 Creating GitHub release...')
  const releaseNotes = generateReleaseNotes(version, name)
  const notesFile = `/tmp/release-notes-${version}.md`
  writeFileSync(notesFile, releaseNotes)

  try {
    execSync(`gh release create ${tagName} --title "v${version}" --notes-file ${notesFile}`, { stdio: 'inherit' })
    console.log(`✓ GitHub release created: https://github.com/${repositorySlug}/releases/tag/${tagName}`)
  } catch {
    console.warn('⚠️  GitHub release creation failed (may already exist)')
  }

  runCommand('npm publish --ignore-scripts', 'Publishing to npm')
  console.log(`\n✅ ${name}@${version} released!`)
  console.log(`   npm: https://www.npmjs.com/package/${name}`)
  console.log(`   GitHub: https://github.com/${repositorySlug}/releases/tag/${tagName}`)
}

main().catch((error) => {
  console.error('\n❌ Release failed:', error.message)
  process.exit(1)
})
