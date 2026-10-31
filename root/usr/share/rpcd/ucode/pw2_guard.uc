'use strict';

/*
 * rpcd plugin for luci-app-pw2-guard (object: luci.pw2_guard)
 *
 *   status      -> { enabled, running, natmap, has_natmap }
 *   data        -> { rules: [...], clients: [...] }   (parsed from the nft table)
 *   set_bypass  -> { set: 'enable' | 'disable' }
 *   set_natmap  -> { set: '1' | '0' }
 *
 * Only these methods are exposed to the web UI (see acl.d), no generic
 * command execution is needed.
 */

import { cursor } from 'uci';
import { popen, access, writefile } from 'fs';

const CONF = 'pw2_guard';
const SECTION = 'global';
const INIT = '/etc/init.d/bypass_guard';
const NATMAP_SCRIPT = '/usr/share/bypass_guard/scripts/natmap_bypass.sh';
const NFT = '/usr/sbin/nft';

/* ---------- helpers ---------- */

function run(cmd) {
	const p = popen(cmd + ' 2>/dev/null', 'r');

	if (!p)
		return '';

	const out = p.read('all');
	p.close();

	return out ?? '';
}

function open_cursor() {
	if (!access('/etc/config/' + CONF))
		writefile('/etc/config/' + CONF, '');

	const ctx = cursor();

	if (!ctx.get(CONF, SECTION))
		ctx.set(CONF, SECTION, CONF);

	return ctx;
}

function save_config(ctx, name) {
	ctx.save(name);
	ctx.commit(name);
}

/* ---------- nft parsing ---------- */

/* split "nft list table" output into { chain_name: [ trimmed rule lines ] } */
function parse_chains(text) {
	const chains = {};
	let cur = null;

	for (let line in split(text, '\n')) {
		const t = trim(line);
		const m = match(t, /^chain ([A-Za-z0-9_]+) \{$/);

		if (m) {
			cur = m[1];
			chains[cur] = [];
		}
		else if (t == '}') {
			cur = null;
		}
		else if (cur) {
			push(chains[cur], t);
		}
	}

	return chains;
}

function normalize_key(comment) {
	let key = replace(comment, /-?[tT][cC][pP]-?/g, '-');

	key = replace(key, /-?[uU][dD][pP]-?/g, '-');
	key = replace(key, /-?[vV]?[46]-?/g, '-');
	key = replace(key, /-+/g, '-');
	key = replace(key, /-+$/, '');
	key = replace(key, /^-+/, '');

	return key;
}

function friendly_action(key) {
	if (index(key, 'Direct') >= 0) {
		if (index(key, 'BT') >= 0 || index(key, 'qB') >= 0)
			return 'Direct / BitTorrent';
		if (index(key, 'CF-Tunnel') >= 0)
			return 'Direct / Cloudflare Tunnel';
		if (index(key, 'CN-Direct') >= 0)
			return 'Direct / China IP Address';
		if (index(key, 'STUN-Direct') >= 0)
			return 'Direct / STUN Penetration';

		return 'Direct / Bypass';
	}

	if (index(key, 'Global-Bypass') >= 0)
		return 'Direct / Global Whitelist';

	if (index(key, 'PASS') >= 0)
		return 'Proxy / Agent Redirect';

	if (index(key, 'Fix') >= 0 || index(key, 'Loopback') >= 0) {
		if (index(key, 'Local') >= 0)
			return 'System / Router Self-Agent Redirect';
		if (index(key, 'Loopback') >= 0)
			return 'System / Loopback Bypass';

		return 'System / Routing Fix';
	}

	return '—';
}

function collect_rules(chains) {
	const rules = [];
	const agg = {};
	const order = [];

	for (let name in [ 'static_privilege', 'static_privilege_output', 'dynamic_logic' ]) {
		for (let line in (chains[name] ?? [])) {
			const c = match(line, /counter packets ([0-9]+) bytes ([0-9]+)/);
			const k = match(line, /comment "([^"]*)"/);

			if (!c || !k)
				continue;

			const key = normalize_key(k[1]);

			if (!agg[key]) {
				agg[key] = { name: key, packets: 0, bytes: 0, comment: friendly_action(key) };
				push(order, key);
			}

			agg[key].packets += int(c[1]);
			agg[key].bytes += int(c[2]);
		}
	}

	for (let key in order)
		push(rules, agg[key]);

	/* qBittorrent dual-stack port forwards */
	const nat = {};
	const nat_order = [];

	for (let line in (chains['qb_fix'] ?? [])) {
		const f = match(line, /ipv[0-9]/);
		const d = match(line, /([a-z]+) dport ([0-9]+)/);
		const c = match(line, /counter packets ([0-9]+) bytes ([0-9]+)/);
		const t = match(line, / to ([^ ]+)/);

		if (!f || !d || !c || !t)
			continue;

		const tp = match(t[1], /:([0-9]+)$/);
		const target_port = tp ? tp[1] : t[1];
		const key = d[2] + '_' + target_port;

		if (!nat[key]) {
			nat[key] = { dport: d[2], target_port: target_port, packets: 0, bytes: 0, protos: {} };
			push(nat_order, key);
		}

		nat[key].packets += int(c[1]);
		nat[key].bytes += int(c[2]);
		nat[key].protos[uc(d[1])] = true;
	}

	for (let key in nat_order) {
		const n = nat[key];

		push(rules, {
			name: join('/', sort(keys(n.protos))) + '-Fix: ' + n.dport,
			packets: n.packets,
			bytes: n.bytes,
			comment: 'NAT / Dual-Stack Forward -> :' + n.target_port
		});
	}

	return rules;
}

