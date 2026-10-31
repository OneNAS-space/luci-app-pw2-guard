# luci-app-pw2-guard

Bypass logic for PassWall2 routers (nft table `inet bypass_logic`) with a LuCI status page
(Services → PW2 Guard): start/stop, Natmap qBittorrent port integration, live counters, VPN client list.

Split out of `luci-app-advanced`. JS view only; **no translations are shipped** (add your own po if needed).

## Install / upgrade from luci-app-advanced
1. `/etc/init.d/bypass_guard stop`
2. Remove the old package (`apk del luci-app-advanced` or `opkg remove luci-app-advanced`)
3. Install this package. The two switches are migrated from `/etc/config/advanced` into `/etc/config/pw2_guard`; the old file is left untouched.
4. If you overwrite `/etc/init.d/bypass_guard` and `natmap_bypass.sh` manually, apply these changes:
   - init script: `CONF="advanced"` → `CONF="pw2_guard"`
   - `natmap_bypass.sh`: `advanced.global.enable_natmap` → `pw2_guard.global.enable_natmap`

The package installs an rpcd ucode plugin, so rpcd is restarted on install (web sessions are logged out once).
The repository name must equal the package name (`luci-app-pw2-guard`) for the CI workflow.
