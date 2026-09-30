import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('activation registers the SkillBench commands', async () => {
		const extension = vscode.extensions.getExtension('sagelab.skillbench');
		if (extension && !extension.isActive) {
			await extension.activate();
		}

		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('skillbench.startSession'));
		assert.ok(commands.includes('skillbench.setStudyCode'));
		assert.ok(commands.includes('skillbench.clearStudyCode'));
	});
});
