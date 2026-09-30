import * as vscode from 'vscode';
import { ChatMessage, ContentBlock, RemoteSkill, streamChat } from './serverClient';
import { getTerminalEntriesSince, TerminalLogEntry } from './terminalLog';
import { executeTool } from './tools';

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

interface TranscriptEntry extends ChatMessage {
	timestamp: string;
}

function renderContentForExport(content: string | ContentBlock[]): string {
	if (typeof content === 'string') {
		return content;
	}
	return content
		.map((block) => {
			if (block.type === 'text') {
				return block.text;
			}
			if (block.type === 'tool_use') {
				return '```tool-call\n' + `${block.name}(${JSON.stringify(block.input)})` + '\n```';
			}
			if (block.type === 'tool_result') {
				return '```tool-result\n' + block.content + '\n```';
			}
			return '';
		})
		.filter((s) => s.length > 0)
		.join('\n\n');
}

const MAX_TOOL_ROUNDS = 20;

type TimelineItem =
	| { kind: 'chat'; timestamp: string; message: TranscriptEntry }
	| { kind: 'terminal'; timestamp: string; entry: TerminalLogEntry };

function renderTerminalEntryForExport(entry: TerminalLogEntry): string {
	const exitLine = entry.exitCode !== undefined ? `\n(exit code ${entry.exitCode})` : '';
	return '```\n' + `$ ${entry.command}\n${entry.output.trimEnd()}${exitLine}` + '\n```';
}

