# Copyright (C) 2025  OneNAS-space <https://github.com/OneNAS-space/luci-app-pw2-guard/>
#
# This is free software, licensed under the GPL-3 License
#

include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/package.mk

PKG_LICENSE:=GPL-3.0-or-later
PKG_MAINTAINER:=Jackie Han <jackie.han@gmail.com>
PKG_NAME:=luci-app-pw2-guard
PKG_VERSION:=1.0.2
PKG_RELEASE:=1

define Package/$(PKG_NAME)
	SECTION:=luci
	CATEGORY:=LuCI
	SUBMENU:=3. Applications
	TITLE:=LuCI support for PW2 Guard (PassWall2 bypass logic)
	DEPENDS:=+luci-base +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-uci
	CONFLICTS:=luci-app-advanced
	PKGARCH:=all
endef

define Package/$(PKG_NAME)/description
	Bypass logic for PassWall2 routers: VPN-tagged DHCP hosts are handed to
	PassWall2, everything else goes direct, with optional Natmap (qBittorrent)
	port integration, plus a LuCI status page with live counters.
endef

define Package/$(PKG_NAME)/conffiles
/etc/config/pw2_guard
endef

define Build/Compile
endef

define Package/$(PKG_NAME)/install
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./root/etc/init.d/bypass_guard $(1)/etc/init.d/bypass_guard

	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./root/etc/uci-defaults/40_pw2-guard $(1)/etc/uci-defaults/

	$(INSTALL_DIR) $(1)/usr/share/bypass_guard/scripts
	$(INSTALL_BIN) ./root/usr/share/bypass_guard/scripts/natmap_bypass.sh $(1)/usr/share/bypass_guard/scripts/natmap_bypass.sh
	$(INSTALL_BIN) ./root/usr/share/bypass_guard/scripts/stun_sync.sh $(1)/usr/share/bypass_guard/scripts/stun_sync.sh

	$(INSTALL_DIR) $(1)/usr/share/rpcd/ucode
	$(INSTALL_DATA) ./root/usr/share/rpcd/ucode/pw2_guard.uc $(1)/usr/share/rpcd/ucode/pw2_guard.uc

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-pw2-guard.json $(1)/usr/share/rpcd/acl.d/

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-pw2-guard.json $(1)/usr/share/luci/menu.d/

	$(INSTALL_DIR) $(1)/www
	cp -pR ./htdocs/* $(1)/www/
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
if [ -z "$${IPKG_INSTROOT}" ]; then
	[ -f /etc/uci-defaults/40_pw2-guard ] && sh /etc/uci-defaults/40_pw2-guard && rm -f /etc/uci-defaults/40_pw2-guard
	/etc/init.d/bypass_guard enabled && /etc/init.d/bypass_guard restart
	# a new rpcd ucode plugin is only picked up after a restart (web sessions are reset once)
	/etc/init.d/rpcd restart
fi
exit 0
endef

$(eval $(call BuildPackage,$(PKG_NAME)))
