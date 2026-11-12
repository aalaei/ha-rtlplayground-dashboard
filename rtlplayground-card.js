/*
 * RTLPlayground card: front panel, port detail, PoE panel, traffic and night mode.
 *
 * One file, no build step. Entities are found through the Home Assistant entity
 * and device registries. The card takes two devices as input and needs no entity IDs:
 *
 *   type: custom:rtlplayground-card
 *   # Both device pickers are optional. Each is auto-detected when omitted.
 *   device_id: <RTLPlayground switch device>   # the device made by the RTLPlayground integration
 *   poe_device_id: <ESPHome PoE device>        # the device with "PoE Port N" entities
 *   poe_budget_w: 60                           # optional: shows the budget next to the draw
 *   title: Switch                              # optional
 *   history_hours: 1                           # optional, traffic chart window
 *
 * Writes (night mode, PoE per port) always ask for confirmation first.
 */

const CARD_TAG = "rtlplayground-card";
const RTL_PLATFORM = "rtlplayground";
const ESPHOME_PLATFORM = "esphome";
const UNAVAILABLE_STATES = new Set(["unavailable", "unknown", undefined, null]);

// ---------- pure helpers (exported for tests) ----------

/** Registry rows come in two shapes: the frontend's (entity_id, device_id, platform, name) and the server's compact one (ei, di, pl, en). */
export function registryRow(row) {
  return {
    entity_id: row.entity_id ?? row.ei,
    device_id: row.device_id ?? row.di,
    platform: row.platform ?? row.pl,
    name: row.name ?? row.en ?? row.original_name ?? null,
  };
}

/** Index a list (or map) of registry rows by entity_id. */
export function indexRegistry(hassEntities) {
  const out = {};
  const values = Array.isArray(hassEntities) ? hassEntities : Object.values(hassEntities || {});
  for (const raw of values) {
    const row = registryRow(raw);
    if (row.entity_id) out[row.entity_id] = row;
  }
  return out;
}

/** "Port 3 link speed" -> {port: 3, what: "link speed"}. Null when the name has no port number. */
export function parsePortName(name) {
  const m = /Port (\d+) (.+)$/.exec(name || "");
  return m ? { port: Number(m[1]), what: m[2].toLowerCase() } : null;
}

