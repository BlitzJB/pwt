#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

function findDtach() {
  const paths = [
    '/opt/homebrew/bin/dtach',
    '/usr/local/bin/dtach',
    '/usr/bin/dtach',
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }

  try {
    return execSync('which dtach', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function hasBrew() {
  try {
    execSync('which brew', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function installDtach() {
  const platform = os.platform();

  if (platform === 'darwin') {
    if (hasBrew()) {
      console.log(`   Installing dtach via Homebrew...`);
      try {
        execSync('brew install dtach', { stdio: 'inherit' });
        return findDtach();
      } catch {
        return null;
      }
    } else {
      console.log(`${YELLOW}⚠${RESET}  Homebrew not found. Install dtach manually:`);
      console.log(`   ${GREEN}brew install dtach${RESET}\n`);
      return null;
    }
  } else if (platform === 'linux') {
    console.log(`   Installing dtach via apt...`);
    try {
      execSync('sudo apt-get update && sudo apt-get install -y dtach', { stdio: 'inherit' });
      return findDtach();
    } catch {
      console.log(`${YELLOW}⚠${RESET}  Could not install dtach. Install manually:`);
      console.log(`   ${GREEN}sudo apt install dtach${RESET}\n`);
      return null;
    }
  }

  return null;
}

console.log('\n📦 web-terminal postinstall\n');

let dtach = findDtach();
if (dtach) {
  console.log(`${GREEN}✓${RESET} dtach found: ${dtach}`);
} else {
  console.log(`${YELLOW}⚠${RESET}  dtach not found, attempting to install...`);
  dtach = installDtach();
  if (dtach) {
    console.log(`${GREEN}✓${RESET} dtach installed: ${dtach}`);
  }
}

console.log(`\n${GREEN}✓${RESET} Installation complete!`);
console.log(`\n   Run with: ${GREEN}pwt${RESET}`);
console.log(`   Options:  ${GREEN}pwt -c${RESET}   (prevent system sleep)`);
console.log(`             ${GREEN}pwt -t${RESET}   (ngrok tunnel)`);
console.log(`             ${GREEN}pwt -tc${RESET}  (both)\n`);
