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

/* The two tables switch from a real table to cards at different widths: the clients table has more to show
 * per row (address + MAC, traffic + speed), so it needs more room. */
const RULES_TABLE_MIN = 661;
const CLIENTS_TABLE_MIN = 661;

/* real table, whatever the theme does at this width (it switches to stacked cells at its own breakpoint,
 * which is why the middle widths used to fall apart). Short columns stay on one line, the last column
 * takes what is left and wraps when it has to. */
function wideCss(sel) {
	return sel + ' { display:table !important; width:100% !important; }' +
		sel + ' .tr { display:table-row !important; }' +
		sel + ' .tr.cbi-section-table-titles { display:table-row !important; }' +
		sel + ' .th, ' + sel + ' .td { display:table-cell !important; position:static !important; float:none !important; width:auto; max-width:none !important; height:auto !important; padding:.6rem .5rem !important; text-align:center !important; vertical-align:middle !important; white-space:nowrap; }' +
		sel + ' .td::before, ' + sel + ' .td::after { content:none !important; }';
}

/* narrow: the theme stacks the cells in its own way (labels as absolutely positioned pseudo elements,
 * flex items, ...). Reset all of that; the grid areas of each table are laid out explicitly. */
function narrowCss(sel) {
	return sel + ' .tr.cbi-section-table-titles { display:none !important; }' +
		sel + ' .tr.cbi-section-table-row { display:grid !important; align-items:baseline; gap:.2rem 1rem; padding:.6rem 1rem !important; margin:0 !important; height:auto !important; min-height:0 !important; flex:none !important; border-top:1px solid rgba(128,128,128,.15); }' +
		sel + ' .tr.cbi-section-table-row .td { display:block !important; position:static !important; float:none !important; flex:none !important; width:auto !important; max-width:none !important; min-width:0 !important; height:auto !important; min-height:0 !important; margin:0 !important; padding:0 !important; border:0 !important; transform:none !important; text-align:left !important; white-space:normal; line-height:1.4; }' +
		sel + ' .td::after, ' + sel + ' .td::before { content:none !important; }';
}

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
	/* clients: IP over MAC, traffic over speed (two lines each) */
	'.pg-clients .pg-ip, .pg-clients .pg-mac { display:block; }' +
	'.pg-clients .pg-mac { font-size:.85em; opacity:.8; }' +
	'.pg-clients .pg-cn, .pg-clients .pg-cs { display:inline-block; white-space:nowrap; text-align:center; }' +
	'.pg-clients .pg-arr { font-size:.7em; margin-right:.3em; vertical-align:.08em; }' +
	'.pg-clients .pg-cn { min-width:10.5ch; }' +
	'.pg-clients .pg-cs { min-width:12ch; font-size:.85em; font-weight:bold; }' +
	/* same colours as the Inbound / Outbound labels of the realtime bandwidth graph: download blue, upload green */
	'.pg-clients .pg-cs-dn { color:blue; }' +
	'.pg-clients .pg-cs-up { color:green; }' +
	/* traffic column: as narrow as its content, the block centred under its header, its cells centred too */
	'.pg-clients .pg-trafbox { display:inline-grid; grid-template-columns:auto auto; align-items:baseline; column-gap:.7em; row-gap:.05rem; text-align:center; }' +
	'@container (min-width: ' + RULES_TABLE_MIN + 'px) {' +
	wideCss('.pg-rules') +
	'  .pg-rules .td.pg-ract { white-space:normal; }' +
	'}' +
	'@container (min-width: ' + CLIENTS_TABLE_MIN + 'px) {' +
	wideCss('.pg-clients') +
	'  .pg-clients .td.pg-host, .pg-clients .td.pg-tag { white-space:normal; }' +
	'  .pg-clients .td.pg-host { overflow-wrap:anywhere; }' +
	'  .pg-clients .td.pg-type, .pg-clients .td.pg-traf { width:1%; }' +
	'}' +
	/* rules, narrow: rule name (bold) + action on line 1, "Packets: n   Bytes: n" on line 2 */
	'@container (max-width: ' + (RULES_TABLE_MIN - 1) + 'px) {' +
	narrowCss('.pg-rules') +
	'  .pg-rules .td.pg-rpk::before, .pg-rules .td.pg-rby::before { content:attr(data-title) ":" !important; display:inline !important; position:static !important; float:none !important; width:auto !important; margin:0 .4em 0 0 !important; padding:0 !important; font-weight:600; opacity:.7; }' +
	'  .pg-rules .tr.cbi-section-table-row { grid-template-columns:9rem minmax(0,1fr) fit-content(60%); grid-template-areas:"name name act" "pk by by"; }' +
	'  .pg-rules .td.pg-rname { grid-area:name; font-weight:600; overflow-wrap:anywhere; }' +
	'  .pg-rules .td.pg-ract { grid-area:act; justify-self:end; text-align:right; min-width:0; }' +
	'  .pg-rules .td.pg-rpk { grid-area:pk; }' +
	'  .pg-rules .tr.cbi-section-table-row .td.pg-rby { grid-area:by; white-space:nowrap; }' +
	'  .pg-rules .td.pg-rpk, .pg-rules .td.pg-rby { font-size:.85em; opacity:.8; }' +
	'  .pg-rules .td.pg-ract .pg-label { font-size:.8em; white-space:normal; display:inline-block; }' +
	'}' +
	/* clients, narrow card: hostname (bold) + tags on line 1, then IP, MAC, and traffic with speed */
	'@container (max-width: ' + (CLIENTS_TABLE_MIN - 1) + 'px) {' +
	narrowCss('.pg-clients') +
	'  .pg-clients .tr.cbi-section-table-row { grid-template-columns:minmax(0,1fr) auto; grid-template-areas:"host tag" "ip ip" "mac mac" "traf traf"; }' +
	'  .pg-clients .td.pg-host { grid-area:host; font-weight:600; overflow-wrap:anywhere; }' +
	'  .pg-clients .td.pg-tag { grid-area:tag; justify-self:end; }' +
	'  .pg-clients .tr.cbi-section-table-row .td.pg-addr { display:contents !important; }' +
	'  .pg-clients .pg-ip { grid-area:ip; overflow-wrap:anywhere; }' +
	'  .pg-clients .pg-mac { grid-area:mac; }' +
	'  .pg-clients .tr.cbi-section-table-row .td.pg-type { display:none !important; }' +
	'  .pg-clients .td.pg-traf { grid-area:traf; font-size:.9em; }' +
	'  .pg-clients .pg-cn, .pg-clients .pg-cs { min-width:0; }' +
	'}' +
	/* clients, medium: still three zones - hostname on the left, IP over MAC in the middle, tags on the right; the
	 * traffic and speed lines sit underneath (fixed tracks, so the middle zone starts at the same x on every row) */
	'@container (min-width: 501px) and (max-width: ' + (CLIENTS_TABLE_MIN - 1) + 'px) {' +
	'  .pg-clients .tr.cbi-section-table-row { grid-template-columns:minmax(0,1fr) minmax(0,1.2fr) 6.2rem; grid-template-areas:"host ip tag" "host mac tag" "traf traf tag"; align-items:center; column-gap:.75rem; }' +
	'  .pg-clients .pg-ip, .pg-clients .pg-mac { text-align:center; }' +
	'  .pg-clients .tr.cbi-section-table-row .td.pg-tag { align-self:center; justify-self:stretch; text-align:right !important; }' +
	'  .pg-clients .td.pg-tag .pg-label { margin:1px 0 1px 4px; }' +
	'}' +
	/* rules, medium-narrow: three zones - rule name on the left, packets over bytes in the middle, action on
	 * the right; below this the card (name + action, then packets and bytes) applies */
	'@container (min-width: 501px) and (max-width: ' + (RULES_TABLE_MIN - 1) + 'px) {' +
	'  .pg-rules .tr.cbi-section-table-row { grid-template-columns:minmax(0,1.25fr) auto minmax(0,.9fr); grid-template-areas:"name pk act" "name by act"; align-items:center; column-gap:1rem; }' +
	'  .pg-rules .td.pg-rname, .pg-rules .td.pg-ract { align-self:center; }' +
	'  .pg-rules .tr.cbi-section-table-row .td.pg-rpk, .pg-rules .tr.cbi-section-table-row .td.pg-rby { text-align:left !important; justify-self:stretch; }' +
	'  .pg-rules .tr.cbi-section-table-row .td.pg-rpk::before, .pg-rules .tr.cbi-section-table-row .td.pg-rby::before { display:inline-block !important; min-width:4.6em; }' +
	'  .pg-rules .tr.cbi-section-table-row .td.pg-rby .pg-sp-inline { display:block; min-width:0; min-height:1.3em; margin-left:6.25em; }' +
	'}' +
	'@container (max-width: ' + (RULES_TABLE_MIN - 1) + 'px) {' +
	'  .pg-rules .tr.cbi-section-table-row .td.pg-rsp { display:none !important; }' +
	'  .pg-rules .td.pg-rby .pg-sp-inline { display:inline-block; }' +
	'}' +
	'@container (max-width: 500px) {' +
	'  .pg-pk, .pg-by, .pg-speed { min-width:0; }' +
	'}' +
	/* very narrow: the action label gets its own full-width line under the rule name, so it can wrap freely */
	'@container (max-width: 420px) {' +
	'  .pg-rules .tr.cbi-section-table-row { grid-template-columns:minmax(0,1fr) minmax(0,1fr); grid-template-areas:"name name" "act act" "pk by"; }' +
	'  .pg-rules .td.pg-ract { justify-self:start; text-align:left; }' +
	'  .pg-rules .tr.cbi-section-table-row .td.pg-rby { white-space:normal; }' +
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
	lastClient: {},

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
			headerRow(this.clientTitles()),
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

	clientTitles() {
		return [ _('Hostname'), _('IP Address / MAC'), _('Traffic / Speed'), _('Type'), _('Tag') ];
	},

	/* The rows are only rebuilt when a client appears, disappears or changes its name / address / tag;
	 * the traffic numbers are written into the existing cells on every poll. */
	updateClients(clients) {
		const key = JSON.stringify(clients.map(c => [ c.ip, c.mac, c.hostname, c.is_server ]));

		if (key !== this.clientKey) {
			this.clientKey = key;
			this.clientRefs = {};

			const crows = [ headerRow(this.clientTitles()) ];

			if (!clients.length)
				crows.push(emptyRow(5, _('No redirection clients found in NFT sets.')));

			clients.forEach((c, i) => {
				const isV6 = String(c.ip).indexOf(':') > -1;
				const tag = E('td', { 'class': 'td pg-tag' }, [ badge('VPN', '#46a546') ]);

				if (c.is_server)
					tag.appendChild(badge('Server', '#0069d6'));

				/* line 1: total sent / received, line 2: current speed */
				/* the arrow is a separate, smaller glyph: the full-size one looks heavy next to the digits */
				const mk = (cls, arrow) => {
					const v = textEl('span', '', '');

					return { v: v, o: E('span', { 'class': cls }, [ textEl('span', 'pg-arr', arrow), v ]) };
				};

				const ref = {
					tu: mk('pg-cn', '\u2191'), td: mk('pg-cn', '\u2193'),
					su: mk('pg-cs pg-cs-up', '\u2191'), sd: mk('pg-cs pg-cs-dn', '\u2193')
				};

				this.clientRefs[c.ip] = ref;

				const traf = E('td', { 'class': 'td pg-traf', 'title': _('Upload / Download') }, [
					/* a 2 x 2 grid: one row per direction (upload, download), traffic then speed in the columns */
					E('div', { 'class': 'pg-trafbox' }, [ ref.tu.o, ref.su.o, ref.td.o, ref.sd.o ])
				]);

				crows.push(E('tr', { 'class': 'tr cbi-section-table-row cbi-rowstyle-' + (1 + i % 2) }, [
					cell(c.hostname ? textEl('span', '', c.hostname) : E('em', {}, [ 'unknown' ]), 'pg-host'),
					E('td', { 'class': 'td pg-addr' }, [
						textEl('div', 'pg-ip' + (isV6 ? ' pg-ip6' : ''), c.ip),
						textEl('div', 'pg-mac', c.mac || '\u2014')
					]),
					traf,
					cell(textEl('span', '', isV6 ? 'IPv6' : 'IPv4'), 'pg-type'),
					tag
				]));
			});

			this.keepScroll(() => L.dom.content(this.clientsTable, crows));
		}

		clients.forEach(c => {
			const ref = this.clientRefs[c.ip];

			if (!ref)
				return;

			const up = c.up, down = c.down;

			/* no counters (service started before the accounting rules existed): show dashes */
			if (up == null || down == null) {
				ref.tu.v.textContent = ref.td.v.textContent = ref.su.v.textContent = ref.sd.v.textContent = '\u2014';
				delete this.lastClient[c.ip];
				return;
			}

			const prev = this.lastClient[c.ip];

			/* a counter that went down was reset (service restarted): count that interval as zero */
			const rate = (cur, old) => (old !== undefined && cur >= old) ? (cur - old) / POLL_INTERVAL : 0;

			ref.tu.v.textContent = formatBytes(up);
			ref.td.v.textContent = formatBytes(down);
			ref.su.v.textContent = formatBytes(rate(up, prev && prev.up)) + '/s';
			ref.sd.v.textContent = formatBytes(rate(down, prev && prev.down)) + '/s';

			this.lastClient[c.ip] = { up: up, down: down };
		});
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
