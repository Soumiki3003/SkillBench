# SkillBench

SkillBench is a VS Code extension for running Claude-based debugging sessions under different feedback conditions, and exporting the resulting transcripts for research analysis.

It's built as two pieces:

- **The extension** (this package) — installable by anyone, contains no secrets and no skill definitions. It shows a blinded picker ("Condition A".."Condition H"), chats with Claude through your server, and exports transcripts to Markdown.
- **The server** (`server/`, see its own README) — a small backend *you* host. It holds your real Anthropic API key and the real skill definitions (`.claude/skills/*/SKILL.md`), and is the only thing that ever talks to Anthropic. Participants never see your key or the skills' real names/descriptions.

This split means you can publish the extension to the Marketplace for participants to install, without handing out your Anthropic API key or revealing which condition is which.

## For participants

1. Install the extension.
2. Set `skillbench.serverUrl` (Settings) to the URL your researcher gave you.
3. Run **SkillBench: Set Study Code** and enter the access code your researcher gave you.
4. Run **SkillBench: Start Session**, pick a condition from the list, and chat.
5. Click **Export transcript** in the panel to save the conversation as Markdown, and send it to your researcher.

## For researchers

See `server/README.md` for deployment instructions (written for a Hostinger-style Ubuntu VPS, but works anywhere Node.js runs). In short:

1. Deploy `server/` with your `ANTHROPIC_API_KEY` and a `STUDY_CODE` in its environment, behind HTTPS.
2. Give participants the server's public URL and the study code.
3. Rotate `STUDY_CODE` any time you want to cut off access.

The `.claude/skills/*/SKILL.md` files at the repo root are the ground truth for the 8 conditions — edit them and restart the server to change what participants experience. They are **not** bundled into the extension package (see `.vscodeignore`), so installing the extension never exposes them.

## Extension settings

- `skillbench.serverUrl`: base URL of your SkillBench server.

## Commands

- `SkillBench: Start Session`
- `SkillBench: Set Study Code`
- `SkillBench: Clear Study Code`

## Release Notes

### 0.0.1

Initial release: server-mediated chat (no client-side API key), blinded condition picker, Markdown transcript export.
