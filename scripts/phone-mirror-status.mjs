#!/usr/bin/env node
/**
 * scripts/phone-mirror-status.mjs
 *
 * Checks if the Natively Phone Mirror companion server is currently active,
 * tests connectivity, identifies your Mac's LAN IP address, and outputs
 * the exact URL and steps to access the mobile companion page on your phone.
 */

import http from 'http';
import os from 'os';

function getLanIPs() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || name.startsWith('utun') || name.startsWith('bridge') || name.startsWith('vbox')) continue;
    for (const item of list) {
      if (item.family === 'IPv4' && !item.internal) {
        ips.push({ iface: name, ip: item.address });
      }
    }
  }
  return ips;
}

function probePort(port) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: port,
        path: '/',
        method: 'GET',
        timeout: 2000,
      },
      (res) => {
        resolve({ open: true, status: res.statusCode });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ open: false, error: 'timeout' });
    });
    req.on('error', (err) => {
      resolve({ open: false, error: err.code || err.message });
    });
    req.end();
  });
}

async function main() {
  console.log('\n==================================================');
  console.log('   📱 Natively Phone Mirror Companion Diagnostic');
  console.log('==================================================\n');

  const lanIPs = getLanIPs();
  const defaultPort = 4123;

  console.log('1. Mac Network Interfaces (Local Wi-Fi / LAN):');
  if (lanIPs.length === 0) {
    console.log('   ⚠️  No local Wi-Fi / LAN IPv4 address detected.');
  } else {
    for (const entry of lanIPs) {
      console.log(`   • ${entry.iface}: ${entry.ip}`);
    }
  }

  console.log('\n2. Testing Phone Mirror Server (Port 4123):');
  let activePort = null;

  for (let port = defaultPort; port <= defaultPort + 5; port++) {
    const res = await probePort(port);
    if (res.open) {
      activePort = port;
      console.log(`   ✅ Server is ACTIVE on port ${port} (HTTP response: ${res.status})`);
      break;
    }
  }

  if (activePort) {
    console.log('\n3. How to Access on Your Phone:');
    if (lanIPs.length > 0) {
      for (const entry of lanIPs) {
        console.log(`   🌐 http://${entry.ip}:${activePort}/?t=<PAIRING_TOKEN>`);
      }
    } else {
      console.log(`   🌐 http://127.0.0.1:${activePort}/?t=<PAIRING_TOKEN>`);
    }
    console.log('\n   💡 To get your Pairing Token and QR Code:');
    console.log('      • In Natively on your Mac, open: Settings (⌘,) -> Sync -> "Pair a phone"');
    console.log('      • Click "Show code" to reveal your QR code and pairing link');
    console.log('      • Scan the QR code directly with your phone camera, or open the link above with your token.');
  } else {
    console.log('   ⚪ Server is currently OFFLINE / NOT RUNNING on port 4123.');
    console.log('\n3. How to Turn On the Companion Server:');
    console.log('   Step 1: Open Natively on your MacBook.');
    console.log('   Step 2: Press ⌘, (or click Settings) -> Go to "Sync".');
    console.log('   Step 3: Toggle ON "Phone Mirror".');
    console.log('   Step 4: Enable "Allow LAN access" (so your phone on Wi-Fi can reach your Mac).');
    console.log('   Step 5: Click "Show code" under "Pair a phone" and scan the QR code with your phone camera!\n');
    if (lanIPs.length > 0) {
      console.log(`   Your phone will connect via: http://${lanIPs[0].ip}:4123/?t=<TOKEN>`);
    }
  }

  console.log('==================================================\n');
}

main();
