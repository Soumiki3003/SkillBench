require('dotenv').config();

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { loadSkills } = require('./skills');

const PORT = process.env.PORT || 3000;
const STUDY_CODE = process.env.STUDY_CODE;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const ANTHROPIC_MAX_TOKENS = parseInt(process.env.ANTHROPIC_MAX_TOKENS || '4096', 10);
const SKILLS_DIR = process.env.SKILLS_DIR || path.join(__dirname, '..', '..', '.claude', 'skills');

if (!STUDY_CODE) {
	console.error('STUDY_CODE is not set. Refusing to start: every request would be rejected anyway.');
	process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
	console.error('ANTHROPIC_API_KEY is not set.');
	process.exit(1);
}

const skills = loadSkills(SKILLS_DIR);
if (skills.length === 0) {
	console.error(`No skills found in ${SKILLS_DIR}`);
	process.exit(1);
}

console.log('Loaded skills (this mapping is never sent to clients):');
for (const skill of skills) {
	console.log(`  ${skill.label} -> ${skill.id} (${skill.name})`);
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Tool schema offered to the model. Tool *execution* happens client-side, in
// the extension (src/tools.ts), since only it has access to the
// participant's open workspace. These three names must match that file.
const TOOLS = [
	{
		name: 'list_files',
		description:
			"List files in the user's open workspace matching a glob pattern. Use this to discover file paths before reading them.",
		input_schema: {
			type: 'object',
			properties: {
				pattern: {
					type: 'string',
					description: 'Glob pattern relative to the workspace root, e.g. "**/*.ts" or "src/**". Defaults to "**/*".',
				},
			},
		},
	},
	{
		name: 'read_file',
		description: "Read the full text contents of a file in the user's open workspace.",
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path relative to the workspace root.' },
			},
			required: ['path'],
		},
	},
	{
		name: 'write_file',
		description:
			"Create or overwrite a file in the user's open workspace with new full contents. The user must approve this before it is applied.",
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path relative to the workspace root.' },
				content: { type: 'string', description: 'The full new contents of the file.' },
			},
			required: ['path', 'content'],
		},
	},
	{
		name: 'run_command',
		description:
			"Run a shell command in the user's open workspace (e.g. to run tests, install packages, or inspect the project). The user must approve each command before it runs, and its combined stdout/stderr is returned.",
		input_schema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The shell command to run.' },
			},
			required: ['command'],
		},
	},
];

// Simple in-memory sliding-window rate limit per study code, since a single
// shared code is meant to be used by many participants but should not allow
// unbounded spend against the Anthropic key. Higher than a plain chat limit
// because a single user turn can now involve several tool round-trips.
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const requestLog = new Map();

function isRateLimited(code) {
	const now = Date.now();
	const timestamps = (requestLog.get(code) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
	timestamps.push(now);
	requestLog.set(code, timestamps);
	return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
	res.json({ ok: true });
});

app.get('/api/skills', (req, res) => {
	if (req.query.code !== STUDY_CODE) {
		res.status(401).json({ error: 'Invalid study code' });
		return;
	}
	res.json({ skills: skills.map((s) => ({ id: s.id, label: s.label })) });
});

function isValidMessages(messages) {
	if (!Array.isArray(messages)) {
		return false;
	}
	return messages.every((m) => {
		if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
			return false;
		}
		if (typeof m.content === 'string') {
			return true;
		}
		return Array.isArray(m.content) && m.content.every((block) => block && typeof block.type === 'string');
	});
}

// Streams one model turn back as newline-delimited JSON: any number of
// {"type":"text_delta","text":...} lines as the response is generated,
// followed by exactly one {"type":"final","content":[...],"stop_reason":...}
// line carrying the complete Anthropic content blocks — including any
// tool_use blocks, which the extension must execute and reply to in a
// follow-up request — or one {"type":"error","message":...} line.
app.post('/api/chat', async (req, res) => {
	const { code, skillId, messages } = req.body || {};

	if (code !== STUDY_CODE) {
		res.status(401).json({ error: 'Invalid study code' });
		return;
	}
	if (isRateLimited(code)) {
		res.status(429).json({ error: 'Rate limit exceeded, try again later' });
		return;
	}
	const skill = skills.find((s) => s.id === skillId);
	if (!skill) {
		res.status(400).json({ error: 'Unknown skillId' });
		return;
	}
	if (!isValidMessages(messages)) {
		res.status(400).json({ error: 'Invalid messages' });
		return;
	}

	res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
	res.setHeader('Transfer-Encoding', 'chunked');

	try {
		const stream = client.messages.stream({
			model: ANTHROPIC_MODEL,
			max_tokens: ANTHROPIC_MAX_TOKENS,
			system: skill.systemPrompt,
			tools: TOOLS,
			messages,
		});

		stream.on('text', (delta) => {
			res.write(JSON.stringify({ type: 'text_delta', text: delta }) + '\n');
		});

		const finalMessage = await stream.finalMessage();
		res.write(JSON.stringify({ type: 'final', content: finalMessage.content, stop_reason: finalMessage.stop_reason }) + '\n');
		res.end();
	} catch (err) {
		console.error('Anthropic request failed:', err instanceof Error ? err.message : err);
		res.write(JSON.stringify({ type: 'error', message: 'The upstream request failed.' }) + '\n');
		res.end();
	}
});

app.listen(PORT, () => {
	console.log(`SkillBench server listening on port ${PORT}`);
});
