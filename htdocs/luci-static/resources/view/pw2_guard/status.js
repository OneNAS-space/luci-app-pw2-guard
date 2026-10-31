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
	/* the counters change every few seconds: equal-width digits and fixed minimum widths keep the columns still */
	'.pg-tbl { font-variant-numeric:tabular-nums; }' +
	'.pg-pk, .pg-by, .pg-speed { display:inline-block; text-align:inherit; vertical-align:baseline; white-space:nowrap; }' +
	'.pg-pk { min-width:8ch; }' +
	'.pg-by { min-width:9ch; }' +
	'.pg-speed { min-width:7.5em; text-align:left; }' +
	'.pg-sp-inline { display:none; }' +
	'.pg-rsp .pg-speed { text-align:center; margin-left:0; }' +
	'.pg-ip6 { font-size:0.85em; }' +
	'.pg-wrap { container-type:inline-size; }' +
	'.pg-tbl .td.pg-tag .pg-label { margin:0 4px 2px 0; }' +
	'.pg-speed { white-space:nowrap; }' +
	/* wide: a real table, whatever the theme does at this width (it switches to stacked cells at its own
	 * breakpoint, which is why the middle widths used to fall apart). Short columns stay on one line,
	 * the last column takes what is left and wraps when it has to. */
	'@container (min-width: 661px) {' +
	'  .pg-tbl { display:table !important; width:100% !important; }' +
	'  .pg-tbl .tr { display:table-row !important; }' +
	'  .pg-tbl .tr.cbi-section-table-titles { display:table-row !important; }' +
	'  .pg-tbl .th, .pg-tbl .td { display:table-cell !important; position:static !important; float:none !important; width:auto; max-width:none !important; height:auto !important; padding:.6rem .5rem !important; text-align:center !important; vertical-align:middle !important; white-space:nowrap; }' +
	'  .pg-tbl .td::before, .pg-tbl .td::after { content:none !important; }' +
	'  .pg-tbl .td.pg-ract, .pg-tbl .td.pg-tag { white-space:normal; }' +
	'  .pg-clients .td.pg-type { width:1%; }' +
	'}' +
	/* narrow: the theme stacks the cells in its own way (labels as absolutely positioned pseudo elements,
	 * flex items, ...). Reset all of that and lay the cards out explicitly:
	 * rules:   rule name (bold) + action on line 1, "Packets: n   Bytes: n" on line 2
	 * clients: hostname (bold) + tags on line 1, IP + type on line 2, MAC on line 3 */
	'@container (max-width: 660px) {' +
	'  .pg-tbl .tr.cbi-section-table-titles { display:none !important; }' +
	'  .pg-tbl .tr.cbi-section-table-row { display:grid !important; align-items:baseline; gap:.2rem 1rem; padding:.6rem 1rem !important; margin:0 !important; height:auto !important; min-height:0 !important; flex:none !important; border-top:1px solid rgba(128,128,128,.15); }' +
	'  .pg-tbl .tr.cbi-section-table-row .td { display:block !important; position:static !important; float:none !important; flex:none !important; width:auto !important; max-width:none !important; min-width:0 !important; height:auto !important; min-height:0 !important; margin:0 !important; padding:0 !important; border:0 !important; transform:none !important; text-align:left !important; white-space:normal; line-height:1.4; }' +
	'  .pg-tbl .td::after { content:none !important; }' +
	'  .pg-tbl .td::before { content:none !important; }' +
	'  .pg-tbl .td.pg-rpk::before, .pg-tbl .td.pg-rby::before, .pg-tbl .td.pg-mac::before { content:attr(data-title) ":" !important; display:inline !important; position:static !important; float:none !important; width:auto !important; margin:0 .4em 0 0 !important; padding:0 !important; font-weight:600; opacity:.7; }' +
	'  .pg-rules .tr.cbi-section-table-row { grid-template-columns:9rem minmax(0,1fr) fit-content(60%); grid-template-areas:"name name act" "pk by by"; }' +
	'  .pg-clients .tr.cbi-section-table-row { grid-template-columns:auto auto minmax(0,1fr); grid-template-areas:"host host tag" "ip type type" "mac mac mac"; }' +
	'  .pg-tbl .td.pg-rname { grid-area:name; font-weight:600; overflow-wrap:anywhere; }' +
	'  .pg-tbl .td.pg-ract { grid-area:act; justify-self:end; text-align:right; min-width:0; }' +
	'  .pg-tbl .td.pg-rpk { grid-area:pk; }' +
	'  .pg-tbl .tr.cbi-section-table-row .td.pg-rby { grid-area:by; white-space:nowrap; }' +
	'  .pg-tbl .td.pg-host { grid-area:host; font-weight:600; overflow-wrap:anywhere; }' +
	'  .pg-tbl .td.pg-tag { grid-area:tag; justify-self:end; }' +
	'  .pg-tbl .td.pg-ip { grid-area:ip; }' +
	'  .pg-tbl .td.pg-type { grid-area:type; }' +
	'  .pg-tbl .td.pg-mac { grid-area:mac; }' +
	'  .pg-tbl .td.pg-rpk, .pg-tbl .td.pg-rby, .pg-tbl .td.pg-mac, .pg-tbl .td.pg-type { font-size:.85em; opacity:.8; }' +
	'  .pg-tbl .td.pg-ract .pg-label { font-size:.8em; white-space:normal; display:inline-block; }' +
	'}' +
	/* clients, medium-narrow: still three zones in one row - hostname over MAC on the left, IP over type in the
	 * middle, tags on the right; below this the four values are simply stacked left (the card above) */
	'@container (min-width: 501px) and (max-width: 660px) {' +
	'  .pg-clients .tr.cbi-section-table-row { grid-template-columns:fit-content(45%) minmax(0,1fr) auto; grid-template-areas:"host ip tag" "mac type tag"; align-items:center; column-gap:1rem; }' +
	'  .pg-clients .tr.cbi-section-table-row .td.pg-ip, .pg-clients .tr.cbi-section-table-row .td.pg-type { text-align:center !important; justify-self:stretch; }' +
	'  .pg-clients .td.pg-ip { overflow-wrap:anywhere; }' +
	'  .pg-clients .td.pg-mac::before { content:none !important; }' +
	'  .pg-clients .td.pg-tag { align-self:center; }' +
	'}' +
	/* rules, medium-narrow: same three zones as the clients - rule name on the left, packets over bytes centred
	 * between, action on the right; below this the card (name + action, then packets and bytes) applies */
	'@container (min-width: 501px) and (max-width: 660px) {' +
	'  .pg-rules .tr.cbi-section-table-row { grid-template-columns:minmax(0,1.25fr) auto minmax(0,.9fr); grid-template-areas:"name pk act" "name by act"; align-items:center; column-gap:1rem; }' +
	'  .pg-rules .tr.cbi-section-table-row .td.pg-rpk, .pg-rules .tr.cbi-section-table-row .td.pg-rby { text-align:center !important; justify-self:stretch; }' +
	'  .pg-rules .td.pg-rname, .pg-rules .td.pg-ract { align-self:center; }' +
	'  .pg-rules .tr.cbi-section-table-row .td.pg-rpk, .pg-rules .tr.cbi-section-table-row .td.pg-rby { text-align:left !important; justify-self:stretch; }' +
	'  .pg-rules .tr.cbi-section-table-row .td.pg-rpk::before, .pg-rules .tr.cbi-section-table-row .td.pg-rby::before { display:inline-block !important; min-width:4.6em; }' +
	'  .pg-rules .tr.cbi-section-table-row .td.pg-rby .pg-sp-inline { display:block; min-width:0; min-height:1.3em; margin-left:6.25em; }' +
	'}' +
	'@container (max-width: 660px) {' +
	'  .pg-rules .tr.cbi-section-table-row .td.pg-rsp { display:none !important; }' +
	'  .pg-rules .td.pg-rby .pg-sp-inline { display:inline-block; }' +
	'}' +
	'@container (max-width: 500px) {' +
	'  .pg-pk, .pg-by, .pg-speed { min-width:0; }' +
	'}' +
	/* very narrow: the action label gets its own full-width line under the rule name, so it can wrap freely */
	'@container (max-width: 420px) {' +
	'  .pg-rules .tr.cbi-section-table-row { grid-template-columns:minmax(0,1fr) minmax(0,1fr); grid-template-areas:"name name" "act act" "pk by"; }' +
	'  .pg-tbl .td.pg-ract { justify-self:start; text-align:left; }' +
	'  .pg-tbl .tr.cbi-section-table-row .td.pg-rby { white-space:normal; }' +
	'}' +
	'.pg-head { display:flex; align-items:center; flex-wrap:wrap; gap:.5rem 1.5rem; }' +
	'.pg-natmap { display:inline-flex; align-items:center; gap:.75rem; }' +
	'.pg-switch { display:inline-flex; align-items:center; gap:.4rem; height:auto; min-height:0; line-height:1.4; padding:.25rem .8rem; margin:0; border-radius:999px; font-weight:600; font-size:.9rem; border:0; box-shadow:none; cursor:pointer; transition:filter .15s; }' +
	'.pg-switch:hover { filter:brightness(.95); }' +
	'.pg-switch:disabled { opacity:.6; cursor:default; }' +
	'.pg-switch::before { content:""; width:.55rem; height:.55rem; border-radius:50%; background:currentColor; }' +
	'.pg-switch.on { color:#1a7f37; background:#dafbe1; }' +
	'.pg-switch.na { color:#6b7280; background:rgba(128,128,128,.18); }' +
	'.pg-switch.na:disabled { opacity:1; cursor:not-allowed; }' +
	'.pg-switch.off { color:#82071e; background:#ffebe9; }';

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