/* ---------- clients ---------- */

function load_hosts() {
	const ctx = cursor();
	const ip_map = {};
	const mac_map = {};

	ctx.foreach('dhcp', 'host', (s) => {
		if (!s.name)
			return;

		if (s.ip)
			ip_map[s.ip] = s.name;

		if (s.mac) {
			const macs = (type(s.mac) == 'array') ? s.mac : split(s.mac, /[ \t]+/);

			for (let m in macs)
				mac_map[lc(m)] = s.name;
		}
	});

	return { ip_map: ip_map, mac_map: mac_map };
}

function load_neighbours() {
	const map = {};

	for (let line in split(run('ip neigh show'), '\n')) {
		const f = split(trim(line), /[ \t]+/);
		const i = index(f, 'lladdr');

		if (i >= 0 && f[0] && f[i + 1])
			map[f[0]] = lc(f[i + 1]);
	}

	return map;
}

function fetch_set(name) {
	const raw = run(NFT + ' list set inet bypass_logic ' + name);
	const i = index(raw, 'elements = {');

	if (i < 0)
		return [];

	let rest = substr(raw, i + 12);
	const j = index(rest, '}');

	if (j >= 0)
		rest = substr(rest, 0, j);

	const out = [];

	for (let tok in split(rest, /[, \t\n]+/)) {
		if (!tok)
			continue;

		if (index(tok, 'timeout') >= 0 || index(tok, 'expires') >= 0)
			continue;

		if (match(tok, /[0-9]+\.[0-9]+/) || index(tok, ':') >= 0)
			push(out, tok);
	}

	return out;
}

function collect_clients() {
	const hosts = load_hosts();
	const neigh = load_neighbours();
	const clients = [];
	const seen = {};

	const groups = [
		[ 'psw_vpn_clients', false ],
		[ 'psw_vpn_clients6', false ],
		[ 'quic_direct_clients', true ],
		[ 'quic_direct_clients6', true ]
	];

	for (let g in groups) {
		for (let ip in fetch_set(g[0])) {
			if (seen[ip] != null) {
				if (g[1])
					clients[seen[ip]].is_server = true;

				continue;
			}

			let name = hosts.ip_map[ip];
			let mac = neigh[ip] ?? '';

			if (!name && mac != '' && hosts.mac_map[mac])
				name = hosts.mac_map[mac];

			if (mac == '' && name) {
				for (let m in keys(hosts.mac_map)) {
					if (hosts.mac_map[m] == name) {
						mac = m;
						break;
					}
				}
			}

			seen[ip] = length(clients);

			push(clients, {
				ip: ip,
				mac: (mac != '') ? uc(mac) : '—',
				hostname: name ?? 'Configured-Device',
				is_server: g[1]
			});
		}
	}

	return clients;
}

/* ---------- methods ---------- */

const methods = {
	status: {
		call: function() {
			const ctx = cursor();
			const enabled = (ctx.get(CONF, SECTION, 'enable_bypass') == '1');
			const table_up = (system(NFT + ' list table inet bypass_logic >/dev/null 2>&1') == 0);

			return {
				enabled: enabled,
				running: enabled && table_up,
				natmap: (ctx.get(CONF, SECTION, 'enable_natmap') == '1'),
				has_natmap: access('/etc/config/natmap') ? true : false
			};
		}
	},

	data: {
		call: function() {
			const text = run(NFT + ' -p list table inet bypass_logic');

			if (text == '')
				return { rules: [], clients: [] };

			return {
				rules: collect_rules(parse_chains(text)),
				clients: collect_clients()
			};
		}
	},

	set_bypass: {
		args: { set: 'enable' },
		call: function(req) {
			const act = req.args.set;

			if (act != 'enable' && act != 'disable')
				return { code: 1, error: 'invalid argument' };

			const ctx = open_cursor();

			ctx.set(CONF, SECTION, 'enable_bypass', (act == 'enable') ? '1' : '0');
			save_config(ctx, CONF);

			if (act == 'enable') {
				system([ INIT, 'enable' ], 30000);
				system([ INIT, 'start' ], 30000);
			}
			else {
				system([ INIT, 'stop' ], 30000);
				system([ INIT, 'disable' ], 30000);
			}

			return { code: 0 };
		}
	},

	set_natmap: {
		args: { set: '1' },
		call: function(req) {
			const val = req.args.set;

			if (val != '1' && val != '0')
				return { code: 1, error: 'invalid argument' };

			const ctx = open_cursor();

			ctx.set(CONF, SECTION, 'enable_natmap', val);
			save_config(ctx, CONF);

			if (access('/etc/config/natmap')) {
				ctx.foreach('natmap', 'natmap', (s) => {
					if (s.comment == 'qBittorrent')
						ctx.set('natmap', s['.name'], 'custom_script', (val == '1') ? NATMAP_SCRIPT : '');
				});

				save_config(ctx, 'natmap');
				system([ '/etc/init.d/natmap', 'reload' ], 30000);
			}

			if (system(INIT + ' status >/dev/null 2>&1') == 0)
				system([ INIT, 'reload' ], 30000);

			return { code: 0 };
		}
	}
};

return { 'luci.pw2_guard': methods };
