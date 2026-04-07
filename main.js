const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Create a new client instance with LocalAuth for session persistence
// and no-sandbox flags for headless Linux environment
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

// When the client received QR-Code, display it in terminal
client.on('qr', (qr) => {
    console.log('QR Code received! Scan it with your phone:');
    qrcode.generate(qr, { small: true });
});

// When the client is ready, run this code (only once)
client.once('ready', () => {
    console.log('✅ Client is ready!');
});

// When authenticated
client.on('authenticated', () => {
    console.log('🔐 Authenticated successfully!');
});

// Authentication failure
client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
});

// Disconnected
client.on('disconnected', (reason) => {
    console.log('🔌 Client was disconnected:', reason);
});

// Ping/Pong bot - listens for "!ping" and replies with "pong"
client.on('message_create', async (message) => {
    const chat = await message.getChat();
    
    // Log message details to terminal to see group/chat IDs
    console.log(`\n--- NEW MESSAGE ---`);
    console.log(`From: ${chat.name} (${message.from})`);
    console.log(`Body: ${message.body}`);
    console.log(`-------------------\n`);

    if (message.body === '!ping') {
        message.reply('pong');
        console.log('🏓 Replied "pong" to', message.from);
    }
});

// Start the client
console.log('🚀 Starting WhatsApp bot...');
client.initialize();
