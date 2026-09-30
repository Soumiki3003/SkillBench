import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';
import { fetchSkills } from './serverClient';
import { ensureServerUrl } from './serverUrl';
import { clearStudyCode, ensureStudyCode, setStudyCode } from './studyCode';
import { registerTerminalLogging } from './terminalLog';

export function activate(context: vscode.ExtensionContext) {
	registerTerminalLogging(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('skillbench.startSession', () => startSession(context)),
		vscode.commands.registerCommand('skillbench.setStudyCode', () => setStudyCode(context)),
		vscode.commands.registerCommand('skillbench.clearStudyCode', () => clearStudyCode(context)),
	);
}

async function startSession(context: vscode.ExtensionContext): Promise<void> {
	const serverUrl = await ensureServerUrl();
	if (!serverUrl) {
		return;
	}

	const code = await ensureStudyCode(context);
	if (!code) {
		return;
	}

	let skills;
	try {
		skills = await fetchSkills(serverUrl, code);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`SkillBench: ${message}`);
		return;
	}
	if (skills.length === 0) {
		vscode.window.showErrorMessage('SkillBench: The server returned no skills.');
		return;
	}

	const picked = await vscode.window.showQuickPick(
		skills.map((skill) => ({ label: skill.label, skill })),
		{
			title: 'SkillBench: Choose a condition',
			placeHolder: 'Select which condition to use for this session',
		},
	);
	if (!picked) {
		return;
	}

	new ChatPanel(context, picked.skill, serverUrl, code);
}

export function deactivate() {}
