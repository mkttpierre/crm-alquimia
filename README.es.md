# CRM ALQUIM(IA)

[🇧🇷 Português](README.md) · [🇺🇸 English](README.en.md) · 🇪🇸 Español

CRM de código abierto con WhatsApp (código QR) y agentes de IA que corre entero en tu propia computadora con un comando. Nació como fork de otro proyecto con licencia MIT, acreditado en [NOTICE.md](NOTICE.md) y [LICENSE](LICENSE).

**Las instrucciones completas están en portugués.** Instalar, actualizar, copia de seguridad y restaurar se describen en [README.md](README.md). La versión corta:

- instalar: `bash scripts/instalar.sh` (Linux, macOS, Git Bash) o `powershell -ExecutionPolicy Bypass -File scripts\instalar.ps1` (Windows);
- actualizar: baja la versión nueva y ejecuta el instalador de nuevo (mantiene la base de datos, las conexiones y los secretos);
- detener: `bash scripts/parar.sh` o `scripts\parar.ps1`;
- copia de seguridad y restauración: `bash scripts/backup.sh` y `bash scripts/restaurar.sh` (o `scripts\backup.ps1` y `scripts\restaurar.ps1` con `powershell -ExecutionPolicy Bypass -File`); el CRM tiene que estar en marcha;
- **la primera cuenta se vuelve dueña del servidor.** El instalador publica la app solo en `127.0.0.1`: crea tu cuenta antes de exponer el CRM a internet (proxy, túnel, puerto público) y después confirma en `/admin` que eres tú quien aparece allí.
- **red:** el Supabase local (API 54321, base de datos 54322) acepta conexiones de toda tu red local, y la base usa la contraseña por defecto de la CLI, conocida por todos. En una red que no es solo tuya, cualquiera en ella lee y cambia todos los datos del CRM. Usa una red de confianza o bloquea esos dos puertos para conexiones entrantes (ver [SECURITY.md](SECURITY.md)).
