# Kiro Mobile Bridge

A lightweight mobile interface that lets you monitor and control Kiro IDE agent sessions from your phone over LAN, with a live preview of chat, tasks, and code via Chrome DevTools Protocol.

<img width="1829" height="1065" alt="Untitled design (4)" src="https://github.com/user-attachments/assets/d548c43b-4501-4d66-aed7-ad021a44f9cb" />


## Features

- 📱 Mobile-optimized web interface with tab navigation
- 🔑 **OTP Authentication** - 6-digit access code generated on server startup
- 💬 **Chat** - View and send messages to Kiro's agent
- 📎 **Image Attachments** - Attach single or multiple images from your phone's camera/gallery directly into Kiro's chat
- 📝 **Code** - Browse file explorer and view files with syntax highlighting
- 📋 **Tasks** - View and navigate Kiro spec task files
- 🔄 Real-time updates via WebSocket with adaptive polling
- 🛡️ **Crash-resistant** - Server stays alive through CDP disconnects, network drops, and Kiro reloads

## Prerequisites

- **Node.js** 18+ (uses ES modules)
- **Kiro IDE** 

## Quick Start

### 1. Open your target project on Kiro and then close Kiro.
The bridge needs an workspace session to detect and connect to.

### 2. Start Kiro from the terminal to enable CDP

Open Kiro with the remote debugging port enabled:

**Run Kiro with debugging port on CMD/Terminal:**
```bash
kiro --remote-debugging-port=9000
```

### 3. Run with npx (Recommended)

Start the bridge server inside the Kiro terminal 

```bash
npx github:kgns/kiro-mobile-bridge
```

#### Alternative: Clone and Run

```bash
git clone https://github.com/kgns/kiro-mobile-bridge.git
cd kiro-mobile-bridge
npm install
npm start
```

You'll see output like:

```
Kiro Mobile Bridge
─────────────────────
Local:   http://localhost:3050
Network: http://192.168.16.106:3050

🔑 Access Code: 847291

Enter this code on your device to connect.
```

### 4. Open on Your Phone

1. Make sure your phone is on the **same WiFi network** as your computer
2. Open the **Network URL** (e.g., `http://192.168.1.100:3050`) in your phone's browser
3. Enter the **6-digit access code** shown in the terminal
4. The interface will connect and show your Kiro session
5. Use the tabs to switch between Chat, Code, and Tasks panels

> **Note:** The access code stays valid until you restart the server. You can enter it again to reconnect (for example after your phone's browser closes) and from more than one device. Restart the server to rotate the code and end all sessions.

#### Enable Authentication

For untrusted environments where you want the pin code auth experience:

```bash
npx kiro-mobile-bridge --auth
```


#### How It Works

```
┌─────────────────┐     CDP      ┌─────────────────┐
│   Kiro IDE      │◄────────────►│  Bridge Server  │
│ (port 9000-9003)│              │   (port 3050)   │
└─────────────────┘              └────────┬────────┘
                                          │
                                   HTTP + WebSocket
                                          │
                                 ┌────────▼────────┐
                                 │  Mobile Client  │
                                 │   (browser)     │
                                 └─────────────────┘
```

1. **Discovery**: Server scans ports 9000-9003, 9222, 9229 for Kiro instances (adaptive: 10s → 30s when stable)
2. **Connection**: Connects to Kiro via CDP WebSocket
3. **Snapshots**: Captures chat, editor, and tasks with adaptive polling (1s active → 3s idle)
4. **Messages**: Injects text into Kiro's chat input via CDP

## Troubleshooting

#### "No sessions available"

- Make sure Kiro is running with `--remote-debugging-port=9000`
- Check that Kiro has a chat/agent session open
- Wait a few seconds for discovery 

#### Can't connect from phone

- Ensure phone and computer are on the **same network**
- Check your firewall allows connections on port 3050
- Try the IP address shown in the server output (not `localhost`)

#### Windows: Works on your computer but not on mobile, even on same WiFi.

**Root Cause:** Node.js firewall rule only allows **Public** networks by default. If your network is set to **Private**, mobile devices can't connect.

**Quick Fix - Option 1: Change Network to Public (Easiest)**
1. Open **Settings** → **Network & Internet**
2. Click your connection (WiFi or Ethernet)
3. Under "Network profile type", select **Public network (Recommended)**
4. Try accessing from mobile again

**Quick Fix - Option 2: Update Firewall Rule (Better for home networks)**

Run this command **as Administrator** (Win + X → Terminal Admin):
```cmd
netsh advfirewall firewall set rule name="Node.js JavaScript Runtime" new profile=private,public
```

#### Linux: Firewall blocking connections

If you're on Linux and can't connect from your phone, your firewall may be blocking port 3050. Allow it with:

```bash
# UFW (Ubuntu, Arch, etc.)
sudo ufw allow 3050/tcp

# Or with iptables directly
sudo iptables -A INPUT -p tcp --dport 3050 -j ACCEPT
```

## Security Notes

#### OTP Authentication
- Use `--auth` to enable authentication for untrusted environments
- A **6-digit access code** is generated on each server startup and displayed in the terminal
- The code stays valid until the server restarts — you can enter it again to reconnect (e.g. after your phone's browser is closed and reopened) and from more than one device
- Failed attempts are **rate limited** — after 5 wrong codes, the login page locks for 60 seconds
- Sessions use **HttpOnly cookies** — tokens are not exposed to client-side JavaScript
- Restart the server whenever you want to invalidate the current code and all active sessions

## Stability

The server is hardened to stay alive through all common failure scenarios:

- **Unhandled exceptions/rejections** — logged and swallowed, process stays alive
- **CDP disconnects** — gracefully cleaned up, discovery loop auto-reconnects
- **WebSocket drops** — ping/pong keepalive (30s) detects dead connections; broadcasts are wrapped in try/catch
- **Concurrent polling** — reentrancy guards prevent race conditions when async operations overlap
- **Route errors** — all critical endpoints (`/send`, `/click`, `/inject-file`, `/upload-base64`) have try/catch
- **HTTP/WebSocket server errors** — handled at the server level

You should never need to restart the bridge unless you restart Kiro itself with a different debugging port.

## Auto-Start on Boot (Windows)

To run the bridge automatically when your machine starts:

**Option 1: Windows Startup Folder**

1. Press `Win + R`, type `shell:startup`, hit Enter
2. Create a file `kiro-mobile-bridge.bat` there with:
```bat
@echo off
cd /d E:\Experiements\kiro-mobile-bridge
npm start
```

**Option 2: Task Scheduler (Hidden)**

```cmd
schtasks /create /tn "KiroMobileBridge" /tr "cmd /c cd /d E:\Experiements\kiro-mobile-bridge && npm start --" /sc onlogon /rl highest
```

To remove: `schtasks /delete /tn "KiroMobileBridge" /f`

> **Note:** Kiro must also be started with `--remote-debugging-port=9000` for the bridge to connect.

## License

MIT
