const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');
const { loadSkills, applyInitialView } = require('./skills');

const skillsDir = path.join(__dirname, '..', '..', '.claude', 'skills');

test('loadSkills parses all 8 SKILL.md files and assigns blinded labels', () => {
	const skills = loadSkills(skillsDir);

	assert.strictEqual(skills.length, 8);

	const labels = new Set();
	for (const skill of skills) {
		assert.ok(skill.id.length > 0);
		assert.ok(skill.name.length > 0, `skill ${skill.id} should have a name`);
		assert.ok(skill.description.length > 0, `skill ${skill.id} should have a description`);
		assert.ok(skill.systemPrompt.length > 0, `skill ${skill.id} should have a non-empty system prompt`);
		assert.match(skill.label, /^Condition [A-H]$/, `skill ${skill.id} should have a blinded label`);
		labels.add(skill.label);
	}
	assert.strictEqual(labels.size, 8, 'every skill should get a distinct blinded label');
});

test('applyInitialView adds the task configuration to the sycophancy skills only', () => {
	const skills = loadSkills(skillsDir);
	const applied = applyInitialView(skills, 'Something is off.');

	assert.deepStrictEqual(applied.map((s) => s.label), ['Condition E', 'Condition F', 'Condition G', 'Condition H']);
	for (const skill of skills) {
		const hasConfig = skill.systemPrompt.endsWith('\n\nTask configuration:\nINITIAL_VIEW: Something is off.');
		assert.strictEqual(hasConfig, applied.includes(skill), `skill ${skill.id}`);
	}
});

test('applyInitialView throws when INITIAL_VIEW is missing or blank', () => {
	assert.throws(() => applyInitialView(loadSkills(skillsDir), undefined), /INITIAL_VIEW is not set/);
	assert.throws(() => applyInitialView(loadSkills(skillsDir), '   '), /INITIAL_VIEW is not set/);
});

test('loadSkills throws when the directory does not exist', () => {
	assert.throws(() => loadSkills(path.join(__dirname, 'does-not-exist')));
});
