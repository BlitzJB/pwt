# PWT

Persistent Web Terminal. Access your terminal from any browser. Sessions survive server restarts.

## Install

```bash
npm install -g persistent-web-terminal
```

Requires [dtach](https://github.com/crigler/dtach) (`brew install dtach` on macOS).

## Usage

```bash
pwt                 # Start server
pwt -p 1234         # Set 4-10 digit PIN
pwt -p              # Remove PIN
pwt -t              # Enable ngrok tunnel
pwt -c              # Prevent system sleep (macOS)
pwt -tc             # Combine flags
```

## Features

- Sessions persist across server restarts (via dtach)
- Multi-session support with tabs
- PIN authentication (MPIN-style keypad)
- ngrok tunneling for remote access
- Mobile-friendly with modifier key bar
- QR code for quick mobile access

## Config

Stored in `~/.web-terminal/`:
- `config.json` - ngrok token, PIN hash
- `sessions/` - session metadata
- `sockets/` - dtach sockets

## License

MIT
