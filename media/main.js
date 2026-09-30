(function () {
	const vscode = acquireVsCodeApi();

	const messagesEl = document.getElementById('messages');
	const inputEl = document.getElementById('input');
	const sendBtn = document.getElementById('send-btn');
	const exportBtn = document.getElementById('export-btn');

	let currentAssistantBubble = null;

	function scrollToBottom() {
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function addBubble(role, text) {
		const bubble = document.createElement('div');
		bubble.className = 'bubble ' + role;
		bubble.textContent = text;
		messagesEl.appendChild(bubble);
		scrollToBottom();
		return bubble;
	}

	function addError(text) {
		addBubble('error', text);
	}

	function addToolCallBubble(name, input) {
		let summary;
		try {
			summary = JSON.stringify(input);
		} catch {
			summary = '';
		}
		addBubble('tool', `🔧 ${name}(${summary})`);
	}

	function addToolResultBubble(name, isError, content) {
		const bubble = document.createElement('div');
		bubble.className = 'bubble tool' + (isError ? ' tool-error' : '');

		const header = document.createElement('div');
		header.textContent = isError ? `✗ ${name} failed` : `✓ ${name}`;
		bubble.appendChild(header);

		if (content && content.trim()) {
			const pre = document.createElement('pre');
			pre.textContent = content.length > 2000 ? content.slice(0, 2000) + '\n… (truncated)' : content;
			bubble.appendChild(pre);
		}

		messagesEl.appendChild(bubble);
		scrollToBottom();
	}

	function addApprovalBubble(message) {
		const { kind, id, path, content, command } = message;
		const bubble = document.createElement('div');
		bubble.className = 'bubble approval';

		const label = document.createElement('div');
		label.className = 'approval-label';
		label.textContent = kind === 'command' ? 'Claude wants to run this command:' : `Claude wants to write: ${path}`;
		bubble.appendChild(label);

		const pre = document.createElement('pre');
		const previewText = kind === 'command' ? command : content;
		pre.textContent = previewText.length > 4000 ? previewText.slice(0, 4000) + '\n… (truncated)' : previewText;
		bubble.appendChild(pre);

		const actions = document.createElement('div');
		actions.className = 'approval-actions';
		const approveBtn = document.createElement('button');
		approveBtn.textContent = 'Approve';
		const rejectBtn = document.createElement('button');
		rejectBtn.className = 'secondary';
		rejectBtn.textContent = 'Reject';
		actions.appendChild(approveBtn);
		actions.appendChild(rejectBtn);
		bubble.appendChild(actions);

		function respond(approved) {
			approveBtn.disabled = true;
			rejectBtn.disabled = true;
			bubble.classList.add(approved ? 'approved' : 'rejected');
			vscode.postMessage({ type: 'toolApprovalResponse', id, approved });
		}
		approveBtn.addEventListener('click', () => respond(true));
		rejectBtn.addEventListener('click', () => respond(false));

		messagesEl.appendChild(bubble);
		scrollToBottom();
	}

	function setSending(sending) {
		sendBtn.disabled = sending;
		inputEl.disabled = sending;
	}

	function send() {
		const text = inputEl.value.trim();
		if (!text) {
			return;
		}
		inputEl.value = '';
		addBubble('user', text);
		setSending(true);
		vscode.postMessage({ type: 'send', text });
	}

	sendBtn.addEventListener('click', send);
	inputEl.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	});
	exportBtn.addEventListener('click', () => {
		vscode.postMessage({ type: 'export' });
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		switch (message.type) {
			case 'assistantStart':
				currentAssistantBubble = null;
				break;
			case 'assistantDelta':
				if (!currentAssistantBubble) {
					currentAssistantBubble = addBubble('assistant', '');
				}
				currentAssistantBubble.textContent += message.text;
				scrollToBottom();
				break;
			case 'assistantRoundDone':
				// Text for this round is final, but the conversation may continue
				// with tool calls before the whole turn is done — keep input disabled.
				currentAssistantBubble = null;
				break;
			case 'assistantDone':
				currentAssistantBubble = null;
				setSending(false);
				break;
			case 'toolCall':
				addToolCallBubble(message.name, message.input);
				break;
			case 'toolResult':
				addToolResultBubble(message.name, message.isError, message.content);
				break;
			case 'toolApprovalRequest':
				addApprovalBubble(message);
				break;
			case 'error':
				addError(message.text);
				currentAssistantBubble = null;
				setSending(false);
				break;
		}
	});

	inputEl.focus();
}());
