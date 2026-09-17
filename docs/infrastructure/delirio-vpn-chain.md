# Delirio Tropical — VPN Chain & Network Infrastructure

> **Status:** Production ✅ | Last updated: 2026-09-17

## Architecture Overview

```
Internet
│
├── Azure VM  (vm-dt-manager, rg-dt-manager)
│     Public IP:  20.226.33.21
│     Private IP: 10.0.0.4 / 10.0.0.0/24
│     Service:    dt-manager (Node.js + PM2, port 3847)
│     VPN:        IPsec strongSwan → Metro pfSense
│
└── Metro pfSense  (Headquarters)
      Public IP: 201.76.172.74
      LAN IP:    192.168.14.1 / 192.168.14.0/24
      Web admin: https://metro.delirio.com.br:50100/
      VPN hub:   IPsec con11 → EC pfSense (and other spokes)
      │
      └── EC pfSense  (Store unit)
            LAN IP:    192.168.17.1 / 192.168.17.0/24
            Web admin: https://ec.delirio.com.br:50100/
            │
            └── Servidor Skill  (Windows Server)
                  IP:      192.168.17.252
                  Service: dt-clock-proxy (Node.js, port 4321)
```

## Full Connection Chain

```
dt-manager (Azure :3847)
  → CLOCK_PROXY_URL = http://192.168.14.1:4321
  → [IPsec azure-to-metro | strongSwan | 10.0.0.0/24 ↔ 192.168.14.0/24]
  → Metro pfSense Perl proxy (:4321)
  → [IPsec con11{9434} | FreeBSD kernel | reqid=7 | 192.168.14.0/24 ↔ 192.168.17.0/24]
  → EC pfSense Perl proxy (:4321)
  → [LAN 192.168.17.0/24]
  → Servidor Skill dt-clock-proxy (:4321)
```

## IPsec Tunnels

