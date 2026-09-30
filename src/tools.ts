import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ToolExecutionContext {
	requestWriteApproval: (filePath: string, content: string) => Promise<boolean>;
	requestCommandApproval: (command: string) => Promise<boolean>;
}

export interface ToolExecutionResult {
	content: string;
	isError?: boolean;
}

const DEFAULT_EXCLUDE = '**/{node_modules,.git,dist,out,.vscode-test}/**';
const MAX_LIST_RESULTS = 200;
const MAX_READ_BYTES = 200_000;
const MAX_COMMAND_OUTPUT = 50_000;
const COMMAND_TIMEOUT_MS = 60_000;

// The `tools` schema sent to Anthropic (names, descriptions, input_schema)
// lives in server/src/index.js, since only the server talks to Anthropic.
// The tool names below (list_files, read_file, write_file, run_command)
// must match that schema exactly.

function runShellCommand(command: string, cwd: string): Promise<ToolExecutionResult> {
	return new Promise((resolve) => {
		cp.exec(
			command,
			{ cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
			(error, stdout, stderr) => {
				let combined = stdout || '';
				if (stderr) {
					combined += (combined ? '\n' : '') + `[stderr]\n${stderr}`;
				}
				const truncated = combined.length > MAX_COMMAND_OUTPUT;
				const text = truncated ? `${combined.slice(0, MAX_COMMAND_OUTPUT)}\n\n[output truncated]` : combined;

				if (error) {
					const timedOut = Boolean((error as cp.ExecException & { killed?: boolean }).killed) && error.signal;
					const prefix = timedOut
						? `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.\n`
						: `Command exited with code ${error.code ?? 'unknown'}.\n`;
					resolve({ content: prefix + (text || '(no output)'), isError: true });
					return;
				}
				resolve({ content: text || '(no output)' });
			},
		);
	});
}

function getWorkspaceRoot(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** Resolves a workspace-relative path, rejecting anything that escapes the workspace root. */
function resolveSafePath(root: vscode.Uri, relativePath: string): vscode.Uri | undefined {
	const resolved = path.resolve(root.fsPath, relativePath);
	const rel = path.relative(root.fsPath, resolved);
	if (rel.startsWith('..') || path.isAbsolute(rel)) {
		return undefined;
	}
	return vscode.Uri.joinPath(root, rel.split(path.sep).join('/'));
}

export async function executeTool(
	name: string,
	input: Record<string, unknown> | undefined,
	ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
	const root = getWorkspaceRoot();
	if (!root) {
		return { content: 'No workspace folder is open in VS Code.', isError: true };
	}

	try {
		if (name === 'list_files') {
			const pattern = typeof input?.pattern === 'string' && input.pattern.trim() ? input.pattern.trim() : '**/*';
			const uris = await vscode.workspace.findFiles(pattern, DEFAULT_EXCLUDE, MAX_LIST_RESULTS);
			const rels = uris.map((u) => path.relative(root.fsPath, u.fsPath).split(path.sep).join('/')).sort();
			return { content: rels.length ? rels.join('\n') : '(no files matched)' };
		}

		if (name === 'read_file') {
			const rawPath = input?.path;
			if (typeof rawPath !== 'string' || !rawPath.trim()) {
				return { content: 'Missing "path" argument.', isError: true };
			}
			const uri = resolveSafePath(root, rawPath);
			if (!uri) {
				return { content: `Path "${rawPath}" is outside the workspace and cannot be read.`, isError: true };
			}
			const bytes = await vscode.workspace.fs.readFile(uri);
			const truncated = bytes.byteLength > MAX_READ_BYTES;
			const text = Buffer.from(bytes.slice(0, MAX_READ_BYTES)).toString('utf8');
			return { content: truncated ? `${text}\n\n[truncated, file is larger than ${MAX_READ_BYTES} bytes]` : text };
		}

		if (name === 'write_file') {
			const rawPath = input?.path;
			const content = input?.content;
			if (typeof rawPath !== 'string' || !rawPath.trim() || typeof content !== 'string') {
				return { content: 'Missing "path" or "content" argument.', isError: true };
			}
			const uri = resolveSafePath(root, rawPath);
			if (!uri) {
				return { content: `Path "${rawPath}" is outside the workspace and cannot be written.`, isError: true };
			}
			const approved = await ctx.requestWriteApproval(rawPath, content);
			if (!approved) {
				return { content: 'The user rejected this file write.', isError: true };
			}
			await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
			return { content: `Wrote ${content.length} characters to ${rawPath}.` };
		}

		if (name === 'run_command') {
			const command = input?.command;
			if (typeof command !== 'string' || !command.trim()) {
				return { content: 'Missing "command" argument.', isError: true };
			}
			const approved = await ctx.requestCommandApproval(command);
			if (!approved) {
				return { content: 'The user rejected running this command.', isError: true };
			}
			return runShellCommand(command, root.fsPath);
		}

		return { content: `Unknown tool "${name}".`, isError: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { content: `Tool "${name}" failed: ${message}`, isError: true };
	}
}
