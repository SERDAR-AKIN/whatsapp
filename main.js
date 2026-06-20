/**
 * @file main.js
 * @description Main entry point of the Autonomous WhatsApp Agent (Powered by Gemini).
 * Initializes the WhatsApp Web session using the `whatsapp-web.js` library,
 * manages QR code authentication, and processes all incoming message events
 * through a layered middleware pipeline.
 *
 * Architecture (Phase 2A):
 * ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
 * │  Guard   │──▶│ Contact   │──▶│   LID    │──▶│  Media   │──▶│ Command/ │
 * │ Filter   │   │ Resolver  │   │ Resolver │   │ Handler  │   │ Mission  │
 * └──────────┘   └───────────┘   └──────────┘   └──────────┘   └──────────┘
 *
 * @module MainGateway
 */
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const MissionManager = require('./src/missionManager');
const GeminiClient = require('./src/geminiClient');
const LidResolver = require('./src/lidResolver');
const { parseCommand, parseStopCommand, parseUtilityCommand } = require('./src/commandParser');
const {
    MessagePipeline,
    createContactResolverMiddleware,
    createLidResolverMiddleware,
    createMediaHandlerMiddleware,
    createGuardMiddleware,
    createCommandRouterMiddleware,
    createMissionRouterMiddleware,
    createIncomingLoggerMiddleware,
} = require('./src/messagePipeline');
const CONFIG = require('./src/config');

// Create WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
        ],
    },
});

// Mission Manager
const missionManager = new MissionManager(client);

// LID Resolver (Centralized @lid → phone number mapping cache)
const lidResolver = new LidResolver(client);

// Gemini connection check
const aiClient = new GeminiClient();

// ════════════════════════════════════════════════════════
// Middleware Pipelines (Phase 2A)
// ════════════════════════════════════════════════════════

// Pipeline 1: Incoming messages (from external contacts)
const incomingPipeline = new MessagePipeline();
incomingPipeline
    .use('guard', createGuardMiddleware(missionManager))
    .use('logger', createIncomingLoggerMiddleware())
    .use('contactResolver', createContactResolverMiddleware())
    .use('lidResolver', createLidResolverMiddleware(lidResolver))
    .use('mediaHandler', createMediaHandlerMiddleware())
    .use('missionRouter', createMissionRouterMiddleware(missionManager));

// Pipeline 2: My own messages (command mode)
const selfPipeline = new MessagePipeline();
selfPipeline
    .use('guard', createGuardMiddleware(missionManager))
    .use('commandRouter', createCommandRouterMiddleware({
        client,
        missionManager,
        parseCommand,
        parseStopCommand,
        parseUtilityCommand,
    }))
    .use('selfMissionRouter', createMissionRouterMiddleware(missionManager));

// ════════════════════════════════════════════════════════
// EventEmitter Listeners (Phase 2C)
// ════════════════════════════════════════════════════════

missionManager.on('mission:started', (data) => {
    console.log(`📡 [EVENT] Mission started: #${data.missionId} → ${data.target}`);
});

missionManager.on('mission:completed', (data) => {
    console.log(`📡 [EVENT] Mission completed: #${data.missionId} (${data.status})`);
});

missionManager.on('mission:stopped', (data) => {
    console.log(`📡 [EVENT] Mission stopped: #${data.missionId}`);
});

missionManager.on('mission:reply_sent', (data) => {
    if (data.relevance === 'off_topic') {
        console.log(`📡 [EVENT] Off-topic reply: #${data.missionId}`);
    }
});

// ============================================
// WhatsApp Events
// ============================================

let readyFired = false;
let authTimeout = null;
let isRestarting = false;

