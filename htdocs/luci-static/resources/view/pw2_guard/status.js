'use strict';
'require view';
'require rpc';
'require poll';
'require ui';

/*
 * PW2 Guard
 *
 * Status page for /etc/init.d/bypass_guard: start / stop the service, toggle
 * the Natmap qB-port integration and show live traffic counters and the VPN
 * client list taken from the nft table "inet bypass_logic".
 * Backend: /usr/share/rpcd/ucode/pw2_guard.uc (ubus object luci.pw2_guard).
 *
 * NOTE: LuCI's E() treats a single non-array string child as HTML, so text
 * that comes from the router (host names, rule names) is always passed in an
 * array or assigned via textContent.
 */

const callStatus = rpc.declare({ object: 'luci.pw2_guard', method: 'status' });
const callData = rpc.declare({ object: 'luci.pw2_guard', method: 'data' });
const callSetBypass = rpc.declare({ object: 'luci.pw2_guard', method: 'set_bypass', params: [ 'set' ] });
const callSetNatmap = rpc.declare({ object: 'luci.pw2_guard', method: 'set_natmap', params: [ 'set' ] });

const POLL_INTERVAL = 3;

const CSS =
	'.pg-label { display:inline-block; padding:2px 6px; border-radius:3px; color:#fff; font-weight:bold; font-size:0.85em; }' +
	'.pg-speed { color:#0069d6; font-size:0.8em; font-weight:bold; margin-left:4px; }' +
	'.pg-ip6 { font-size:0.85em; word-break:break-all; }';

function formatBytes(n) {
	n = Number(n) || 0;

	if (n >= 1073741824)
		return (n / 1073741824).toFixed(2) + ' GiB';
	if (n >= 1048576)
		return (n / 1048576).toFixed(2) + ' MiB';
	if (n >= 1024)
		return (n / 1024).toFixed(2) + ' KiB';

	return n.toFixed(0) + ' B';
}

function textEl(tag, cls, text) {
	const n = E(tag, cls ? { 'class': cls } : {});
	n.textContent = text;
	return n;
}

function badge(text, color) {
	const n = textEl('span', 'pg-label', text);
	n.style.backgroundColor = color;
	return n;
}

function cell(child) {
	return E('td', { 'class': 'td' }, [ child ]);
}

function emptyRow(cols, text) {
	return E('tr', { 'class': 'tr cbi-section-table-row' }, [
		E('td', { 'class': 'td', 'colspan': String(cols) }, [ E('em', {}, [ text ]) ])
	]);
}

function headerRow(titles) {
	return E('tr', { 'class': 'tr cbi-section-table-titles' },
		titles.map(t => E('th', { 'class': 'th cbi-section-table-th' }, [ t ])));
}

function actionBadge(raw) {
	const label = _(raw);

	if (/Direct/.test(raw))
		return badge(label, '#46a546');
	if (/Proxy|Agent/i.test(raw))
		return badge(label, '#0069d6');
	if (/NAT/.test(raw))
		return badge(label, '#d9822b');

	return textEl('small', '', label);
}

