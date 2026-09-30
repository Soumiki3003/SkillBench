import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export interface RemoteSkill {
	id: string;
	label: string;
}

export type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: unknown }
	| { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string | ContentBlock[];
}

export interface ChatResult {
	content: ContentBlock[];
	stopReason: string | null;
}

function safeParseError(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body);
		return typeof parsed.error === 'string' ? parsed.error : undefined;
	} catch {
		return undefined;
	}
}

export async function fetchSkills(serverUrl: string, code: string): Promise<RemoteSkill[]> {
	const url = new URL('/api/skills', serverUrl);
	url.searchParams.set('code', code);
	const lib = url.protocol === 'https:' ? https : http;

	return new Promise((resolve, reject) => {
		const req = lib.request(url, { method: 'GET' }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => (body += chunk));
			res.on('end', () => {
				if (res.statusCode !== 200) {
					reject(new Error(safeParseError(body) ?? `Server responded with ${res.statusCode}`));
					return;
				}
				try {
					const parsed = JSON.parse(body) as { skills: RemoteSkill[] };
					resolve(parsed.skills);
				} catch {
					reject(new Error('Server returned an unexpected response.'));
				}
			});
		});
		req.on('error', (err) => reject(new Error(`Could not reach SkillBench server: ${err.message}`)));
		req.end();
	});
}

/**
 * Sends one turn to the server and streams the response back. The server
 * replies with newline-delimited JSON: any number of `text_delta` lines
 * (forwarded live via `onDelta`), followed by exactly one `final` line
 * carrying the complete Anthropic content blocks (including any `tool_use`
 * blocks the caller must execute and reply to), or one `error` line.
 */
export function streamChat(
	serverUrl: string,
	code: string,
	skillId: string,
	messages: ChatMessage[],
	onDelta: (text: string) => void,
): Promise<ChatResult> {
	const url = new URL('/api/chat', serverUrl);
	const lib = url.protocol === 'https:' ? https : http;
	const payload = JSON.stringify({ code, skillId, messages });

	return new Promise((resolve, reject) => {
		const req = lib.request(
			url,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload),
				},
			},
			(res) => {
				if (res.statusCode && res.statusCode >= 400) {
					let body = '';
					res.setEncoding('utf8');
					res.on('data', (chunk: string) => (body += chunk));
					res.on('end', () => {
						reject(new Error(safeParseError(body) ?? `Server responded with ${res.statusCode}`));
					});
					return;
				}

				res.setEncoding('utf8');
				let buffer = '';
				let finalResult: ChatResult | undefined;
				let streamError: string | undefined;

				res.on('data', (chunk: string) => {
					buffer += chunk;
					let newlineIndex: number;
					while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
						const line = buffer.slice(0, newlineIndex);
						buffer = buffer.slice(newlineIndex + 1);
						if (!line.trim()) {
							continue;
						}
						let parsed: { type: string; text?: string; content?: ContentBlock[]; stop_reason?: string | null; message?: string };
						try {
							parsed = JSON.parse(line);
						} catch {
							continue;
						}
						if (parsed.type === 'text_delta' && typeof parsed.text === 'string') {
							onDelta(parsed.text);
						} else if (parsed.type === 'final' && parsed.content) {
							finalResult = { content: parsed.content, stopReason: parsed.stop_reason ?? null };
						} else if (parsed.type === 'error') {
							streamError = parsed.message ?? 'The server reported an error.';
						}
					}
				});

				res.on('end', () => {
					if (streamError) {
						reject(new Error(streamError));
					} else if (finalResult) {
						resolve(finalResult);
					} else {
						reject(new Error('Server closed the connection without a final response.'));
					}
				});
			},
		);
		req.on('error', (err) => reject(new Error(`Could not reach SkillBench server: ${err.message}`)));
		req.write(payload);
		req.end();
	});
}
