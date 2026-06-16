# IPsec + Perl Proxy — Troubleshooting Guide

> Root cause analysis and fix for 502 errors in the RH module of Delirio Manager.
> Session: 2026-06-16

## Problem Statement

The RH module of `dt-manager` (Azure VM) was returning 502 errors when trying to reach `dt-clock-proxy` (Servidor Skill, 192.168.17.252:4321). The VPN showed as "ESTABLISHED" in all monitoring, but HTTP requests timed out.

## Root Cause

**FreeBSD source IP selection bypasses IPsec SPD.**

The Perl proxy on Metro pfSense was opening outbound TCP connections without specifying a `LocalAddr`. FreeBSD routed these through the WAN interface, using the WAN IP (201.76.172.74) as the source address.

The IPsec kernel policy (SPD) only matches traffic sourced from `192.168.14.0/24`. Packets with WAN source bypass the SPD and are sent directly to the internet — the Servidor Skill receives nothing.

## Diagnostic Sequence

### Step 1: Confirm VPN is truly up

```bash
# On Azure VM
ipsec status
# Look for: ESTABLISHED + INSTALLED + bytes counter > 0
```

### Step 2: Test connectivity from Metro pfSense

```sh
# In Metro pfSense diag_command.php (Shell tab):

# Test without source binding — likely fails or hangs
curl --max-time 8 http://192.168.17.252:4321/

# Test WITH explicit LAN source — should return {"error":"Unauthorized"} (connection works!)
curl --interface 192.168.14.1 http://192.168.17.252:4321/
```

If the second command works but the first doesn't: **source IP is the problem**.

### Step 3: Ping test

```sh
# Without -S: kernel picks WAN IP as source → bypasses IPsec → fails
ping -c3 192.168.17.252

# With -S: forces LAN IP → matches IPsec SPD → goes through tunnel → works
ping -S 192.168.14.1 -c3 192.168.17.252
```

### Step 4: Verify proxy socket behavior

```sh
sockstat -l | grep 4321    # is proxy listening?
ps aux | grep perl          # is process running?
```

## The Fix

### Perl proxy (`/usr/local/bin/clock-proxy.pl` on Metro pfSense)

Add `LocalAddr` to the backend socket:

```perl
# BEFORE (broken):
my $b = IO::Socket::INET->new(
    PeerAddr => "192.168.17.252",
    PeerPort => 4321,
    Proto    => "tcp",
    Timeout  => 10
);

# AFTER (fixed):
my $b = IO::Socket::INET->new(
    LocalAddr => "192.168.14.1",   # ← THE FIX
    PeerAddr  => "192.168.17.252",
    PeerPort  => 4321,
    Proto     => "tcp",
    Timeout   => 10
);
```

### PM2 env vars reload

After updating `CLOCK_PROXY_URL` in `ecosystem.config.js`:

```bash
# WRONG — does not reload env vars:
pm2 restart dt-manager

# CORRECT:
pm2 restart ecosystem.config.js --update-env
```

## Complete Perl Proxy Script

```perl
use IO::Socket::INET;
use IO::Select;

$SIG{CHLD} = "IGNORE";

my $server = IO::Socket::INET->new(
    LocalAddr => "192.168.14.1",
    LocalPort => 4321,
    Listen    => 10,
    ReuseAddr => 1,
    Proto     => "tcp",
) or die $!;

while (1) {
    my $client = $server->accept or next;
    if (fork == 0) {
        my $backend = IO::Socket::INET->new(
            LocalAddr => "192.168.14.1",
            PeerAddr  => "192.168.17.252",
            PeerPort  => 4321,
            Proto     => "tcp",
            Timeout   => 10,
        );
        unless ($backend) { $client->close; exit }

        my $sel = IO::Select->new($client, $backend);
        while (my @ready = $sel->can_read(60)) {
            for my $fh (@ready) {
                my ($buf, $n);
                $n = sysread($fh, $buf, 65536);
                unless (defined $n && $n > 0) { $sel->remove($fh); next }
                syswrite(($fh == $client ? $backend : $client), $buf);
            }
            last unless $sel->count >= 2;
        }
        $client->close;
        $backend->close;
        exit;
    }
    $client->close;
}
```

## FreeBSD rc.d Startup Script

```sh
#!/bin/sh
# PROVIDE: clock_proxy
# REQUIRE: NETWORKING
perl /usr/local/bin/clock-proxy.pl >/dev/null 2>&1 &
```

Save to `/usr/local/etc/rc.d/clock-proxy.sh` and `chmod 755`.

> **Critical:** The `&` at the end is required. Without it, the script blocks the boot process.

## Troubleshooting Checklist

| Check | Command | Expected |
|---|---|---|
| VPN SA installed | `ipsec status \| grep INSTALLED` | INSTALLED + bytes > 0 |
| Proxy listening | `sockstat -l \| grep 4321` | Socket on LAN IP |
| Source IP correct | `ping -S <lan_ip> <dest>` | 0% packet loss |
| PM2 env loaded | `pm2 env 0 \| grep CLOCK_PROXY` | `http://192.168.14.1:4321` |
| strongSwan at boot | `systemctl is-enabled strongswan-starter` | `enabled` |
| Firewall on Skill | `netstat -ano \| findstr :4321` | LISTENING |
| End-to-end | `curl http://localhost:3847/api/rh/clocks/status` | `{"total":9,...}` |

---

*See also: [VPN Chain Architecture](./delirio-vpn-chain.md)*
