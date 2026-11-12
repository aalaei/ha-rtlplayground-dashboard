// Run with: node --test tests/card/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  indexRegistry, parsePortName, pickRtlDevice, pickPoeDevice, discoverRtl, discoverPoe,
  bucketHistory, formatRate, formatUptime, escapeHtml,
} from "../rtlplayground-card.js";

const DEV = "dev-rtl";
const POE = "poe-dev-test";

// Entity names as the integration and ESPHome register them (see sensor.py, binary_sensor.py, switch.py).
const rows = [
  { ei: "sensor.p1_link_speed", di: DEV, pl: "rtlplayground", en: "Port 1 link speed" },
  { ei: "sensor.p1_tx_packets", di: DEV, pl: "rtlplayground", en: "Port 1 tx packets" },
  { ei: "sensor.p1_tx_rate", di: DEV, pl: "rtlplayground", en: "Port 1 tx rate" },
  { ei: "sensor.p1_rx_rate", di: DEV, pl: "rtlplayground", en: "Port 1 rx rate" },
  { ei: "sensor.p1_macs", di: DEV, pl: "rtlplayground", en: "Port 1 mac addresses learned" },
  { ei: "binary_sensor.p1_link", di: DEV, pl: "rtlplayground", en: "Port 1 link" },
  { ei: "sensor.ports_up", di: DEV, pl: "rtlplayground", en: "Ports up" },
  { ei: "switch.night", di: DEV, pl: "rtlplayground", en: "Night mode" },
  { ei: "sensor.uptime", di: DEV, pl: "rtlplayground", en: "Uptime" },
  { ei: "sensor.poe_power", di: POE, pl: "esphome", en: "PoE total power" },
  { ei: "sensor.poe_current", di: POE, pl: "esphome", en: "PoE total current" },
  { ei: "binary_sensor.poe1_powered", di: POE, pl: "esphome", en: "Port 1 PoE powered" },
  { ei: "binary_sensor.poe1_overcurrent", di: POE, pl: "esphome", en: "Port 1 overcurrent" },
  { ei: "switch.poe1", di: POE, pl: "esphome", en: "PoE Port 1" },
  { ei: "sensor.other", di: "other-dev", pl: "esphome", en: "PoE Port 1" },
];

test("registry rows in server and frontend shapes both index", () => {
  const idx = indexRegistry(rows);
  assert.equal(idx["sensor.p1_link_speed"].platform, "rtlplayground");
  assert.equal(idx["sensor.p1_link_speed"].device_id, DEV);
  const alt = indexRegistry([{ entity_id: "a.b", device_id: "d", platform: "x", name: "Ports up" }]);
  assert.equal(alt["a.b"].name, "Ports up");
});

test("port names parse to port numbers and keys", () => {
  assert.deepEqual(parsePortName("Port 3 link speed"), { port: 3, what: "link speed" });
  assert.equal(parsePortName("Uptime"), null);
});

test("device is picked by owned RTLPlayground entities, never the ESPHome device", () => {
  assert.equal(pickRtlDevice(indexRegistry(rows)), DEV);
});

test("RTLPlayground entities map to ports, switch values and the night switch", () => {
  const m = discoverRtl(indexRegistry(rows), DEV);
  assert.equal(m.ports[1].speed, "sensor.p1_link_speed");
  assert.equal(m.ports[1].txRate, "sensor.p1_tx_rate");
  assert.equal(m.ports[1].macs, "sensor.p1_macs");
  assert.equal(m.ports[1].link, "binary_sensor.p1_link");
  assert.equal(m.switch.portsUp, "sensor.ports_up");
  assert.equal(m.switch.uptime, "sensor.uptime");
  assert.equal(m.night, "switch.night");
});

test("ESPHome PoE entities map per port and totals, and only from the chosen device", () => {
  const m = discoverPoe(indexRegistry(rows), POE);
  assert.equal(m.ports[1].powered, "binary_sensor.poe1_powered");
  assert.equal(m.ports[1].overcurrent, "binary_sensor.poe1_overcurrent");
  assert.equal(m.ports[1].control, "switch.poe1");
  assert.equal(m.totalPower, "sensor.poe_power");
  assert.equal(m.totalCurrent, "sensor.poe_current");
  // The other device also has "PoE Port 1", and it must not leak in.
  assert.equal(m.ports[1].control, "switch.poe1");
});

test("PoE device is auto-detected as the ESPHome device with PoE port entities", () => {
  assert.equal(pickPoeDevice(indexRegistry(rows)), POE);
});

test("no PoE device configured gives an empty PoE model", () => {
  const m = discoverPoe(indexRegistry(rows), undefined);
  assert.deepEqual(m.ports, {});
});

test("history buckets sum the last value of each entity per minute", () => {
  const t0 = Date.parse("2026-11-12T10:00:10Z");
  const t1 = Date.parse("2026-11-12T10:01:10Z");
  const series = {
    a: [{ s: "5", lu: new Date(t0).toISOString(), __id: "a" }, { s: "7", lu: new Date(t1).toISOString(), __id: "a" }],
    b: [{ s: "2", lu: new Date(t0).toISOString(), __id: "b" }, { s: "unavailable", lu: new Date(t1).toISOString(), __id: "b" }],
  };
  const out = bucketHistory(series, 60);
  assert.deepEqual(out.map((p) => p.v), [7, 7]);
  assert.equal(out[1].t - out[0].t, 60);
});

test("formatters", () => {
  assert.equal(formatRate(null), "–");
  assert.equal(formatRate(5.25), "5.3 pkt/s");
  assert.equal(formatRate(2500), "2.5 kpkt/s");
  assert.equal(formatUptime(1305), "21m 45s");
  assert.equal(formatUptime(90000), "1d 1h 0m");
});

test("escapeHtml protects dynamic text", () => {
  assert.equal(escapeHtml(`<img src=x onerror="a">`), "&lt;img src=x onerror=&quot;a&quot;&gt;");
});
