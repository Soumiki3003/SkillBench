# SkillBench Server

Small backend that proxies the SkillBench VS Code extension to Anthropic's API. It exists so the extension itself never contains your Anthropic API key or the real skill definitions — only this server does.

- `GET /api/skills?code=...` — returns blinded labels (`Condition A`, `Condition B`, ...) for the picker in the extension. Never returns the real skill name, description, or system prompt.
- `POST /api/chat` — body `{ code, skillId, messages }`; validates the study code, looks up the real skill server-side, streams Claude's response back as raw text.

## Deploying on a Hostinger VPS (Ubuntu)

1. **Get Node.js 18+ on the box.**
   ```
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

2. **Copy this project to the VPS**, keeping the relative layout intact (the server reads skills from `../.claude/skills` by default):
   ```
   your-repo/
     .claude/skills/...
     server/
   ```
   e.g. via `git clone` or `scp -r`.

3. **Install dependencies and configure secrets:**
   ```
   cd server
   npm install
   cp .env.example .env
   nano .env   # fill in ANTHROPIC_API_KEY and STUDY_CODE
   ```

4. **Run it under a process manager** (so it restarts on crash/reboot):
   ```
   sudo npm install -g pm2
   pm2 start src/index.js --name skillbench-server
   pm2 save
   pm2 startup   # follow the printed instructions to enable on boot
   ```

5. **Put it behind HTTPS.** The extension's server URL setting must be `https://...` — install nginx + certbot and reverse-proxy to the Node process:
   ```
   sudo apt-get install -y nginx certbot python3-certbot-nginx
   ```
   Nginx site config (`/etc/nginx/sites-available/skillbench`):
   ```
   server {
       server_name skillbench.yourdomain.com;
       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_http_version 1.1;
           proxy_buffering off;          # important: keeps streaming responsive
       }
   }
   ```
   ```
   sudo ln -s /etc/nginx/sites-available/skillbench /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d skillbench.yourdomain.com
   ```

6. **Point the extension at it.** In VS Code settings, set `skillbench.serverUrl` to `https://skillbench.yourdomain.com`, then run **SkillBench: Set Study Code** with the same code you put in `.env`.

## Rotating access

To cut off all participants at once, change `STUDY_CODE` in `.env` and restart (`pm2 restart skillbench-server`). Anyone with the old code is immediately locked out.

## Notes

- Rate limiting is a simple in-memory sliding window (120 requests / 5 minutes per code — higher than a plain chat limit since a single user turn can involve several tool round-trips) — enough to blunt runaway cost from a bug or a single bad actor, not a substitute for real per-participant accounting. Since this is in-memory, it resets on restart and doesn't survive multiple server instances behind a load balancer.
- The server also offers the model a `run_command` tool that executes shell commands in the participant's own workspace. Execution happens client-side in the extension, gated behind an approve/reject prompt shown to the participant — the server only defines the tool schema and relays the model's request.
- The server does not persist conversation transcripts; that stays the extension's job (its "Export transcript" button). If you also want a server-side backup log of every exchange, that's a small addition to `POST /api/chat` but isn't wired up here.
