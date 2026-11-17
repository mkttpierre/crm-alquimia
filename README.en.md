# CRM ALQUIM(IA)

[🇧🇷 Português](README.md) · 🇺🇸 English · [🇪🇸 Español](README.es.md)

Open-source CRM with WhatsApp (QR code) and AI agents that runs entirely on your own computer with one command. It was born as a fork of another MIT-licensed project, credited in [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE).

**The full instructions are in Portuguese.** Install, update, backup and restore are described in [README.md](README.md). The short version:

- install: `bash scripts/instalar.sh` (Linux, macOS, Git Bash) or `powershell -ExecutionPolicy Bypass -File scripts\instalar.ps1` (Windows);
- update: download the new version and run the installer again (it keeps the database, connections and secrets);
- stop: `bash scripts/parar.sh` or `scripts\parar.ps1`;
- backup and restore: `bash scripts/backup.sh` and `bash scripts/restaurar.sh` (or `scripts\backup.ps1` and `scripts\restaurar.ps1` with `powershell -ExecutionPolicy Bypass -File`); the CRM must be running;
- **the first account becomes the owner of the server.** The installer publishes the app only on `127.0.0.1`: create your account before exposing the CRM to the internet (proxy, tunnel, public port), and then check in `/admin` that you are the one listed there.
- **network:** the local Supabase (API 54321, database 54322) accepts connections from your whole local network, and the database uses the CLI's well-known default password. On a network that is not only yours, anyone on it can read and change all CRM data. Use a trusted network or block those two ports for inbound connections (see [SECURITY.md](SECURITY.md)).