### azure-to-metro (Azure VM ↔ Metro pfSense)
- **Tool:** strongSwan (Ubuntu, Azure VM)
- **Coverage:** `10.0.0.0/24 === 192.168.14.0/24`
- **Auth:** PSK
- **NAT-T:** Enabled (ESP in UDP)
- **Boot persistence:** `systemctl enable strongswan-starter`
- **Self-healing (since 2026-09-17):** `keyingtries=%forever` + `closeaction=restart` in
  `/etc/ipsec.conf` — strongSwan retries reconnection forever instead of giving up permanently
  after 3 rounds. Belt-and-suspenders: `ipsec-watchdog-metro.timer` (systemd, every 3min) force
  re-runs `ipsec up azure-to-metro` if the SA is down. See [Key Lessons Learned #5](#5-keyingtries-default-of-3-causes-permanent-tunnel-death) below and
  `infra/ipsec-watchdog-metro.sh`.

```bash
# Health check
ipsec status
# Expected:
# azure-to-metro[N]: ESTABLISHED
# azure-to-metro{N}: INSTALLED, TUNNEL, reqid 1, ESP in UDP
# azure-to-metro{N}:  10.0.0.0/24 === 192.168.14.0/24
```

### con11 (Metro pfSense ↔ EC pfSense)
- **Tool:** FreeBSD kernel IPsec (managed via pfSense UI)
- **SA:** con11{9434}, reqid=7
- **Coverage:** `192.168.14.0/24 === 192.168.17.0/24`
- **Topology:** Hub (Metro) → Spoke (EC)

## Perl TCP Proxies

Both pfSense routers run a Perl TCP proxy to bridge the IPsec hops.

### Why a Perl proxy?

The dt-manager on Azure needs to reach the Windows service at 192.168.17.252:4321. The two IPsec tunnels don't chain automatically — traffic from Azure arrives at Metro's LAN interface, but then needs to traverse the second tunnel to reach EC's network. The Perl proxy on each pfSense bridges this gap.

### Critical: LocalAddr binding

**On FreeBSD, sockets without an explicit `LocalAddr` use the WAN IP as source.** This causes packets to bypass the IPsec SPD (which only matches LAN subnet traffic), resulting in connection timeouts even though the VPN is up.

```perl
# ❌ WRONG — uses WAN IP as source, bypasses IPsec SPD
IO::Socket::INET->new(PeerAddr => "192.168.17.252", PeerPort => 4321, ...);

# ✅ CORRECT — forces LAN IP as source, packets match IPsec policy
IO::Socket::INET->new(
    LocalAddr => "192.168.14.1",   # LAN interface IP
    PeerAddr  => "192.168.17.252",
    PeerPort  => 4321,
    ...
);
```

### Proxy Files

| pfSense | Script path | Listen | Forward to | LocalAddr |
|---|---|---|---|---|
| Metro | `/usr/local/bin/clock-proxy.pl` | `192.168.14.1:4321` | `192.168.17.252:4321` | `192.168.14.1` |
| EC | `/usr/local/bin/clock-proxy.pl` | `192.168.17.1:4321` | `192.168.17.252:4321` | `192.168.17.1` |

### Boot persistence (FreeBSD rc.d)

Both proxies have startup scripts at `/usr/local/etc/rc.d/clock-proxy.sh`:

```sh
#!/bin/sh
# PROVIDE: clock_proxy
# REQUIRE: NETWORKING
perl /usr/local/bin/clock-proxy.pl >/dev/null 2>&1 &
```

> ⚠️ The `&` is mandatory — without it, the rc.d script blocks and the system hangs at boot.

## dt-manager Configuration (Azure VM)

File: `/opt/dt-manager/ecosystem.config.js`

```js
{
  CLOCK_PROXY_URL:   'http://192.168.14.1:4321',  // Metro pfSense proxy
  CLOCK_PROXY_TOKEN: '<token>',
  PORT:              3847,                         // NOT 3000
}
```

After changing env vars, **must** reload with:
```bash
pm2 restart ecosystem.config.js --update-env
```

## Health Check

```bash
# From Azure VM (via az vm run-command)
curl http://localhost:3847/api/rh/clocks/status
# Expected: {"total":9,"reachable":6,"unreachable":3,...}
```

## Key Lessons Learned

### 1. FreeBSD source IP selection (root cause of 502 errors)

FreeBSD routes outbound sockets to the interface matching the destination route. For non-LAN destinations, this is the WAN interface. The IPsec SPD only matches packets whose source IP falls within the configured LAN subnet — so WAN-sourced packets bypass IPsec entirely.

**Diagnosis:** `ping -S 192.168.14.1 192.168.17.252` succeeds but `ping 192.168.17.252` fails → source IP is wrong.

**Fix:** Always specify `LocalAddr` with the LAN interface IP in any socket that needs to traverse an IPsec tunnel.

### 2. PM2 --update-env is required

`pm2 restart <name>` does not reload `ecosystem.config.js` environment variables. Always use:
```bash
pm2 restart ecosystem.config.js --update-env
```

### 3. FreeBSD rc.d startup scripts

The `&` at the end of the command is required for background execution. Without it, rc.d waits indefinitely for the process to exit, stalling the boot sequence.

### 4. pfSense diag_command.php has two separate forms

The Diagnostics → Command Prompt page has shell (EXEC) and PHP (EXECPHP) buttons. The PHP form is needed to write files. When automating via browser, always use `button[name="submit"][value="EXECPHP"]` — not `button[type="submit"]` which matches the shell button first.

### 5. keyingtries default of 3 causes permanent tunnel death

**Symptom:** `azure-to-metro` would die and stay dead for 24h+, requiring manual `ipsec up`
every day ("recriar o túnel"), even though the underlying network blip lasted only minutes.

**Root cause:** `/etc/ipsec.conf` never set `keyingtries` for `conn azure-to-metro`. strongSwan's
default is **3**. Whenever the peer (Metro pfSense WAN, `201.76.172.74`) stopped responding to
IKE for longer than ~9 minutes (transient network blip, pfSense reboot, ISP hiccup), `dpdaction=restart`
fired 3 reconnection rounds (~2-3min each with retransmit backoff), and after the 3rd failure
charon logged `giving up after 5 retransmits` / `establishing IKE_SA failed, peer not responding`
and **never tried again** — the tunnel stayed down until a human ran `ipsec up` manually.
Confirmed via `journalctl -u strongswan-starter`: last retry attempt 2026-09-16 02:17 UTC, tunnel
dead until manually restored 2026-09-17 21:26 UTC (>24h) — and the peer answered on the very
first attempt, proving the network/peer was not actually unreachable that whole time.

**Fix (`/etc/ipsec.conf`, `conn azure-to-metro`):**
```
keyingtries=%forever   # never give up permanently — keep retrying indefinitely
closeaction=restart    # also reconnect on an explicit peer-initiated SA delete, not just DPD timeout
```
`systemctl restart strongswan-starter` to apply.

**Defense in depth:** `infra/ipsec-watchdog-metro.sh` + `ipsec-watchdog-metro.timer` (systemd,
every 3min, `enable --now` so it survives reboot) — checks `ipsec statusall azure-to-metro` for
`(0 up`; if down, forces `ipsec up azure-to-metro` and logs to `/var/log/ipsec-watchdog.log`.
This is independent of the `keyingtries` fix — even if the infinite-retry logic itself ever stalls,
the watchdog catches it within 3 minutes instead of 24+ hours.

**Not yet investigated:** why the peer periodically stops responding to IKE in the first place
(dynamic WAN IP? pfSense reboot cadence? ISP flapping?). Not currently critical since the fix
above guarantees self-healing within minutes regardless of cause — worth revisiting only if
outages become very frequent (many times a day).

---

*See also: [IPsec + Perl Proxy Troubleshooting](./ipsec-perl-proxy-troubleshooting.md)*
