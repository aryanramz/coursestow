import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ensureMirrorLayout } from './migration.mjs';
import { chooseActiveTerms, enrichCoursesWithTerms } from './terms.mjs';
import { writeProjectViews } from './status.mjs';

const courses = enrichCoursesWithTerms([
  { id: '1', name: 'Example Course A - Fall 2026' },
  { id: '2', name: 'Example Course B - Spring 2027' },
  { id: '3', name: 'Example Course C - Summer 2026' }
]);
assert.deepEqual(chooseActiveTerms(courses, {}, new Date('2026-08-26T12:00:00')).map(t => t.key), ['2026-Fall']);
assert.deepEqual(chooseActiveTerms(courses, {}, new Date('2026-12-20T12:00:00')).map(t => t.key), ['2026-Fall', '2027-Spring']);
assert.deepEqual(chooseActiveTerms(courses, { activeTerms: ['2027-Spring'] }, new Date('2026-08-26T12:00:00')).map(t => t.key), ['2027-Spring']);

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brightspace-v17-'));
const stateDir = `${root}-state`;
try {
  const folder = path.join(root, 'Example Course A - Fall 2026 [10001]');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, '_course.json'), JSON.stringify({ id: '10001', name: 'Example Course A - Fall 2026' }));
  await fs.mkdir(path.join(root, '_changes'), { recursive: true });
  await fs.writeFile(path.join(root, '_changes', 'latest.json'), '{}');
  await fs.writeFile(path.join(root, '_sync_state.json'), '{"lastFullSync":"legacy"}');

  const first = await ensureMirrorLayout({ outputDir: root, stateDir, currentTerm: null }, '1.7.0');
  assert.ok(first.actions.some(x => x.action === 'move-course-to-term'));
  const courseDir = path.join(root, '2026-Fall', 'Example Course A - Fall 2026 [10001]');
  await fs.access(path.join(courseDir, '_course.json'));
  await fs.access(path.join(root, '_system', 'changes', 'latest.json'));
  await fs.access(path.join(stateDir, 'state.json'));
  await assert.rejects(fs.access(path.join(root, '_system', 'state.json')));

  await fs.writeFile(path.join(courseDir, '_sync_state.json'), '{"lastFullSync":"legacy-course-state"}');
  const term = { season: 'Fall', year: 2026, label: 'Fall 2026', key: '2026-Fall' };
  await writeProjectViews({ outputDir: root, stateDir, systemDir: first.systemDir }, {
    schemaVersion: 2,
    activeTerms: [term],
    discoveredTerms: [term],
    discoveredCourses: 1,
    courses: [{
      id: '10001', name: 'Example Course A - Fall 2026', term,
      mirrorDir: path.basename(courseDir), mirrorPath: `2026-Fall/${path.basename(courseDir)}`,
      courseDir, homeUrl: 'https://example.invalid/course/10001'
    }]
  }, [], 'quick', '2026-09-01T12:00:00.000Z');
  const courseState = JSON.parse(await fs.readFile(path.join(stateDir, 'courses', '10001.json'), 'utf8'));
  assert.equal(courseState.lastFullSync, 'legacy-course-state');
  assert.equal(courseState.lastQuickSync, '2026-09-01T12:00:00.000Z');
  await assert.rejects(fs.access(path.join(root, '_system', 'state.json')));

  const second = await ensureMirrorLayout({ outputDir: root, stateDir, currentTerm: null }, '1.7.0');
  assert.equal(second.actions.length, 0);
  console.log('CourseStow mirror/runtime state self-test: PASS');
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(stateDir, { recursive: true, force: true });
}