export class ChatPanel {
	private readonly panel: vscode.WebviewPanel;
	private readonly messages: TranscriptEntry[] = [];
	private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
	private readonly sessionStartedAt = new Date().toISOString();
	private disposed = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly skill: RemoteSkill,
		private readonly serverUrl: string,
		private readonly code: string,
	) {
		this.panel = vscode.window.createWebviewPanel(
			'skillbenchChat',
			`SkillBench — ${skill.label}`,
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
			},
		);

		this.panel.webview.html = this.getHtml();

		this.panel.webview.onDidReceiveMessage(
			async (message: { type: string; text?: string; id?: string; approved?: boolean }) => {
				if (message.type === 'send' && message.text) {
					await this.handleUserMessage(message.text);
				} else if (message.type === 'export') {
					await this.exportTranscript();
				} else if (message.type === 'toolApprovalResponse' && message.id) {
					const resolve = this.pendingApprovals.get(message.id);
					if (resolve) {
						this.pendingApprovals.delete(message.id);
						resolve(Boolean(message.approved));
					}
				}
			},
			undefined,
			context.subscriptions,
		);

		this.panel.onDidDispose(() => {
			this.disposed = true;
		});
	}

	private post(message: unknown): void {
		if (!this.disposed) {
			this.panel.webview.postMessage(message);
		}
	}

	private requestWriteApproval(filePath: string, content: string): Promise<boolean> {
		const id = Math.random().toString(36).slice(2);
		this.post({ type: 'toolApprovalRequest', kind: 'write', id, path: filePath, content });
		return new Promise((resolve) => {
			this.pendingApprovals.set(id, resolve);
		});
	}

	private requestCommandApproval(command: string): Promise<boolean> {
		const id = Math.random().toString(36).slice(2);
		this.post({ type: 'toolApprovalRequest', kind: 'command', id, command });
		return new Promise((resolve) => {
			this.pendingApprovals.set(id, resolve);
		});
	}

	private async handleUserMessage(text: string): Promise<void> {
		this.messages.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
		await this.runConversationTurn();
	}

	/** Runs model turns until the assistant stops requesting tools (or the round cap is hit). */
	private async runConversationTurn(): Promise<void> {
		for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
			this.post({ type: 'assistantStart' });

			let result;
			try {
				result = await streamChat(
					this.serverUrl,
					this.code,
					this.skill.id,
					this.messages.map((m) => ({ role: m.role, content: m.content })),
					(delta) => this.post({ type: 'assistantDelta', text: delta }),
				);
			} catch (err) {
				const errText = err instanceof Error ? err.message : String(err);
				this.post({ type: 'error', text: `Request failed: ${errText}` });
				return;
			}

			this.messages.push({ role: 'assistant', content: result.content, timestamp: new Date().toISOString() });
			this.post({ type: 'assistantRoundDone' });

			const toolUses = result.content.filter(
				(block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
			);
			if (toolUses.length === 0) {
				this.post({ type: 'assistantDone' });
				return;
			}

			const resultBlocks: ContentBlock[] = [];
			for (const toolUse of toolUses) {
				this.post({ type: 'toolCall', name: toolUse.name, input: toolUse.input });
				const { content, isError } = await executeTool(
					toolUse.name,
					toolUse.input as Record<string, unknown> | undefined,
					{
						requestWriteApproval: (filePath, fileContent) => this.requestWriteApproval(filePath, fileContent),
						requestCommandApproval: (command) => this.requestCommandApproval(command),
					},
				);
				this.post({ type: 'toolResult', name: toolUse.name, isError: Boolean(isError), content });
				resultBlocks.push({ type: 'tool_result', tool_use_id: toolUse.id, content, is_error: isError });
			}
			this.messages.push({ role: 'user', content: resultBlocks, timestamp: new Date().toISOString() });
		}

		this.post({ type: 'error', text: 'Stopped after too many consecutive tool calls.' });
	}

	private async exportTranscript(): Promise<void> {
		const terminalEntries = getTerminalEntriesSince(this.sessionStartedAt);
		if (this.messages.length === 0 && terminalEntries.length === 0) {
			vscode.window.showWarningMessage('SkillBench: Nothing to export yet.');
			return;
		}

		const defaultName = `skillbench-${this.skill.id}-${Date.now()}.md`;
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const defaultUri = workspaceFolder
			? vscode.Uri.joinPath(workspaceFolder.uri, defaultName)
			: vscode.Uri.file(defaultName);

		const uri = await vscode.window.showSaveDialog({
			defaultUri,
			filters: { Markdown: ['md'] },
		});
		if (!uri) {
			return;
		}

		const lines: string[] = [];
		lines.push('# SkillBench Transcript');
		lines.push('');
		lines.push(`- **Skill id:** \`${this.skill.id}\``);
		lines.push(`- **Exported:** ${new Date().toISOString()}`);
		lines.push('');
		lines.push(
			'_Includes chat messages and any commands run in a VS Code integrated terminal during this session, merged in chronological order._',
		);
		lines.push('');
		lines.push('---');
		lines.push('');

		const timeline: TimelineItem[] = [
			...this.messages.map((message): TimelineItem => ({ kind: 'chat', timestamp: message.timestamp, message })),
			...terminalEntries.map((entry): TimelineItem => ({ kind: 'terminal', timestamp: entry.startTime, entry })),
		];
		timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

		for (const item of timeline) {
			if (item.kind === 'chat') {
				const speaker = item.message.role === 'user' ? 'User' : 'Assistant';
				lines.push(`### ${speaker} — ${item.timestamp}`);
				lines.push('');
				lines.push(renderContentForExport(item.message.content));
				lines.push('');
			} else {
				lines.push(`### Terminal (${item.entry.terminalName}) — ${item.timestamp}`);
				lines.push('');
				lines.push(renderTerminalEntryForExport(item.entry));
				lines.push('');
			}
		}

		await vscode.workspace.fs.writeFile(uri, Buffer.from(lines.join('\n'), 'utf8'));
		vscode.window.showInformationMessage(`SkillBench: Transcript exported to ${uri.fsPath}`);
	}

	private getHtml(): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>SkillBench</title>
</head>
<body>
	<header>
		<h1>${escapeHtml(this.skill.label)}</h1>
		<button id="export-btn">Export transcript</button>
	</header>
	<main id="messages"></main>
	<footer>
		<textarea id="input" placeholder="Type a message…" rows="3"></textarea>
		<button id="send-btn">Send</button>
	</footer>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
