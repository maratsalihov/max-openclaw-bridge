/**
 * MAX.ru <-> OpenClaw Bridge — Thread-based sessions
 * 
 * Features:
 * - Thread-based sessions: max:${userId}:thread-NNN
 * - Auto-creates new thread after 30 min of inactivity
 * - State persistence in max-threads.json
 * - Streaming response with typing indicator
 * - Tool-use status in console
 * 
 * Setup:
 *   1. cp .env.example .env
 *   2. Fill in MAX_TOKEN (get from max.ru/developers)
 *   3. npm install
 *   4. node max-bridge.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============ CONFIG FROM .ENV ============

require('dotenv').config({ path: path.join(__dirname, '.env') });

const MAX_TOKEN = process.env.MAX_TOKEN;
const OC_GATEWAY_HOST = process.env.OC_GATEWAY_HOST || '127.0.0.1';
const OC_GATEWAY_PORT = parseInt(process.env.OC_GATEWAY_PORT || '18789', 10);
const OC_GATEWAY_URL = process.env.OC_GATEWAY_URL || `http://${OC_GATEWAY_HOST}:${OC_GATEWAY_PORT}`;
const OC_TOKEN = process.env.OC_TOKEN || '';
const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n))
);
const THREAD_TIMEOUT_MS = parseInt(process.env.THREAD_TIMEOUT_MINUTES || '30', 10) * 60 * 1000;
const STATE_FILE = path.join(__dirname, 'max-threads.json');

if (!MAX_TOKEN) {
  console.error('❌ MAX_TOKEN not set. Copy .env.example to .env and fill in your values.');
  process.exit(1);
}

if (ALLOWED_USER_IDS.size === 0) {
  console.error('❌ ALLOWED_USER_IDS not set. Add your user IDs to .env (comma-separated).');
  process.exit(1);
}

// Fallback: try to load OC token from openclaw.json if not in .env
let effectiveOcToken = OC_TOKEN;
if (!effectiveOcToken) {
  try {
    const cfg = JSON.parse(fs.readFileSync(
      path.join(process.env.HOME || process.env.USERPROFILE, '.openclaw', 'openclaw.json'),
      'utf8'
    ));
    effectiveOcToken = cfg.gateway?.auth?.token || '';
  } catch(e) {
    // ignore
  }
  if (effectiveOcToken) {
    console.log('✅ OpenClaw token loaded from ~/.openclaw/openclaw.json');
  }
}

if (!effectiveOcToken) {
  console.error('❌ OpenClaw token not found. Set OC_TOKEN in .env or ensure openclaw.json has gateway.auth.token');
  process.exit(1);
} else {
  console.log(`✅ OpenClaw token loaded (${effectiveOcToken.substring(0, 8)}...)`);
}

// ============ STATE MANAGEMENT ============

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
    console.log(`❌ Failed to save state:`, e.message);
  }
}

function getOrCreateThread(userId) {
  const state = loadState();
  const now = Date.now();
  
  if (!state[userId]) {
    state[userId] = {
      currentThread: 'thread-001',
      lastActivity: now,
      threadCount: 1
    };
    saveState(state);
    return 'thread-001';
  }
  
  const userState = state[userId];
  
  if (now - userState.lastActivity > THREAD_TIMEOUT_MS) {
    userState.threadCount++;
    userState.currentThread = `thread-${String(userState.threadCount).padStart(3, '0')}`;
    const mins = Math.round((now - userState.lastActivity) / 60000);
    console.log(`🆕 New thread for userId:${userId} → ${userState.currentThread} (was inactive for ${mins} min)`);
  }
  
  userState.lastActivity = now;
  saveState(state);
  
  return userState.currentThread;
}

function updateActivity(userId) {
  const state = loadState();
  if (state[userId]) {
    state[userId].lastActivity = Date.now();
    saveState(state);
  }
}

function getSessionKey(userId) {
  const thread = getOrCreateThread(userId);
  return `max:${userId}:${thread}`;
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
        try { 
          resolve(JSON.parse(d)); 
        }
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
  
  // Split into chunks of 1500 chars
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
      console.log(`❌ Send error:`, e.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

// ============ OPENCLAW ============

async function ocChatStream(message, sessionKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'openclaw',
      messages: [{ role: 'user', content: message }],
      stream: true,
      session_key: sessionKey
    });
    
    const req = http.request({
      hostname: OC_GATEWAY_HOST,
      port: OC_GATEWAY_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${effectiveOcToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
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
            
            if (delta?.tool_calls) {
              const name = delta.tool_calls[0]?.function?.name || 'tool';
              let statusText = '';
              if (name.includes('search') || name.includes('web')) statusText = '🌐 Searching...';
              else if (name.includes('browser')) statusText = '🖥️ Browser...';
              else if (name.includes('read') || name.includes('write') || name.includes('file')) statusText = '📁 Files...';
              else statusText = `🔧 ${name}`;
              
              if (statusText !== lastToolStatus) {
                lastToolStatus = statusText;
                console.log(statusText);
              }
            }
            
            if (delta?.content) {
              fullText += delta.content;
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

// ============ MAIN LOOP ============

let pollBusy = false;

async function pollMax() {
  if (pollBusy) return;
  pollBusy = true;
  
  try {
    const apiPath = `/updates?timeout=20&limit=10${marker ? `&marker=${marker}` : ''}`;
    const updates = await maxReq('GET', apiPath);
    
    if (updates.marker) marker = updates.marker;
    if (!updates.updates || updates.updates.length === 0) return;
    
    for (const update of updates.updates) {
      if (update.update_type !== 'message_created' || !update.message) continue;
      
      const msg = update.message;
      const text = msg.body?.text;
      if (!text || msg.sender?.is_bot) continue;
      
      const userId = msg.sender?.user_id;
      if (!ALLOWED_USER_IDS.has(userId)) {
        console.log(`⛔ Blocked unknown user id:${userId}`);
        continue;
      }
      
      const userName = msg.sender?.first_name || 'User';
      const sessionKey = getSessionKey(userId);
      
      console.log(`\n═══════════════════════════════════════`);
      console.log(`📩 [MAX] ${userName} → ${sessionKey}`);
      console.log(`   ${text}`);
      console.log(`═══════════════════════════════════════`);
      
      try {
        await startTyping(userId);
        const replyText = await ocChatStream(text, sessionKey);
        stopTyping(userId);
        updateActivity(userId);
        
        if (replyText && replyText.trim().length > 0) {
          console.log(`📤 Sending (${replyText.length} chars)...`);
          await sendMaxMessage(userId, replyText.trim());
          console.log(`✅ Sent`);
        }
      } catch(e) {
        stopTyping(userId);
        console.log(`❌ Error: ${e.message}`);
        try {
          await sendMaxMessage(userId, `⚠️ Error: ${e.message.substring(0, 200)}`);
        } catch(e2) {}
      }
    }
  } catch(e) {
    if (!e.message.includes('ECONN') && !e.message.includes('ENOTFOUND')) {
      console.log(`⚠️ Poll error: ${e.message}`);
    }
  } finally {
    pollBusy = false;
  }
}

// ============ STARTUP ============

console.log('');
console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║       MAX.ru <-> OpenClaw Bridge (Thread-based)        ║');
console.log('╠══════════════════════════════════════════════════════════╣');
console.log('║ ✅ Thread sessions: max:userId:thread-NNN               ║');
console.log('║ ✅ Auto new thread after inactivity timeout            ║');
console.log('║ ✅ State persistence: max-threads.json                  ║');
console.log('║ ✅ Streaming + typing indicator                        ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log('');

const state = loadState();
console.log('📋 Active threads:');
if (Object.keys(state).length === 0) {
  console.log('   (none yet)');
} else {
  for (const [uid, data] of Object.entries(state)) {
    const mins = Math.round((Date.now() - data.lastActivity) / 60000);
    console.log(`   userId:${uid} → ${data.currentThread} (inactive: ${mins} min)`);
  }
}
console.log('');

setInterval(pollMax, 800);
console.log('🚀 Polling started...');