#!/usr/bin/env node
/**
 * RunSound CLI — npx runsound <command>
 *
 * Commands:
 *   install         Install SKILL.md into current project
 *   skills list     List all available skills
 *   balance         Check credit balance
 *   run <skill>     Run a skill
 */

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');

const API_BASE    = 'https://runsound.ai';
const SKILL_URL   = `${API_BASE}/SKILL.md`;
const CONFIG_FILE = path.join(os.homedir(), '.runsound', 'config.json');

const [,, cmd, ...args] = process.argv;

// ─── Config helpers ───────────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function getApiKey() {
  return process.env.RUNSOUND_API_KEY || loadConfig().api_key;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function apiFetch(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const key = getApiKey();
    const url = new URL(endpoint.startsWith('http') ? endpoint : API_BASE + endpoint);
    const lib = url.protocol === 'https:' ? https : http;

    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': key ? `Bearer ${key}` : '',
        'User-Agent':    'runsound-cli/0.1.0',
      },
    };

    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ─── Colors ───────────────────────────────────────────────────────────────────
const c = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
};

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdInstall() {
  console.log(c.bold('\n🎵 RunSound Skills — installing...\n'));

  // Determine install target
  const targets = [];

  // Claude Code / Claude Desktop
  const claudeDir = path.join(os.homedir(), '.claude');
  if (fs.existsSync(claudeDir)) {
    targets.push({ dir: claudeDir, label: 'Claude Code' });
  }

  // Current project .claude folder
  const projectClaude = path.join(process.cwd(), '.claude');
  if (!targets.find(t => t.dir === projectClaude)) {
    targets.push({ dir: projectClaude, label: 'current project' });
  }

  // Fetch the SKILL.md
  let skillContent;
  try {
    skillContent = await fetchText(SKILL_URL);
  } catch {
    // Fallback: use bundled version
    skillContent = getBundledSkill();
  }

  let installed = 0;
  for (const target of targets) {
    const dest = path.join(target.dir, 'SKILL.md');
    // Check if a SKILL.md already exists and append or create
    try {
      let existing = '';
      if (fs.existsSync(dest)) {
        existing = fs.readFileSync(dest, 'utf8');
      }
      if (existing.includes('RunSound')) {
        console.log(c.dim(`  ↳ ${target.label}: already installed, updating...`));
        // Replace RunSound section
        const withoutRunSound = existing.replace(/# RunSound Skills[\s\S]*?(?=\n# |\n---\n# |$)/, '');
        fs.mkdirSync(target.dir, { recursive: true });
        fs.writeFileSync(dest, withoutRunSound.trim() + '\n\n' + skillContent);
      } else {
        fs.mkdirSync(target.dir, { recursive: true });
        fs.writeFileSync(dest, existing ? existing + '\n\n---\n\n' + skillContent : skillContent);
      }
      console.log(c.green(`  ✓ ${target.label}: ${dest}`));
      installed++;
    } catch (err) {
      console.log(c.red(`  ✗ ${target.label}: ${err.message}`));
    }
  }

  if (installed === 0) {
    // Fallback: write to current directory
    fs.writeFileSync(path.join(process.cwd(), 'RUNSOUND_SKILL.md'), skillContent);
    console.log(c.green(`  ✓ Written to ${process.cwd()}/RUNSOUND_SKILL.md`));
  }

  console.log(c.bold('\n✅ RunSound installed!\n'));
  console.log('Your agent can now run music promotion skills.');
  console.log(c.dim('Example: "Find TikTok creators for my track [spotify url]"\n'));

  // Check if API key is set
  if (!getApiKey()) {
    console.log(c.yellow('⚠️  No API key found. Set up your key:'));
    console.log(c.dim('   export RUNSOUND_API_KEY=rs_live_xxxx'));
    console.log(c.dim('   or: npx runsound login\n'));
    console.log(`   Get your key at: ${c.cyan('runsound.ai/settings/api')}\n`);
  } else {
    console.log(c.green('🔑 API key found — ready to go!\n'));
  }
}

async function cmdLogin() {
  const key = args[0] || process.env.RUNSOUND_API_KEY;
  if (!key) {
    console.log('\nUsage: npx runsound login <api-key>');
    console.log(`Get your key at: ${c.cyan('runsound.ai/settings/api')}\n`);
    return;
  }

  // Verify key
  const { status, body } = await apiFetch('/api/credits/balance');
  if (status !== 200 || !body.ok) {
    console.log(c.red('\n✗ Invalid API key\n'));
    return;
  }

  const cfg = loadConfig();
  cfg.api_key = key;
  saveConfig(cfg);
  console.log(c.green(`\n✓ Logged in — balance: $${body.credits.toFixed(2)}\n`));
}

async function cmdBalance() {
  if (!getApiKey()) {
    console.log(c.yellow('\n⚠️  No API key. Run: npx runsound login <key>\n'));
    return;
  }
  const { body } = await apiFetch('/api/credits/balance');
  if (!body.ok) { console.log(c.red('\n✗ ' + body.error + '\n')); return; }

  const bal = body.credits.toFixed(4);
  const warn = body.low_balance_warning ? c.yellow(' ⚠️  Low balance') : '';
  console.log(`\n💳 Balance: ${c.bold(c.green('$' + bal))}${warn}`);
  console.log(c.dim(`   Top up at: runsound.ai/settings/credits\n`));
}

async function cmdSkillsList() {
  const { body } = await apiFetch('/api/skills');
  if (!body.ok) { console.log(c.red('\n✗ ' + body.error + '\n')); return; }

  console.log(c.bold('\n🎵 RunSound Skills\n'));

  const byCategory = {};
  for (const s of body.skills) {
    if (!byCategory[s.category]) byCategory[s.category] = [];
    byCategory[s.category].push(s);
  }

  for (const [cat, skills] of Object.entries(byCategory)) {
    console.log(c.cyan(c.bold(`  ${cat.toUpperCase()}`)));
    for (const s of skills) {
      const price = `$${s.price_per_unit.toFixed(3)} ${s.unit_label}`;
      console.log(`    ${c.bold(s.slug.padEnd(20))} ${s.name.padEnd(22)} ${c.dim(price)}`);
    }
    console.log('');
  }

  console.log(c.dim(`  Total: ${body.total} skills  ·  runsound.ai/skills\n`));
}

async function cmdRun() {
  const skillName = args[0];
  if (!skillName) {
    console.log('\nUsage: npx runsound run <skill> [--key value ...]\n');
    console.log('Example: npx runsound run hook-generator --spotify_url https://open.spotify.com/track/...\n');
    return;
  }

  if (!getApiKey()) {
    console.log(c.yellow('\n⚠️  No API key. Run: npx runsound login <key>\n'));
    return;
  }

  // Parse --key value pairs
  const input = { skill: skillName };
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const val = args[i + 1];
    if (key && val) input[key] = val;
  }

  console.log(c.dim(`\nRunning ${skillName}...\n`));

  const { body } = await apiFetch('/api/skills/run', 'POST', input);

  if (!body.ok) {
    console.log(c.red(`✗ ${body.error}\n`));
    if (body.topup) console.log(c.dim(`  Top up at: ${body.topup}\n`));
    return;
  }

  console.log(c.green(`✓ ${skillName} completed`));
  console.log(c.dim(`  Units: ${body.units_consumed}  Cost: $${body.cost_usd}  Balance: $${body.balance_after}\n`));
  console.log(JSON.stringify(body.output, null, 2));
  console.log('');
}

