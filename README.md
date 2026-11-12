# RTLPlayground Dashboard

A Lovelace card for the RTLPlayground switch. It shows the front panel with six ports,
port detail, the PoE panel, a traffic chart, night mode and switch info. The PoE data
comes from the ESPHome PoE device, so the card takes **two devices as input**.

It needs the [RTLPlayground integration](https://github.com/aalaei/ha-rtlplayground), which
creates the switch device. The ESPHome PoE device is the one with "PoE Port N" entities.

## Install (HACS)

1. HACS → Frontend → ⋮ → Custom repositories → add `https://github.com/aalaei/ha-rtlplayground-dashboard`, category **Dashboard**.
2. Install "RTLPlayground Dashboard". HACS adds the resource for you.
3. Add the card in the dashboard editor: **Manual** card, paste the config below.

## Config

Both device pickers are optional. Each is found automatically when it is left out.

```yaml
type: custom:rtlplayground-card
device_id: <RTLPlayground switch device>   # optional
poe_device_id: <ESPHome PoE device>        # optional
poe_budget_w: 60                           # optional: shows "draw of N W"
title: Switch                              # optional
history_hours: 1                           # optional
```

For a two-switch setup, set `device_id` and `poe_device_id` to pick the right devices.

## Behaviour

- Each write asks for confirmation first: night mode, and PoE on or off per port.
- When the switch is unreachable, a banner shows and values read `–`. Nothing stale is shown as current.
- PoE port N is assumed to feed RJ45 port N. Check that on your setup.
- The PoE budget is not exposed by Home Assistant. Set `poe_budget_w` to show it.

## Develop

```
npm test   # Node tests for the helper functions
```

`tests/render.html` renders the card with a mock Home Assistant. Serve the repo over HTTP and
open the page in a browser (Chrome does not load modules from `file://`).