client.on('qr', (qr) => {
    console.log('📲 Scan the QR Code:');
    qrcode.generate(qr, { small: true });
});

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Loading: %${percent} — ${message}`);
});

client.once('ready', async () => {
    readyFired = true;
    if (authTimeout) clearTimeout(authTimeout);
    const myNumber = client.info.wid.user;
    missionManager.setMyNumber(myNumber);

    // Gemini server/CLI check
    const aiOk = await aiClient.healthCheck();
    console.log(aiOk
        ? '🧠 Gemini CLI connection successful and ready.'
        : '⚠️ Gemini CLI is unreachable or not installed! Tasks cannot be started.'
    );

    // Restore persistent memory
    missionManager.restoreMissions();

    // Load LID cache from disk
    lidResolver.loadFromDisk();

    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('  ✅ WhatsApp Autonomous Agent System Ready!');
    console.log('═══════════════════════════════════════════');
    console.log(`  📱 Account : ${myNumber}`);
    console.log(`  🧠 Model   : ${CONFIG.gemini?.model || 'Default'}`);
    console.log(`  🌐 Gemini  : ${aiOk ? 'Connected ✅' : 'No Connection ❌'}`);
    console.log(`  🔧 Pipeline: incoming[${incomingPipeline.list().length}] + self[${selfPipeline.list().length}] middleware`);
    console.log('');
    console.log('  Commands:');
    console.log('  !ai <number> <task>   → Start a new mission');
    console.log('  !stop [id]            → Stop a mission');
    console.log('  !status               → List active missions');
    console.log('  !list                 → List active missions');
    console.log('  !ping                 → Connection test');
    console.log('═══════════════════════════════════════════');
    console.log('');
});

client.on('authenticated', () => {
    if (readyFired || isRestarting) return;
    console.log('🔐 Authentication successful, synchronizing...');

    if (authTimeout) clearTimeout(authTimeout);

    // Known issue in whatsapp-web.js: The ready event sometimes doesn't fire on first login.
    // We automate what would otherwise require the user to manually Ctrl+C and restart.
    authTimeout = setTimeout(async () => {
        if (!readyFired && !isRestarting) {
            isRestarting = true;
            console.log('⚠️ Synchronization took too long (ready event not received).');
            console.log('🔄 Client is being automatically restarted in the background...');
            try {
                await client.destroy();
                // Wait briefly for the browser to close
                await new Promise(resolve => setTimeout(resolve, 2000));
                isRestarting = false;
                client.initialize();
            } catch (err) {
                console.error('❌ Restart failed:', err);
                isRestarting = false;
            }
        }
    }, 15000); // Wait 15 seconds
});

client.on('auth_failure', (msg) => {
    console.error('❌ Authentication error:', msg);
});

client.on('disconnected', (reason) => {
    console.log('🔌 Disconnected:', reason);
});

// ============================================
// Message Processing (Pipeline-Based — Phase 2A)
// ============================================

// ─────────────────────────────────────────────
// message_create: All messages (outgoing + incoming)
// Captures the user's own !ai commands
// ─────────────────────────────────────────────
client.on('message_create', async (message) => {
    const fromMe = message.fromMe;
    const chatId = message.from;
    const body = message.body;

    // Only my own messages (command mode)
    if (!fromMe) return;
    const myChatId = `${missionManager.myNumber}@c.us`;
    if (chatId !== myChatId) return;

    // Build pipeline context
    const context = {
        message,
        chatId,
        body: body || '',
        fromMe: true,
        contactNumber: null,
        senderName: null,
        media: null,
        hasMedia: false,
        handled: false,
    };

    await selfPipeline.process(context);
});

// ─────────────────────────────────────────────
// message: Incoming messages only (from external contacts)
// Captures replies from the target person
// ─────────────────────────────────────────────
client.on('message', async (message) => {
    // Build pipeline context
    const context = {
        message,
        chatId: message.from,
        body: message.body || '',
        fromMe: false,
        contactNumber: null,
        senderName: null,
        media: null,
        hasMedia: false,
        handled: false,
    };

    await incomingPipeline.process(context);
});

// ============================================
// Start
// ============================================
console.log('');
console.log('🚀 WhatsApp Autonomous Agent System starting...');
console.log('');
client.initialize();