function cmdHelp() {
  console.log(`
${c.bold('🎵 RunSound')} — music marketing skills for AI agents

${c.bold('USAGE')}
  npx runsound <command>

${c.bold('COMMANDS')}
  install              Install SKILL.md into your agent
  login <api-key>      Save your API key
  balance              Check credit balance
  skills list          List all available skills
  run <skill> [opts]   Run a skill directly
  help                 Show this help

${c.bold('EXAMPLES')}
  npx runsound install
  npx runsound login rs_live_xxxx
  npx runsound balance
  npx runsound skills list
  npx runsound run hook-generator --spotify_url https://open.spotify.com/track/...

${c.bold('MORE')}
  Docs:    runsound.ai/docs
  Skills:  runsound.ai/skills
  Credits: runsound.ai/settings/credits
`);
}

function getBundledSkill() {
  return `# RunSound Skills — Music Marketing for AI Agents

One skill. Every music promotion tool your agent needs.

## Setup
\`\`\`
$set up https://runsound.ai/SKILL.md
\`\`\`

## Run Skills
POST https://runsound.ai/api/skills/run
Authorization: Bearer $RUNSOUND_API_KEY

Available: creator-scout, dm-outreach, hook-generator, post-scheduler,
sound-tracker, playlist-pitcher, press-pitcher, release-kit, trend-matcher

Docs: runsound.ai/docs
`;
}

// ─── Router ───────────────────────────────────────────────────────────────────
(async () => {
  switch (cmd) {
    case 'install':              await cmdInstall(); break;
    case 'login':                await cmdLogin();   break;
    case 'balance':              await cmdBalance(); break;
    case 'skills':
      if (args[0] === 'list')    await cmdSkillsList();
      else                       cmdHelp();
      break;
    case 'run':                  await cmdRun();     break;
    case 'help': case undefined: cmdHelp();          break;
    default:
      console.log(c.red(`\nUnknown command: ${cmd}\n`));
      cmdHelp();
  }
})();
