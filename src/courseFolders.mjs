import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, exists, safeName } from './utils.mjs';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function canonicalCourseBaseName(name, id) {
  let value = String(name || `Course ${id}`).replace(/\s+/g, ' ').trim();

  // Some institutions append section identifiers and duplicate term text to
  // the same org-unit name through different Brightspace discovery paths.
  // Strip a common section-code shape so both paths resolve to one stable name.
  value = value.replace(/(?:,\s*|\s+-\s+)\d{4}-[A-Z]{2,8}-\d{3}-\d{2}-\d+.*$/i, '').trim();

  // Defensive cleanup for alternate Brightspace strings that append a second
  // term / end-date segment without the section identifier.
  value = value.replace(/,\s*(?:Fall|Spring|Summer|Winter)\s+\d{4}(?:,\s*Ends\b.*)?$/i, '').trim();

  return safeName(value, `Course ${id}`);
}

export function canonicalCourseStowDir(course) {
  return `${canonicalCourseBaseName(course?.name, course?.id)} [${course?.id}]`;
}

async function countFiles(dir) {
  let count = 0;
  let bytes = 0;
  async function walk(current) {
    let entries = [];
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        count += 1;
        try { bytes += (await fs.stat(full)).size; } catch {}
      }
    }
  }
  await walk(dir);
  return { count, bytes };
}

async function copyNewerFile(source, target) {
  const sourceStat = await fs.stat(source);
  let shouldCopy = true;
  try {
    const targetStat = await fs.stat(target);
    // Prefer the newer copy when both duplicate trees contain the same path.
    shouldCopy = sourceStat.mtimeMs > targetStat.mtimeMs + 1;
  } catch {}
  if (!shouldCopy) return;
  await ensureDir(path.dirname(target));
  await fs.copyFile(source, target);
  try { await fs.utimes(target, sourceStat.atime, sourceStat.mtime); } catch {}
}

async function mergeTree(source, target) {
  await ensureDir(target);
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) await mergeTree(src, dst);
    else await copyNewerFile(src, dst);
  }
}

export async function resolveCourseDirectory(outputDir, course) {
  const id = String(course.id);
  const canonicalName = canonicalCourseStowDir(course);
  const canonicalPath = path.join(outputDir, canonicalName);
  const idPattern = new RegExp(`\\[${escapeRegex(id)}\\]$`);

  let entries = [];
  try { entries = await fs.readdir(outputDir, { withFileTypes: true }); } catch {}
  const matches = entries
    .filter(entry => entry.isDirectory() && idPattern.test(entry.name))
    .map(entry => ({ name: entry.name, path: path.join(outputDir, entry.name) }));

  // No prior folder for this org unit: start with the deterministic canonical name.
  if (!matches.length) {
    await ensureDir(canonicalPath);
    return { mirrorDir: canonicalName, courseDir: canonicalPath, courseWasNew: true, migrated: [] };
  }

  let migrated = [];

  // If the deterministic name does not exist yet, rename the richest existing
  // tree into place. This preserves the deep Full-sync folder instead of choosing
  // a newer but lightweight Quick-sync duplicate.
  if (!(await exists(canonicalPath))) {
    const scored = [];
    for (const match of matches) scored.push({ ...match, ...(await countFiles(match.path)) });
    scored.sort((a, b) => (b.count - a.count) || (b.bytes - a.bytes));
    const winner = scored[0];
    await fs.rename(winner.path, canonicalPath);
    migrated.push({ from: winner.name, to: canonicalName, action: 'renamed' });
  }

  // Merge every other same-ID tree into the canonical folder, then remove the
  // duplicate. Newer overlapping files win; unique deep-content files are kept.
  entries = await fs.readdir(outputDir, { withFileTypes: true });
  const duplicates = entries
    .filter(entry => entry.isDirectory() && entry.name !== canonicalName && idPattern.test(entry.name))
    .map(entry => ({ name: entry.name, path: path.join(outputDir, entry.name) }));

  for (const duplicate of duplicates) {
    await mergeTree(duplicate.path, canonicalPath);
    await fs.rm(duplicate.path, { recursive: true, force: true });
    migrated.push({ from: duplicate.name, to: canonicalName, action: 'merged-and-removed' });
  }

  return { mirrorDir: canonicalName, courseDir: canonicalPath, courseWasNew: false, migrated };
}
