import * as vscode from 'vscode';

export interface TerminalLogEntry {
	terminalName: string;
	command: string;
	output: string;
	exitCode: number | undefined;
	startTime: string;
	endTime?: string;
}

const entries: TerminalLogEntry[] = [];
const inProgress = new Map<vscode.TerminalShellExecution, TerminalLogEntry>();

/**
 * Records every command run in any of the user's VS Code integrated
 * terminals (via the Shell Integration API) so sessions can export what the
 * participant did on the command line, not just the chat. Requires the
 * user's shell to support VS Code shell integration (on by default for
 * bash/zsh/fish/pwsh) — if it's unavailable, this silently captures nothing
 * rather than failing.
 */
export function registerTerminalLogging(context: vscode.ExtensionContext): void {
	if (!vscode.window.onDidStartTerminalShellExecution || !vscode.window.onDidEndTerminalShellExecution) {
		return;
	}

	context.subscriptions.push(
		vscode.window.onDidStartTerminalShellExecution((event) => {
			const entry: TerminalLogEntry = {
				terminalName: event.terminal.name,
				command: event.execution.commandLine.value,
				output: '',
				exitCode: undefined,
				startTime: new Date().toISOString(),
			};
			entries.push(entry);
			inProgress.set(event.execution, entry);

			void (async () => {
				try {
					for await (const chunk of event.execution.read()) {
						entry.output += chunk;
					}
				} catch {
					// Stream ended abnormally; keep whatever output was captured.
				}
			})();
		}),
	);

	context.subscriptions.push(
		vscode.window.onDidEndTerminalShellExecution((event) => {
			const entry = inProgress.get(event.execution);
			if (entry) {
				entry.exitCode = event.exitCode;
				entry.endTime = new Date().toISOString();
				inProgress.delete(event.execution);
			}
		}),
	);
}

/** Returns captured terminal commands that started at or after `sinceIso`, oldest first. */
export function getTerminalEntriesSince(sinceIso: string): TerminalLogEntry[] {
	return entries.filter((e) => e.startTime >= sinceIso);
}
