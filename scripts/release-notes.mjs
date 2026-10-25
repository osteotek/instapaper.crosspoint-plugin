// Prints the CHANGELOG.md section for a version: `node scripts/release-notes.mjs 1.0.3`.
// The release workflow uses it for the GitHub Release notes.
import { readFile } from 'node:fs/promises';

export async function releaseNotes(version) {
  const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const sections = changelog.split(/^## /m).slice(1);
  const section = sections.find((s) => s.split('\n')[0].trim() === version);
  if (!section) throw new Error('CHANGELOG.md has no "## ' + version + '" section');
  return section.slice(section.indexOf('\n') + 1).trim() + '\n';
}

if (import.meta.url === 'file://' + process.argv[1]) {
  process.stdout.write(await releaseNotes(process.argv[2]));
}