return view.extend({
	lastBytes: {},

	load() {
		return callStatus();
	},

	render(st) {
		st = st || {};

		const root = E('div', {}, [
			E('style', {}, [ CSS ]),
			E('h2', {}, [ _('PW2 Guard') ]),
			E('div', { 'class': 'cbi-map-descr' }, [ _('Manage firewall bypass logic and Natmap integration.') ])
		]);

		if (!st.running) {
			root.appendChild(E('div', { 'class': 'cbi-section' }, [
				E('em', { 'style': 'color:#999' }, [ _('Statistics and Client list not available (Service is stopped)') ])
			]));
			root.appendChild(this.buildToggleButton('enable'));

			return root;
		}

		if (st.has_natmap)
			root.appendChild(this.buildNatmapOption(st.natmap));

		this.rulesTable = E('table', { 'class': 'table cbi-section-table' }, [
			headerRow([ _('Rule Name'), _('Packets'), _('Bytes'), _('Action / Comment') ]),
			emptyRow(4, _('Collecting data...'))
		]);

		this.clientsTable = E('table', { 'class': 'table cbi-section-table' }, [
			headerRow([ _('Hostname'), _('MAC Address'), _('IP Address'), _('Type'), _('Tag') ]),
			emptyRow(5, _('Fetching client list...'))
		]);

		root.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-descr' }, [ E('strong', {}, [ _('Bypass Logic Traffic Statistics') ]) ]),
			this.rulesTable
		]));

		root.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'cbi-section-descr' }, [ E('strong', {}, [ _('VPN Clients') ]) ]),
			this.clientsTable
		]));

		root.appendChild(this.buildToggleButton('disable'));

		this.refresh();
		poll.add(() => this.refresh(), POLL_INTERVAL);

		return root;
	},

	refresh() {
		return callData().then(data => this.update(data || {})).catch(() => null);
	},

	update(data) {
		const rules = data.rules || [];
		const clients = data.clients || [];
		const rows = [ headerRow([ _('Rule Name'), _('Packets'), _('Bytes'), _('Action / Comment') ]) ];

		if (!rules.length) {
			rows.push(emptyRow(4, _('No traffic data detected yet...')));
		}
		else {
			rules.forEach((r, i) => {
				const cur = Number(r.bytes) || 0;
				const prev = this.lastBytes[r.name];
				const bytesCell = E('td', { 'class': 'td' }, [ formatBytes(cur) ]);

				if (prev !== undefined && cur > prev)
					bytesCell.appendChild(textEl('span', 'pg-speed', '↑ ' + formatBytes((cur - prev) / POLL_INTERVAL) + '/s'));

				this.lastBytes[r.name] = cur;

				rows.push(E('tr', { 'class': 'tr cbi-section-table-row cbi-rowstyle-' + (1 + i % 2) }, [
					cell(textEl('span', '', r.name)),
					cell(textEl('span', '', String(r.packets))),
					bytesCell,
					cell(actionBadge(r.comment || ''))
				]));
			});
		}

		L.dom.content(this.rulesTable, rows);

		const crows = [ headerRow([ _('Hostname'), _('MAC Address'), _('IP Address'), _('Type'), _('Tag') ]) ];

		if (!clients.length) {
			crows.push(emptyRow(5, _('No redirection clients found in NFT sets.')));
		}
		else {
			clients.forEach((c, i) => {
				const isV6 = String(c.ip).indexOf(':') > -1;
				const tag = E('td', { 'class': 'td' }, [ badge('VPN', '#46a546') ]);

				if (c.is_server) {
					const srv = badge('Server', '#0069d6');
					srv.style.marginLeft = '4px';
					tag.appendChild(srv);
				}

				crows.push(E('tr', { 'class': 'tr cbi-section-table-row cbi-rowstyle-' + (1 + i % 2) }, [
					cell(c.hostname ? textEl('span', '', c.hostname) : E('em', {}, [ 'unknown' ])),
					cell(textEl('span', '', c.mac || '—')),
					cell(textEl('span', isV6 ? 'pg-ip6' : '', c.ip)),
					cell(textEl('span', '', isV6 ? 'IPv6' : 'IPv4')),
					tag
				]));
			});
		}

		L.dom.content(this.clientsTable, crows);
	},

	buildNatmapOption(checked) {
		const descText = _('Update firewall rules automatically when Natmap port changes.');
		const desc = textEl('span', 'cbi-value-description', descText);
		const cb = E('input', { 'type': 'checkbox' });

		cb.checked = !!checked;

		cb.addEventListener('change', () => {
			const want = cb.checked;

			cb.disabled = true;
			desc.textContent = _('Saving...');

			callSetNatmap(want ? '1' : '0').then(res => {
				if (!res || res.code !== 0)
					throw new Error('failed');
			}).catch(() => {
				cb.checked = !want;
				ui.addNotification(null, E('p', {}, [ _('Config Update Failed') ]), 'danger');
			}).then(() => {
				cb.disabled = false;
				desc.textContent = descText;
			});
		});

		return E('div', { 'class': 'cbi-value', 'style': 'margin-top:1rem' }, [
			E('label', { 'class': 'cbi-value-title' }, [ E('strong', {}, [ _('Natmap qB-port Direct') ]) ]),
			E('div', { 'class': 'cbi-value-field' }, [ cb, E('br'), desc ])
		]);
	},

	buildToggleButton(action) {
		const isStop = (action === 'disable');
		const label = isStop ? _('Stop Bypass Guard') : _('Start Bypass Guard');

		const btn = E('button', {
			'class': 'btn cbi-button ' + (isStop ? 'cbi-button-negative' : 'cbi-button-positive'),
			'click': ev => {
				ev.preventDefault();
				btn.disabled = true;
				btn.textContent = _('Applying...');

				callSetBypass(action).then(res => {
					if (res && res.code === 0) {
						window.location.reload();
						return;
					}

					throw new Error('failed');
				}).catch(() => {
					btn.disabled = false;
					btn.textContent = label;
					ui.addNotification(null, E('p', {}, [ _('Config Update Failed') ]), 'danger');
				});
			}
		}, [ label ]);

		return E('div', { 'class': 'cbi-value', 'style': 'margin-top:0.5rem' }, [
			E('div', { 'class': 'cbi-value-field' }, [ btn ])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