/** Find the RTLPlayground device when none is configured: the device that owns the most of its entities. */
export function pickRtlDevice(registry) {
  const counts = {};
  for (const row of Object.values(registry)) {
    if (row.platform === RTL_PLATFORM && row.device_id) {
      counts[row.device_id] = (counts[row.device_id] || 0) + 1;
    }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

/** Map this device's entities to a model: switch values, per-port entities, night switch. */
export function discoverRtl(registry, deviceId) {
  const model = { deviceId, switch: {}, ports: {}, night: null };
  for (const row of Object.values(registry)) {
    if (row.device_id !== deviceId || row.platform !== RTL_PLATFORM) continue;
    const port = parsePortName(row.name);
    if (port) {
      const slot = (model.ports[port.port] ||= { port: port.port });
      slot[portKey(port.what)] = row.entity_id;
      continue;
    }
    if (row.name === "Night mode") model.night = row.entity_id;
    else if (row.name) model.switch[switchKey(row.name)] = row.entity_id;
  }
  return model;
}

function portKey(what) {
  const map = {
    "link": "link",
    "link speed": "speed",
    "tx packets": "txPackets",
    "rx packets": "rxPackets",
    "tx bad packets": "txBad",
    "rx bad packets": "rxBad",
    "tx rate": "txRate",
    "rx rate": "rxRate",
    "mac addresses learned": "macs",
  };
  return map[what] || what.replace(/\s+(\w)/g, (_, c) => c.toUpperCase());
}

function switchKey(name) {
  const map = {
    "Firmware version": "firmware",
    "Uptime": "uptime",
    "Chip temperature": "temperature",
    "Ports up": "portsUp",
    "IP address": "ip",
    "Hostname": "hostname",
    "MAC address": "mac",
  };
  return map[name] || name;
}

/** Find the PoE device when none is configured: the ESPHome device with the most "PoE Port N" entities. */
export function pickPoeDevice(registry) {
  const counts = {};
  for (const row of Object.values(registry)) {
    if (row.platform === ESPHOME_PLATFORM && row.device_id && /^PoE Port \d+$/.test(row.name || "")) {
      counts[row.device_id] = (counts[row.device_id] || 0) + 1;
    }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

/**
 * Map the ESPHome PoE device to per-port PoE entities.
 * Assumption to confirm on the owner's setup: PoE port N feeds RJ45 port N.
 */
export function discoverPoe(registry, poeDeviceId) {
  const model = { deviceId: poeDeviceId, ports: {}, totalPower: null, totalCurrent: null };
  if (!poeDeviceId) return model;
  for (const row of Object.values(registry)) {
    if (row.device_id !== poeDeviceId || row.platform !== ESPHOME_PLATFORM || !row.name) continue;
    let m;
    if ((m = /^Port (\d+) PoE powered$/.exec(row.name))) portSlot(model, m[1]).powered = row.entity_id;
    else if ((m = /^Port (\d+) overcurrent$/.exec(row.name))) portSlot(model, m[1]).overcurrent = row.entity_id;
    else if ((m = /^Port (\d+) startup fault$/.exec(row.name))) portSlot(model, m[1]).startupFault = row.entity_id;
    else if ((m = /^Port (\d+) voltage$/.exec(row.name))) portSlot(model, m[1]).voltage = row.entity_id;
    else if ((m = /^PoE Port (\d+)$/.exec(row.name))) portSlot(model, m[1]).control = row.entity_id;
    else if (row.name === "PoE total power") model.totalPower = row.entity_id;
    else if (row.name === "PoE total current") model.totalCurrent = row.entity_id;
  }
  return model;
}

function portSlot(model, port) {
  return (model.ports[Number(port)] ||= { port: Number(port) });
}

/** Sum of per-entity history rows, bucketed to whole minutes. Last value per entity per bucket, missing treated as 0. */
export function bucketHistory(series, bucketSec = 60) {
  const bucketed = {};
  for (const [, rows] of Object.entries(series || {})) {
    for (const row of rows || []) {
      const v = Number(row.s);
      if (!Number.isFinite(v)) continue;
      const t = Math.floor(Date.parse(row.lu ?? row.last_updated) / 1000 / bucketSec) * bucketSec;
      if (!Number.isFinite(t)) continue;
      bucketed[t] = bucketed[t] || {};
      bucketed[t][row.__id] = v;
    }
  }
  return Object.keys(bucketed).map(Number).sort((a, b) => a - b).map((t) => ({
    t,
    v: Object.values(bucketed[t]).reduce((a, b) => a + b, 0),
  }));
}

export function formatRate(pps) {
  if (pps === null || pps === undefined || !Number.isFinite(Number(pps))) return "–";
  const n = Number(pps);
  if (n >= 1000) return `${(n / 1000).toFixed(1)} kpkt/s`;
  return `${n.toFixed(n < 10 ? 1 : 0)} pkt/s`;
}

export function formatUptime(seconds) {
  const s = Math.floor(Number(seconds));
  if (!Number.isFinite(s)) return "–";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- card ----------

// Plain base class outside the browser, so the pure helpers can be tested in Node.
const CardBase = typeof HTMLElement !== "undefined" ? HTMLElement : class {};

class RtlPlaygroundCard extends CardBase {
  constructor() {
    super();
    if (!this.attachShadow) return;
    this.attachShadow({ mode: "open" });
    this._selected = null;
    this._history = null;
    this._historyAt = 0;
    this._historyKey = "";
  }

  setConfig(config) {
    if (config && config.poe_budget_w !== undefined && !(Number(config.poe_budget_w) > 0)) {
      throw new Error("poe_budget_w must be a positive number");
    }
    this._config = { title: "", history_hours: 1, ...(config || {}) };
    this._registryKey = "";
    this._render();
  }

  getCardSize() {
    return 14;
  }

  set hass(hass) {
    this._hass = hass;
    const registry = indexRegistry(hass.entities || {});
    const key = Object.keys(registry).length;
    if (!this._rtl || key !== this._registryKey) {
      this._registryKey = key;
      this._registry = registry;
      this._deviceId = this._config?.device_id || pickRtlDevice(registry);
      this._rtl = discoverRtl(registry, this._deviceId);
      this._poeDeviceId = this._config?.poe_device_id || pickPoeDevice(registry);
      this._poe = discoverPoe(registry, this._poeDeviceId);
    }
    this._render();
    this._maybeLoadHistory();
  }

  // ----- state helpers -----
  _state(entityId) {
    return entityId ? this._hass?.states?.[entityId] : undefined;
  }

  _value(entityId) {
    const s = this._state(entityId);
    return s && !UNAVAILABLE_STATES.has(s.state) ? s.state : null;
  }

  _num(entityId) {
    const v = this._value(entityId);
    return v === null ? null : Number(v);
  }

  _isOn(entityId) {
    const s = this._state(entityId);
    if (!s || UNAVAILABLE_STATES.has(s.state)) return null;
    return s.state === "on";
  }

  _rtlUnavailable() {
    if (!this._rtl || !this._deviceId) return "No RTLPlayground device found. Add the integration or set device_id.";
    const probe = this._rtl.switch.portsUp || Object.values(this._rtl.ports)[0]?.link;
    if (!probe) return "No RTLPlayground entities for this device.";
    const s = this._state(probe);
    if (!s || UNAVAILABLE_STATES.has(s.state)) {
      return "The switch is unreachable. Values below are not current.";
    }
    return null;
  }

  // ----- history -----
  _maybeLoadHistory() {
    if (!this._hass?.callWS || !this._rtl) return;
    const ids = Object.values(this._rtl.ports).flatMap((p) => [p.txRate, p.rxRate]).filter(Boolean);
    if (!ids.length) return;
    const key = ids.join(",");
    const stale = Date.now() - this._historyAt > 60000;
    if (key === this._historyKey && !stale) return;
    if (this._historyPending) return;
    this._historyPending = true;
    this._historyKey = key;
    const end = new Date();
    const start = new Date(end.getTime() - (this._config.history_hours || 1) * 3600 * 1000);
    this._hass.callWS({
      type: "history/history_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      entity_ids: ids,
      minimal_response: true,
      no_attributes: true,
    }).then((res) => {
      const series = {};
      for (const id of ids) {
        series[id] = (res[id] || []).map((row) => ({ ...row, __id: id }));
      }
      this._history = bucketHistory(series, 60);
      this._historyAt = Date.now();
    }).catch(() => {
      this._history = null;
    }).finally(() => {
      this._historyPending = false;
      this._render();
    });
  }

  // ----- actions (always confirmed) -----
  async _call(domain, service, entityId, label) {
    if (!entityId) return;
    if (!window.confirm(label)) return;
    try {
      await this._hass.callService(domain, service, { entity_id: entityId });
    } catch (err) {
      window.alert(`The switch did not accept the change: ${err?.message || err}`);
    }
  }

  // ----- render -----
  _render() {
    if (!this.shadowRoot || !this._config) return;
    if (!this._hass) {
      this.shadowRoot.innerHTML = `<ha-card><div class="pad">Waiting for Home Assistant…</div></ha-card>`;
      return;
    }
    const unavailable = this._rtlUnavailable();
    const sw = this._rtl?.switch || {};
    const night = this._rtl?.night;
    const nightOn = this._isOn(night);
    const ports = this._rtl ? Object.values(this._rtl.ports).sort((a, b) => a.port - b.port) : [];
    const rj45 = ports.filter((p) => !this._isSfp(p.port));
    const sfp = ports.filter((p) => this._isSfp(p.port));

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="header">
          <div class="title">${escapeHtml(this._config.title || this._hostnameOr("Switch"))}</div>
          ${night ? `<button class="night ${nightOn ? "on" : ""}" data-action="night" ${unavailable ? "disabled" : ""}>
            <span class="dot"></span>Night mode ${nightOn === null ? "–" : nightOn ? "on" : "off"}</button>` : ""}
        </div>
        ${unavailable ? `<div class="banner">${escapeHtml(unavailable)}</div>` : ""}
        <div class="section">
          <div class="label">Front panel</div>
          <div class="row rj45">${rj45.map((p) => this._tile(p)).join("")}</div>
          ${sfp.length ? `<div class="row sfp">${sfp.map((p) => this._tile(p)).join("")}</div>` : ""}
        </div>
        ${this._selected ? this._detail(this._selected) : ""}
        ${this._poeDeviceId ? this._poePanel() : ""}
        <div class="section">
          <div class="label">Traffic (last ${this._config.history_hours} h)</div>
          ${this._trafficChart()}
          <div class="totals">${this._totals()}</div>
        </div>
        ${this._infoPanel()}
      </ha-card>`;
    this._bind();
  }

  _isSfp(port) {
    // Physical ports 5 and 6 are the SFP cages on the HG0402XG. Confirmed by ports.json on the live switch.
    return port >= 5;
  }

  _hostnameOr(fallback) {
    return this._value(this._rtl?.switch?.hostname) || fallback;
  }

  _tile(p) {
    const linkOn = this._isOn(p.link);
    const speed = this._value(p.speed);
    const rate = (this._num(p.txRate) || 0) + (this._num(p.rxRate) || 0);
    const active = linkOn && rate > 0;
    const poe = this._poe.ports[p.port];
    const poeOn = poe ? this._isOn(poe.powered) : null;
    const cls = ["tile"];
    if (linkOn === null) cls.push("unknown");
    else if (linkOn) cls.push("up");
    if (this._selected === p.port) cls.push("selected");
    if (this._isSfp(p.port)) cls.push("sfp");
    const intensity = Math.min(1, Math.log10(1 + rate) / 3);
    return `
      <button class="${cls.join(" ")}" data-port="${p.port}">
        <div class="pnum">${p.port}</div>
        <div class="speed">${linkOn ? escapeHtml(speed || "up") : linkOn === false ? "down" : "–"}</div>
        <div class="activity"><span class="bar ${active ? "live" : ""}" style="--i:${intensity.toFixed(2)}"></span></div>
        ${poeOn === true ? `<div class="poe">PoE</div>` : ""}
      </button>`;
  }

  _detail(port) {
    const p = this._rtl.ports[port];
    if (!p) return "";
    const poe = this._poe.ports[port];
    const rows = [
      ["Link", this._isOn(p.link) === null ? "–" : this._isOn(p.link) ? "up" : "down"],
      ["Speed", this._value(p.speed) || "–"],
      ["TX packets", this._value(p.txPackets) ?? "–"],
      ["RX packets", this._value(p.rxPackets) ?? "–"],
      ["TX bad", this._value(p.txBad) ?? "–"],
      ["RX bad", this._value(p.rxBad) ?? "–"],
      ["TX rate", formatRate(this._num(p.txRate))],
      ["RX rate", formatRate(this._num(p.rxRate))],
      ["MAC addresses", this._value(p.macs) ?? "–"],
    ];
    const poeRows = poe ? [
      ["PoE powered", this._isOn(poe.powered) === null ? "–" : this._isOn(poe.powered) ? "yes" : "no"],
      ["Voltage", this._value(poe.voltage) ? `${Number(this._value(poe.voltage)).toFixed(1)} V` : "–"],
      ["Overcurrent", this._isOn(poe.overcurrent) ? "yes" : "no"],
      ["Startup fault", this._isOn(poe.startupFault) ? "yes" : "no"],
    ] : [];
    const offline = Boolean(this._rtlUnavailable());
    const control = poe?.control ? `<button class="action" data-action="poe" data-entity="${escapeHtml(poe.control)}" data-port="${port}" ${offline ? "disabled" : ""}>
      ${this._isOn(poe.control) ? "Turn PoE off" : "Turn PoE on"}</button>` : "";
    return `
      <div class="section detail">
        <div class="label">Port ${port}</div>
        <dl>${[...rows, ...poeRows].map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>
        ${control}
      </div>`;
  }

  _poePanel() {
    const totalW = this._num(this._poe.totalPower);
    const totalMa = this._num(this._poe.totalCurrent);
    const budget = this._config.poe_budget_w ? Number(this._config.poe_budget_w) : null;
    const pct = budget && totalW !== null ? Math.min(100, (totalW / budget) * 100) : null;
    const portsRows = Object.values(this._poe.ports).sort((a, b) => a.port - b.port).map((p) => {
      const on = this._isOn(p.powered);
      return `<span class="chip ${on ? "on" : ""}">Port ${p.port}: ${on === null ? "–" : on ? "powered" : "off"}</span>`;
    }).join("");
    return `
      <div class="section">
        <div class="label">PoE</div>
        <div class="poe-total">
          <div><b>${totalW === null ? "–" : totalW.toFixed(1)}</b> W draw${budget ? ` of ${budget} W` : ""}</div>
          <div class="muted">${totalMa === null ? "" : `${totalMa.toFixed(0)} mA`}${budget ? "" : " · set poe_budget_w to show a budget"}</div>
          ${pct !== null ? `<div class="meter"><span style="width:${pct.toFixed(1)}%"></span></div>` : ""}
        </div>
        <div class="chips">${portsRows}</div>
      </div>`;
  }

  _trafficChart() {
    if (!this._history || this._history.length < 2) {
      return `<div class="muted">Not enough history yet.</div>`;
    }
    const pts = this._history;
    const max = Math.max(1, ...pts.map((p) => p.v));
    const w = 300, h = 60;
    const step = w / (pts.length - 1);
    const path = pts.map((p, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(h - (p.v / max) * (h - 4) - 2).toFixed(1)}`).join(" ");
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Total packet rate"><path d="${path}" /></svg>
      <div class="muted">peak ${formatRate(max)}</div>`;
  }

  _totals() {
    if (this._rtlUnavailable()) return "TX – · RX –";
    let tx = 0, rx = 0;
    for (const p of Object.values(this._rtl?.ports || {})) {
      tx += this._num(p.txRate) || 0;
      rx += this._num(p.rxRate) || 0;
    }
    return `TX ${formatRate(tx)} · RX ${formatRate(rx)}`;
  }

  _infoPanel() {
    const s = this._rtl?.switch || {};
    const items = [
      ["Firmware", this._value(s.firmware)],
      ["Uptime", this._value(s.uptime) ? formatUptime(this._value(s.uptime)) : null],
      ["Chip temp", this._value(s.temperature) ? `${this._value(s.temperature)} °C` : null],
      ["IP", this._value(s.ip)],
      ["MAC", this._value(s.mac)],
    ].filter(([, v]) => v);
    if (!items.length) return "";
    return `<div class="section info">${items.map(([k, v]) => `<span><b>${k}</b> ${escapeHtml(v)}</span>`).join("")}</div>`;
  }

  _bind() {
    this.shadowRoot.querySelectorAll("button[data-port]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const port = Number(btn.dataset.port);
        this._selected = this._selected === port ? null : port;
        this._render();
      });
    });
    this.shadowRoot.querySelector("button[data-action='night']")?.addEventListener("click", () => {
      const on = this._isOn(this._rtl.night);
      this._call("switch", on ? "turn_off" : "turn_on", this._rtl.night,
        on ? "Turn night mode off? The LEDs will come back on." : "Turn night mode on? All LEDs on the switch will go off.");
    });
    this.shadowRoot.querySelector("button[data-action='poe']")?.addEventListener("click", (ev) => {
      const btn = ev.currentTarget;
      const on = this._isOn(btn.dataset.entity);
      this._call("switch", on ? "turn_off" : "turn_on", btn.dataset.entity,
        `${on ? "Turn PoE off" : "Turn PoE on"} for port ${btn.dataset.port}? A device on that port will lose power.`);
    });
  }

  static getStubConfig(hass) {
    return { title: "Switch", history_hours: 1 };
  }
}

const STYLE = `
  :host { display: block; }
  ha-card { padding: 12px 16px 16px; }
  .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .title { font-size: 1.15em; font-weight: 500; }
  .label { font-size: .8em; text-transform: uppercase; letter-spacing: .06em; opacity: .6; margin: 12px 0 6px; }
  .section { margin-top: 4px; }
  .pad { padding: 16px; }
  .muted { opacity: .65; font-size: .9em; }
  .banner { margin: 8px 0; padding: 8px 10px; border-radius: 8px; background: rgba(219, 68, 55, .15); color: var(--error-color, #db4437); }
  .night { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--divider-color, #ccc); background: none; border-radius: 16px; padding: 4px 10px; color: inherit; cursor: pointer; font: inherit; }
  .night .dot { width: 8px; height: 8px; border-radius: 50%; background: #888; }
  .night.on .dot { background: #f5b335; }
  .night:disabled { opacity: .5; cursor: default; }
  .row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .row.sfp { grid-template-columns: repeat(2, 1fr); margin-top: 8px; }
  .tile { position: relative; border: 1px solid var(--divider-color, #ccc); border-radius: 8px; padding: 6px 4px 8px; background: var(--card-background-color, #fff); color: inherit; font: inherit; cursor: pointer; text-align: center; }
  .tile.up { border-color: #43a047; }
  .tile.selected { box-shadow: 0 0 0 2px var(--primary-color, #03a9f4); }
  .tile.unknown { opacity: .5; }
  .tile.sfp { border-style: dashed; }
  .pnum { font-weight: 600; }
  .speed { font-size: .8em; opacity: .75; min-height: 1.2em; }
  .activity { height: 4px; margin: 6px 6px 0; background: rgba(127,127,127,.2); border-radius: 2px; overflow: hidden; }
  .bar { display: block; height: 100%; width: 0; background: #03a9f4; }
  .bar.live { width: calc(var(--i) * 100%); transition: width .8s ease; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .5; } }
  .poe { position: absolute; top: 2px; right: 4px; font-size: .65em; color: #f5b335; font-weight: 600; }
  .detail { border-top: 1px solid var(--divider-color, #ccc); padding-top: 8px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 4px 0 8px; }
  dt { opacity: .7; } dd { margin: 0; text-align: right; }
  .action:disabled { opacity: .4; cursor: default; }
  .action { border: 1px solid var(--primary-color, #03a9f4); background: none; color: var(--primary-color, #03a9f4); border-radius: 8px; padding: 6px 12px; font: inherit; cursor: pointer; }
  .poe-total b { font-size: 1.4em; font-weight: 500; }
  .meter { height: 6px; border-radius: 3px; background: rgba(127,127,127,.2); margin-top: 6px; overflow: hidden; }
  .meter span { display: block; height: 100%; background: #f5b335; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip { font-size: .8em; padding: 2px 8px; border-radius: 12px; border: 1px solid var(--divider-color, #ccc); opacity: .7; }
  .chip.on { opacity: 1; border-color: #f5b335; }
  .chart { width: 100%; height: 60px; display: block; }
  .chart path { fill: none; stroke: #03a9f4; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .totals { margin-top: 4px; font-size: .9em; }
  .info { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: .9em; border-top: 1px solid var(--divider-color, #ccc); padding-top: 8px; margin-top: 12px; }
  @media (max-width: 480px) { .row { grid-template-columns: repeat(2, 1fr); } }
`;

if (typeof customElements !== "undefined" && !customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, RtlPlaygroundCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: CARD_TAG,
    name: "RTLPlayground",
    description: "Front panel, PoE, traffic and night mode for the RTLPlayground switch.",
  });
}
