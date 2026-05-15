const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const MAX_TOKEN = process.env.MAX_TOKEN;
const OC_GATEWAY_HOST = process.env.OC_GATEWAY_HOST || '127.0.0.1';
const OC_GATEWAY_PORT = parseInt(process.env.OC_GATEWAY_PORT || '18789', 10);
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '8789', 10);

const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n))
);

const STATE_FILE = path.join(__dirname, 'max-threads.json');

if (!MAX_TOKEN) {
  console.error('MAX_TOKEN not set. Copy .env.example to .env and fill in your values.');
  process.exit(1);
}
if (ALLOWED_USER_IDS.size === 0) {
  console.error('ALLOWED_USER_IDS not set. Add your user IDs to .env (comma-separated).');
  process.exit(1);
}

let OC_TOKEN = process.env.OC_TOKEN || '';
if (!OC_TOKEN) {
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    const cfgPath = path.join(home, '.openclaw', 'openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    OC_TOKEN = cfg.gateway?.auth?.token || '';
  } catch(e) {
    console.error('OC_TOKEN not set and failed to auto-detect from ~/.openclaw/openclaw.json');
    console.error('Set OC_TOKEN in .env or ensure openclaw.json has gateway.auth.token');
    process.exit(1);
  }
}

console.log(`OpenClaw gateway: ${OC_GATEWAY_HOST}:${OC_GATEWAY_PORT}`);
console.log(`Bridge port: ${BRIDGE_PORT}`);
console.log(`Allowed users: ${[...ALLOWED_USER_IDS].join(', ')}`);

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch(e) {}
  return {};
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch(e) {
    console.log(`Save error:`, e.message);
  }
}

function updateActivity(userId) {
  const state = loadState();
  if (!state[userId]) {
    state[userId] = { lastActivity: Date.now() };
  } else {
    state[userId].lastActivity = Date.now();
  }
  saveState(state);
}

// ============ MAX API ============

let marker = null;
let typingIntervals = new Map();

function maxReq(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: 'platform-api.max.ru',
      path: apiPath,
      method,
      headers: {
        'Authorization': MAX_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error(`Parse error: ${d.substring(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(data);
    req.end();
  });
}

async function startTyping(userId) {
  if (typingIntervals.has(userId)) return;
  try {
    await maxReq('POST', `/chats/${userId}/actions`, { action: 'typing_on' });
  } catch(e) {}
  const interval = setInterval(async () => {
    try {
      await maxReq('POST', `/chats/${userId}/actions`, { action: 'typing_on' });
    } catch(e) {}
  }, 4000);
  typingIntervals.set(userId, interval);
}

function stopTyping(userId) {
  if (typingIntervals.has(userId)) {
    clearInterval(typingIntervals.get(userId));
    typingIntervals.delete(userId);
  }
}

async function sendMaxMessage(userId, text) {
  if (!text || text.trim().length === 0) return;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 1500) {
      chunks.push(remaining);
      break;
    }
    const cut = remaining.lastIndexOf('\n', 1400);
    chunks.push(remaining.substring(0, cut > 0 ? cut : 1450));
    remaining = remaining.substring(chunks[chunks.length - 1].length);
  }
  for (const chunk of chunks) {
    try {
      await maxReq('POST', `/messages?user_id=${userId}`, { text: chunk });
    } catch(e) {
      console.log(`Send error:`, e.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

// ============ OPENCLAW API ============

async function ocChatStream(message, userId, sessionKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'openclaw',
      messages: [{ role: 'user', content: message }],
      stream: true,
      user: sessionKey
    });
    const opts = {
      hostname: OC_GATEWAY_HOST,
      port: OC_GATEWAY_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OC_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = http.request(opts, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', c => errBody += c);
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody.substring(0, 400)}`)));
        return;
      }
      let fullText = '';
      let buffer = '';
      let lastToolStatus = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const dataLine = line.substring(6).trim();
          if (dataLine === '[DONE]') continue;
          try {
            const json = JSON.parse(dataLine);
            const delta = json.choices?.[0]?.delta;
            if (delta) {
              if (delta.tool_calls) {
                const name = delta.tool_calls[0]?.function?.name || 'tool';
                let statusText = '';
                if (name.includes('search') || name.includes('web')) statusText = 'Searching...';
                else if (name.includes('browser')) statusText = 'Browser...';
                else if (name.includes('read') || name.includes('write') || name.includes('file')) statusText = 'Files...';
                else statusText = `${name}`;
                if (statusText !== lastToolStatus) {
                  lastToolStatus = statusText;
                  console.log(statusText);
                }
              }
              if (delta.content) {
                fullText += delta.content;
              }
            }
          } catch(e) {}
        }
      });
      res.on('end', () => resolve(fullText));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============ WEBHOOK (for cron notifications → MAX) ============

async function handleWebhook(body) {
  const text = body.text || body.message || '';
  const userId = body.userId || [...ALLOWED_USER_IDS][0];
  if (!text) return { ok: false, error: 'no text' };
  console.log(`[WEBHOOK] -> MAX user:${userId}`);
  console.log(`   ${text}`);
  await sendMaxMessage(userId, text);
  return { ok: true };
}

function startWebhookServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/webhook') {
      let raw = '';
      req.on('data', c => raw += c);
      req.on('end', async () => {
        try {
          const body = JSON.parse(raw);
          const result = await handleWebhook(body);
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
    } else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`Webhook: http://127.0.0.1:${BRIDGE_PORT}/webhook`);
    console.log(`Cron: openclaw cron edit <id> --announce --webhook http://127.0.0.1:${BRIDGE_PORT}/webhook`);
  });
}

// ============ POLLING MAX -> OPENCLAW ============

let pollBusy = false;

async function pollMax() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const p = `/updates?timeout=20&limit=10${marker ? `&marker=${marker}` : ''}`;
    const updates = await maxReq('GET', p);
    if (updates.marker) marker = updates.marker;
    if (!updates.updates || updates.updates.length === 0) return;
    for (const update of updates.updates) {
      if (update.update_type !== 'message_created' || !update.message) continue;
      const msg = update.message;
      const text = msg.body?.text;
      if (!text || msg.sender?.is_bot) continue;
      const userId = msg.sender?.user_id;
      if (!ALLOWED_USER_IDS.has(userId)) {
        console.log(`Blocking id:${userId}`);
        continue;
      }
      const userName = msg.sender?.first_name || 'User';
      const sessionKey = `max:${userId}`;
      console.log(`[MAX] ${userName} -> ${sessionKey}`);
      console.log(`   ${text}`);
      try {
        await startTyping(userId);
        const replyText = await ocChatStream(text, userId, sessionKey);
        stopTyping(userId);
        updateActivity(userId);
        if (replyText && replyText.trim().length > 0) {
          console.log(`Sending (${replyText.length} chars)...`);
          await sendMaxMessage(userId, replyText.trim());
          console.log(`Sent`);
        }
      } catch(e) {
        stopTyping(userId);
        console.log(`Error: ${e.message}`);
        try {
          await sendMaxMessage(userId, `Error: ${e.message.substring(0, 200)}`);
        } catch(e2) {}
      }
    }
  } catch(e) {
    if (!e.message.includes('ECONN') && !e.message.includes('ENOTFOUND')) {
      console.log(`Poll: ${e.message}`);
    }
  } finally {
    pollBusy = false;
  }
}

// ============ SCHEDULER ============

const SCHEDULES = [];

async function runScheduler() {
  const now = new Date();
  for (const s of SCHEDULES) {
    const parsed = parseCronExpr(s.cron);
    if (!parsed) continue;
    if (!cronMatches(parsed, now)) continue;
    const key = `${s.id}:${now.getUTCFullYear()}-${now.getUTCMonth()+1}-${now.getUTCDate()}`;
    const state = loadState();
    if (!state._sent) state._sent = [];
    if (state._sent.includes(key)) continue;
    state._sent.push(key);
    if (state._sent.length > 30) state._sent = state._sent.slice(-30);
    saveState(state);
    console.log(`[SCHEDULER] ${s.id} -> MAX user:${s.userId}`);
    await sendMaxMessage(s.userId, s.message);
  }
}

function parseCronExpr(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return null;
  return { minute: parts[0], hour: parts[1], dom: parts[2], month: parts[3], dow: parts[4] };
}

function cronMatches(fields, date) {
  function match(field, value) {
    if (field === '*') return true;
    for (const seg of field.split(',')) {
      if (seg.includes('/')) {
        const [range, step] = seg.split('/');
        const start = range === '*' ? 0 : parseInt(range);
        if (value >= start && (value - start) % parseInt(step) === 0) return true;
      } else if (seg.includes('-')) {
        const [lo, hi] = seg.split('-').map(Number);
        if (value >= lo && value <= hi) return true;
      } else if (parseInt(seg) === value) return true;
    }
    return false;
  }
  return match(fields.minute, date.getUTCMinutes())
    && match(fields.hour, date.getUTCHours())
    && match(fields.dom, date.getUTCDate())
    && match(fields.month, date.getUTCMonth() + 1)
    && match(fields.dow, date.getUTCDay());
}

// ============ STARTUP ============

console.log('');
console.log('MAX.ru <-> OpenClaw Bridge');
console.log('Polling MAX -> OpenClaw');
console.log(`Webhook / health on :${BRIDGE_PORT}`);
console.log(`Scheduler (${SCHEDULES.length} jobs)`);
console.log('');

const state = loadState();
if (Object.keys(state).length > 1 || (Object.keys(state).length === 1 && !state._sent)) {
  console.log('Active users:');
  for (const [uid, data] of Object.entries(state)) {
    if (uid === '_sent') continue;
    const inactive = Math.round((Date.now() - data.lastActivity) / 60000);
    console.log(`   userId:${uid} -> max:${uid} (inactive: ${inactive} min)`);
  }
}
console.log('');

startWebhookServer();
setInterval(pollMax, 800);
setInterval(runScheduler, 30000);
runScheduler();
console.log('Polling started');
console.log('Scheduler running (30s interval)');
