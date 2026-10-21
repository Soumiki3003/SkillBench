const fs = require('fs');
const path = require('path');

function unquote(value) {
	const trimmed = value.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1).replace(/\\"/g, '"');
	}
	return trimmed;
}

function parseSkillFile(id, raw) {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) {
		return undefined;
	}
	const [, frontmatter, body] = match;
	let name = id;
	let description = '';
	for (const line of frontmatter.split(/\r?\n/)) {
		const fieldMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
		if (!fieldMatch) {
			continue;
		}
		const [, key, value] = fieldMatch;
		if (key === 'name') {
			name = unquote(value);
		} else if (key === 'description') {
			description = unquote(value);
		}
	}
	return { id, name, description, systemPrompt: body.trim() };
}

/**
 * Loads every skill from `<skillsDir>/<id>/SKILL.md`, sorts them by id, and
 * assigns each a blinded "Condition A", "Condition B", ... label so the
 * client never has to see (or be able to extract) the real skill name or
 * research description.
 */
function loadSkills(skillsDir) {
	if (!fs.existsSync(skillsDir)) {
		throw new Error(`Skills directory not found: ${skillsDir}`);
	}
	const skills = [];
	for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
		if (!fs.existsSync(skillFile)) {
			continue;
		}
		const raw = fs.readFileSync(skillFile, 'utf8');
		const skill = parseSkillFile(entry.name, raw);
		if (skill) {
			skills.push(skill);
		}
	}
	skills.sort((a, b) => a.id.localeCompare(b.id));

	const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	skills.forEach((skill, index) => {
		skill.label = `Condition ${letters[index] ?? index + 1}`;
	});

	return skills;
}

/**
 * Appends the shared `INITIAL_VIEW` task configuration to every skill whose
 * prompt refers to it, so all of those conditions start from the identical
 * sentence. Throws if any skill needs it and none was given, so a session
 * can never run those conditions without it.
 */
function applyInitialView(skills, initialView) {
	const needsIt = skills.filter((skill) => skill.systemPrompt.includes('INITIAL_VIEW'));
	const value = (initialView || '').trim();
	if (needsIt.length > 0 && !value) {
		throw new Error(`INITIAL_VIEW is not set, but these skills require it: ${needsIt.map((s) => s.id).join(', ')}`);
	}
	for (const skill of needsIt) {
		skill.systemPrompt += `\n\nTask configuration:\nINITIAL_VIEW: ${value}`;
	}
	return needsIt;
}

module.exports = { loadSkills, applyInitialView };
