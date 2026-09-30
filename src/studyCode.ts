import * as vscode from 'vscode';

const SECRET_KEY = 'skillbench.studyCode';

export async function getStudyCode(context: vscode.ExtensionContext): Promise<string | undefined> {
	return context.secrets.get(SECRET_KEY);
}

export async function setStudyCode(context: vscode.ExtensionContext): Promise<string | undefined> {
	const code = await vscode.window.showInputBox({
		title: 'SkillBench: Study Code',
		prompt: 'Enter the study access code given to you by the researcher',
		password: true,
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim().length === 0 ? 'Study code cannot be empty' : undefined),
	});
	if (!code) {
		return undefined;
	}
	await context.secrets.store(SECRET_KEY, code.trim());
	vscode.window.showInformationMessage('SkillBench: Study code saved.');
	return code.trim();
}

export async function ensureStudyCode(context: vscode.ExtensionContext): Promise<string | undefined> {
	const existing = await getStudyCode(context);
	if (existing) {
		return existing;
	}
	const choice = await vscode.window.showInformationMessage(
		'SkillBench needs a study code before it can start a session.',
		'Enter Study Code',
	);
	if (choice !== 'Enter Study Code') {
		return undefined;
	}
	return setStudyCode(context);
}

export async function clearStudyCode(context: vscode.ExtensionContext): Promise<void> {
	await context.secrets.delete(SECRET_KEY);
	vscode.window.showInformationMessage('SkillBench: Study code removed.');
}
