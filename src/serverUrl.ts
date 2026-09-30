import * as vscode from 'vscode';

export async function ensureServerUrl(): Promise<string | undefined> {
	const config = vscode.workspace.getConfiguration('skillbench');
	const existing = config.get<string>('serverUrl', '').trim();
	if (existing) {
		return existing;
	}

	const entered = await vscode.window.showInputBox({
		title: 'SkillBench: Server URL',
		prompt: 'Enter the base URL of your SkillBench server (e.g. https://skillbench.yourdomain.com)',
		ignoreFocusOut: true,
		validateInput: (value) => {
			try {
				new URL(value);
				return undefined;
			} catch {
				return 'Enter a valid URL, e.g. https://skillbench.yourdomain.com';
			}
		},
	});
	if (!entered) {
		return undefined;
	}
	await config.update('serverUrl', entered.trim(), vscode.ConfigurationTarget.Global);
	return entered.trim();
}