function cell(child, cls, title) {
	const td = E('td', { 'class': 'td' + (cls ? ' ' + cls : '') }, [ child ]);

	if (title)
		td.setAttribute('data-title', title);

	return td;
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

		const head = E('div', { 'class': 'cbi-map-descr pg-head' }, [
			textEl('span', '', _('Main Switch')),
			this.buildSwitch(!!st.running)
		]);

		/* the Natmap switch always sits on the same row as the main switch;
		 * it shows "Not Installed" (and can't be clicked) when natmap isn't on the system */
		head.appendChild(this.buildNatmapOption(st.natmap, st.has_natmap));

		const root = E('div', {}, [
			E('style', {}, [ CSS ]),
			E('h2', {}, [ _('PW2 Guard') ]),
			head
		]);

		if (!st.running) {
			root.appendChild(E('div', { 'class': 'cbi-section' }, [
				E('em', { 'style': 'color:#999' }, [ _('Statistics and Client list not available (Service is stopped)') ])
			]));

			return root;
		}

		this.rulesTable = E('table', { 'class': 'table cbi-section-table pg-tbl pg-rules' }, [
			headerRow([ _('Rule Name'), _('Packets'), _('Bytes'), _('Speed'), _('Action / Comment') ]),
			emptyRow(5, _('Collecting data...'))
		]);

		this.clientsTable = E('table', { 'class': 'table cbi-section-table pg-tbl pg-clients' }, [
			headerRow([ _('Hostname'), _('MAC Address'), _('IP Address'), _('Type'), _('Tag') ]),
			emptyRow(5, _('Fetching client list...'))
		]);

		/* two tab pages: the traffic statistics and the VPN client list */
		/* initTabGroup() inserts the tab menu before the pane container, so the container needs a parent */
		const group = E('div', {}, [
			E('div', { 'data-tab': 'stats', 'data-tab-title': _('Traffic Statistics') }, [
				E('div', { 'class': 'pg-wrap' }, [ this.rulesTable ])
			]),
			E('div', { 'data-tab': 'clients', 'data-tab-title': _('VPN Clients') }, [
				E('div', { 'class': 'pg-wrap' }, [ this.clientsTable ])
			])
		]);

		const tabs = E('div', {}, [ group ]);

		ui.tabs.initTabGroup(group.childNodes);
		root.appendChild(tabs);

		this.refresh();
		poll.add(() => this.refresh(), POLL_INTERVAL);

		return root;
	},

	refresh() {
		return callData().then(data => this.update(data || {})).catch(() => null);
	},

	/* The tables are only rebuilt when their structure changes (a rule or client appears/disappears).
	 * Otherwise the existing cells are updated in place, so the 3 s poll never replaces the DOM
	 * (which used to collapse the page height for a moment and throw the scroll position back to the top). */
	update(data) {
		this.updateRules(data.rules || []);
		this.updateClients(data.clients || []);
	},

	keepScroll(fn) {
		const sc = document.scrollingElement || document.documentElement;
		const top = sc.scrollTop;

		fn();

		if (sc.scrollTop !== top)
			sc.scrollTop = top;
	},

	updateRules(rules) {
		const key = rules.map(r => r.name).join('\n');

		if (key !== this.ruleKey) {
			this.ruleKey = key;
			this.ruleRefs = {};

			const rows = [ headerRow([ _('Rule Name'), _('Packets'), _('Bytes'), _('Speed'), _('Action / Comment') ]) ];

			if (!rules.length)
				rows.push(emptyRow(5, _('No traffic data detected yet...')));

			rules.forEach((r, i) => {
				const pk = textEl('span', 'pg-pk', '');
				const by = textEl('span', 'pg-by', '');
				const sp = textEl('span', 'pg-speed pg-sp-inline', '');   /* shown inside Bytes on the narrow layouts */
				const sp2 = textEl('span', 'pg-speed', '');              /* shown in its own Speed column in the table */

				this.ruleRefs[r.name] = { pk: pk, by: by, sp: sp, sp2: sp2 };

				rows.push(E('tr', { 'class': 'tr cbi-section-table-row cbi-rowstyle-' + (1 + i % 2) }, [
					cell(textEl('span', '', r.name), 'pg-rname'),
					cell(pk, 'pg-rpk', _('Packets')),
					E('td', { 'class': 'td pg-rby', 'data-title': _('Bytes') }, [ by, sp ]),
					cell(sp2, 'pg-rsp'),
					cell(actionBadge(r.comment || ''), 'pg-ract')
				]));
			});

			this.keepScroll(() => L.dom.content(this.rulesTable, rows));
		}

		rules.forEach(r => {
			const ref = this.ruleRefs[r.name];
			const cur = Number(r.bytes) || 0;
			const prev = this.lastBytes[r.name];

			if (!ref)
				return;

			ref.pk.textContent = String(r.packets);
			ref.by.textContent = formatBytes(cur);
			const speed = (prev !== undefined && cur > prev)
				? '\u2191 ' + formatBytes((cur - prev) / POLL_INTERVAL) + '/s' : '';

			ref.sp.textContent = speed ? ' ' + speed : '';
			ref.sp2.textContent = speed;

			this.lastBytes[r.name] = cur;
		});
	},

	updateClients(clients) {
		const sig = JSON.stringify(clients);

		if (sig === this.clientSig)
			return;

		this.clientSig = sig;

		const crows = [ headerRow([ _('Hostname'), _('MAC Address'), _('IP Address'), _('Type'), _('Tag') ]) ];

		if (!clients.length)
			crows.push(emptyRow(5, _('No redirection clients found in NFT sets.')));

		clients.forEach((c, i) => {
			const isV6 = String(c.ip).indexOf(':') > -1;
			const tag = E('td', { 'class': 'td pg-tag' }, [ badge('VPN', '#46a546') ]);

			if (c.is_server)
				tag.appendChild(badge('Server', '#0069d6'));

			crows.push(E('tr', { 'class': 'tr cbi-section-table-row cbi-rowstyle-' + (1 + i % 2) }, [
				cell(c.hostname ? textEl('span', '', c.hostname) : E('em', {}, [ 'unknown' ]), 'pg-host'),
				cell(textEl('span', '', c.mac || '\u2014'), 'pg-mac', _('MAC')),
				cell(textEl('span', isV6 ? 'pg-ip6' : '', c.ip), 'pg-ip'),
				cell(textEl('span', '', isV6 ? 'IPv6' : 'IPv4'), 'pg-type'),
				tag
			]));
		});

		this.keepScroll(() => L.dom.content(this.clientsTable, crows));
	},

	/* same badge switch as the main one; toggles in place without reloading the page */
	buildNatmapOption(checked, installed) {
		const tip = _('Update firewall rules automatically when Natmap port changes.');
		let on = !!checked;

		const paint = () => {
			if (!installed) {
				sw.className = 'pg-switch na';
				sw.textContent = _('Not Installed');
				sw.title = '';
				sw.disabled = true;
				return;
			}

			sw.className = 'pg-switch ' + (on ? 'on' : 'off');
			sw.textContent = on ? _('Enabled') : _('Disabled');
			sw.title = on ? _('Click to disable') : _('Click to enable');
		};

		const sw = E('button', {
			'type': 'button',
			'click': ev => {
				ev.preventDefault();

				if (!installed)
					return;

				sw.disabled = true;
				sw.textContent = _('Applying...');

				callSetNatmap(on ? '0' : '1').then(res => {
					if (!res || res.code !== 0)
						throw new Error('failed');

					on = !on;
				}).catch(() => {
					ui.addNotification(null, E('p', {}, [ _('Config Update Failed') ]), 'danger');
				}).then(() => {
					sw.disabled = false;
					paint();
				});
			}
		});

		paint();

		return E('span', { 'class': 'pg-natmap', 'title': tip }, [
			textEl('span', '', _('Natmap qB-port Direct')),
			sw
		]);
	},

	/* status badge that doubles as the on/off switch */
	buildSwitch(running) {
		const label = running ? _('Enabled') : _('Disabled');

		const sw = E('button', {
			'class': 'pg-switch ' + (running ? 'on' : 'off'),
			'type': 'button',
			'title': running ? _('Click to disable') : _('Click to enable'),
			'click': ev => {
				ev.preventDefault();
				sw.disabled = true;
				sw.textContent = _('Applying...');

				callSetBypass(running ? 'disable' : 'enable').then(res => {
					if (res && res.code === 0) {
						window.location.reload();
						return;
					}

					throw new Error('failed');
				}).catch(() => {
					sw.disabled = false;
					sw.textContent = label;
					ui.addNotification(null, E('p', {}, [ _('Config Update Failed') ]), 'danger');
				});
			}
		}, [ label ]);

		return sw;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
