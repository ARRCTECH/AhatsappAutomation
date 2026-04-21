const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const Groq = require('groq-sdk');
const fs = require('fs');

require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Store clients and QR codes
const clients = {};
const qrCodes = {};
const clientStatus = {};
const conversations = [];

console.log('🚀 WhatsApp AI Auto-Reply Bot Server Starting...');

// ============= DETECT PLATFORM & SET CHROME PATH =============
const isRender = process.env.RENDER === 'true' || process.env.IS_RENDER === 'true';
const isWindows = process.platform === 'win32';

console.log(`📱 Platform: ${process.platform}`);
console.log(`🌍 Environment: ${isRender ? 'Render.com' : 'Local'}`);

// Chrome executable path find करा
let chromeExecutablePath = null;

if (isRender) {
    // Render.com साठी Chrome path
    const possiblePaths = [
        '/opt/render/.cache/puppeteer/chrome/linux-147.0.7727.57/chrome-linux64/chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
    ];
    
    for (const testPath of possiblePaths) {
        if (fs.existsSync(testPath)) {
            chromeExecutablePath = testPath;
            console.log(`✅ Chrome found on Render: ${chromeExecutablePath}`);
            break;
        }
    }
    
    if (!chromeExecutablePath) {
        console.log('⚠️ Chrome not found, Puppeteer will download it automatically');
    }
} else {
    // Windows Local साठी - Chrome शोधा
    const windowsPaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCAL_CHROME_PATH
    ];
    
    for (const testPath of windowsPaths) {
        if (testPath && fs.existsSync(testPath)) {
            chromeExecutablePath = testPath;
            console.log(`✅ Chrome found on Windows: ${chromeExecutablePath}`);
            break;
        }
    }
    
    if (!chromeExecutablePath) {
        console.log('⚠️ Chrome not found in default locations, Puppeteer will use its own Chromium');
    }
}

// ============= GROQ AI HELPER =============
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

async function getAIReply(userMessage, sender) {
    console.log(`🤖 Generating AI reply for: ${sender}`);
    
    try {
        const completion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [
                { 
                    role: "system", 
                    content: `You are Maya, a 24 year old helpful assistant. Real human. Never robotic.

## RULES:
- Short replies: 1-3 sentences only
- Never use bullet points
- Talk like a friend texting
- Be helpful and friendly
- Use simple language
- End with a question or helpful note`
                },
                { 
                    role: "user", 
                    content: userMessage 
                }
            ],
            temperature: 0.7,
            max_tokens: 100
        });
        
        const reply = completion.choices[0].message.content;
        console.log(`🤖 AI Reply: ${reply}`);
        return reply;
        
    } catch (error) {
        console.error('Groq API error:', error.message);
        
        // Fallback replies
        const msg = userMessage.toLowerCase();
        if (msg.includes('hello') || msg.includes('hi') || msg.includes('namaste')) {
            return "नमस्ते! मी आपली कशी मदत करू शकतो?";
        } else if (msg.includes('price') || msg.includes('किंमत')) {
            return "कृपया अधिक माहितीसाठी आमच्या website ला भेट द्या.";
        } else {
            return "आपल्या प्रश्नासाठी धन्यवाद! मी लवकरच उत्तर देईन. 😊";
        }
    }
}

// ============= WHATSAPP CLIENT =============

async function initializeClient(accountId) {
    if (clients[accountId]) {
        console.log(`Client ${accountId} already exists`);
        return clients[accountId];
    }

    console.log(`🔄 Initializing WhatsApp client for: ${accountId}`);
    clientStatus[accountId] = 'initializing';

    // Puppeteer configuration - Platform specific
    const puppeteerConfig = {
        headless: isRender ? true : false,  // Render वर headless, Local वर false
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    };
    
    // जर Chrome path सापडला असेल तर set करा
    if (chromeExecutablePath) {
        puppeteerConfig.executablePath = chromeExecutablePath;
        console.log(`🔧 Using Chrome: ${chromeExecutablePath}`);
    } else {
        console.log('🔧 No custom Chrome path, using Puppeteer default');
    }

    const client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: accountId,
            dataPath: path.join(__dirname, 'sessions')
        }),
        puppeteer: puppeteerConfig
    });

    client.on('qr', async (qr) => {
        console.log(`📱 QR Code received for ${accountId}`);
        try {
            const qrImage = await QRCode.toDataURL(qr);
            qrCodes[accountId] = qrImage;
            clientStatus[accountId] = 'awaiting_scan';
            console.log(`✅ QR Code generated for ${accountId}`);
        } catch (err) {
            console.error('QR generation error:', err);
        }
    });

    client.on('ready', () => {
        console.log(`✅ WhatsApp client ${accountId} is READY!`);
        clientStatus[accountId] = 'ready';
        qrCodes[accountId] = null;
    });

    client.on('authenticated', () => {
        console.log(`🔐 Client ${accountId} authenticated`);
    });

    client.on('auth_failure', (msg) => {
        console.error(`❌ Auth failure for ${accountId}:`, msg);
        clientStatus[accountId] = 'auth_failed';
    });

    client.on('disconnected', (reason) => {
        console.log(`⚠️ Client ${accountId} disconnected:`, reason);
        delete clients[accountId];
        delete qrCodes[accountId];
        clientStatus[accountId] = 'disconnected';
        
        // Auto-reconnect after 10 seconds (only on Render)
        if (isRender) {
            setTimeout(() => {
                console.log(`🔄 Attempting to reconnect ${accountId}...`);
                initializeClient(accountId);
            }, 10000);
        }
    });

    client.on('message', async (message) => {
        console.log(`📨 New message from ${message.from}: ${message.body?.substring(0, 50)}`);
        
        // Auto-reply logic
        if (message.from !== 'status@broadcast' && !message.from.includes('g.us')) {
            const sender = message.from.replace('@c.us', '');
            const userMessage = message.body;
            
            if (userMessage && userMessage.trim()) {
                console.log(`🤖 Generating AI reply for ${sender}...`);
                const aiReply = await getAIReply(userMessage, sender);
                console.log(`🤖 AI Reply: ${aiReply}`);
                
                // Send reply after 1-2 seconds (natural delay)
                setTimeout(async () => {
                    try {
                        await message.reply(aiReply);
                        console.log(`✅ Auto-reply sent to ${sender}`);
                        
                        // Store conversation
                        conversations.unshift({
                            id: Date.now(),
                            sender: sender,
                            userMessage: userMessage,
                            aiReply: aiReply,
                            timestamp: new Date().toISOString()
                        });
                        
                        // Keep only last 100 conversations
                        if (conversations.length > 100) {
                            conversations.pop();
                        }
                    } catch (err) {
                        console.error(`❌ Failed to send reply: ${err.message}`);
                    }
                }, 1500);
            }
        }
    });

    try {
        await client.initialize();
        clients[accountId] = client;
        console.log(`✅ Client ${accountId} initialized successfully`);
        return client;
    } catch (error) {
        console.error(`❌ Failed to initialize client ${accountId}:`, error.message);
        clientStatus[accountId] = 'error';
        return null;
    }
}

// Initialize default account on startup with retry
async function startBot() {
    console.log('🤖 Starting WhatsApp Bot...');
    
    let retries = 0;
    const maxRetries = 3;
    
    while (retries < maxRetries) {
        try {
            await initializeClient('account1');
            break;
        } catch (error) {
            retries++;
            console.log(`Retry ${retries}/${maxRetries} failed: ${error.message}`);
            if (retries === maxRetries && isRender) {
                console.log('Will continue retrying in background...');
                setInterval(() => {
                    if (!clients.account1 || clientStatus.account1 !== 'ready') {
                        initializeClient('account1');
                    }
                }, 30000);
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

startBot();

// ============= API ENDPOINTS =============

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        platform: process.platform,
        isRender: isRender,
        chromePath: chromeExecutablePath || 'auto-detect',
        activeClients: Object.keys(clients),
        clientStatus: clientStatus,
        conversationsCount: conversations.length
    });
});

// Get status with QR
app.get('/api/status/:accountId', (req, res) => {
    const { accountId } = req.params;
    
    const isReady = clientStatus[accountId] === 'ready';
    const qr = qrCodes[accountId] || null;
    
    res.json({ 
        accountId, 
        isReady, 
        qr,
        status: clientStatus[accountId] || 'unknown'
    });
});

// Send message manually
app.post('/api/send', async (req, res) => {
    const { accountId = 'account1', to, message } = req.body;
    
    if (!to || !message) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing to or message field' 
        });
    }
    
    try {
        const client = clients[accountId];
        
        if (!client || clientStatus[accountId] !== 'ready') {
            return res.status(400).json({ 
                success: false, 
                error: 'WhatsApp not connected' 
            });
        }
        
        let formattedNumber = to;
        if (!formattedNumber.includes('@c.us')) {
            formattedNumber = `${to}@c.us`;
        }
        
        await client.sendMessage(formattedNumber, message);
        console.log(`✅ Message sent to ${to}`);
        
        res.json({ success: true, message: 'Message sent successfully' });
        
    } catch (error) {
        console.error('Send error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all conversations
app.get('/api/conversations', (req, res) => {
    res.json({ conversations: conversations.slice(0, 50) });
});

// Reconnect endpoint
app.post('/api/reconnect/:accountId', async (req, res) => {
    const { accountId } = req.params;
    
    if (clients[accountId]) {
        try {
            await clients[accountId].destroy();
        } catch (err) {}
        delete clients[accountId];
    }
    
    delete qrCodes[accountId];
    clientStatus[accountId] = 'reconnecting';
    
    setTimeout(() => {
        initializeClient(accountId);
    }, 1000);
    
    res.json({ success: true, message: `Reconnecting ${accountId}...` });
});

// ============= QR VIEWER PAGE =============
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>WhatsApp AI Bot</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                    margin: 0;
                    background: linear-gradient(135deg, #075e54, #128c7e);
                    padding: 20px;
                }
                .container {
                    background: white;
                    padding: 40px;
                    border-radius: 20px;
                    text-align: center;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                    max-width: 500px;
                    width: 100%;
                }
                h1 { color: #075e54; margin-bottom: 10px; }
                .subtitle { color: #666; margin-bottom: 30px; }
                #qrContainer { margin: 20px 0; min-height: 260px; }
                img { width: 250px; height: 250px; border-radius: 10px; }
                .status {
                    padding: 12px;
                    border-radius: 8px;
                    margin: 20px 0;
                    font-weight: bold;
                }
                .waiting { background: #fff3cd; color: #856404; }
                .connected { background: #d4edda; color: #155724; }
                .error { background: #f8d7da; color: #721c24; }
                .steps {
                    text-align: left;
                    background: #f8f9fa;
                    padding: 15px;
                    border-radius: 10px;
                    font-size: 14px;
                }
                button {
                    background: #075e54;
                    color: white;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 5px;
                    cursor: pointer;
                    margin-top: 10px;
                }
                button:hover {
                    background: #054a42;
                }
                .loader {
                    border: 3px solid #f3f3f3;
                    border-top: 3px solid #075e54;
                    border-radius: 50%;
                    width: 40px;
                    height: 40px;
                    animation: spin 1s linear infinite;
                    margin: 0 auto;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 WhatsApp AI Bot</h1>
                <div class="subtitle">Connect your WhatsApp for Auto-Reply</div>
                
                <div id="qrContainer"><div class="loader"></div></div>
                <div id="status" class="status waiting">⏳ Loading...</div>
                
                <div class="steps">
                    <strong>📱 How to connect:</strong>
                    <ol>
                        <li>Open WhatsApp on your phone</li>
                        <li>Settings → Linked Devices → Link a Device</li>
                        <li>Scan the QR code above</li>
                        <li>Done! Auto-reply will work automatically</li>
                    </ol>
                </div>
                <button onclick="location.reload()">🔄 Refresh</button>
            </div>
            
            <script>
                async function checkStatus() {
                    try {
                        const res = await fetch('/api/status/account1');
                        const data = await res.json();
                        
                        if (data.isReady) {
                            document.getElementById('qrContainer').innerHTML = '<h2>✅ Connected!</h2><p>Your bot is active and auto-replying to messages.</p>';
                            document.getElementById('status').innerHTML = '✅ CONNECTED - Bot is active!';
                            document.getElementById('status').className = 'status connected';
                        } else if (data.qr) {
                            document.getElementById('qrContainer').innerHTML = '<img src="' + data.qr + '" alt="QR Code">';
                            document.getElementById('status').innerHTML = '📷 Scan QR code with WhatsApp';
                            document.getElementById('status').className = 'status waiting';
                        } else if (data.status === 'error') {
                            document.getElementById('qrContainer').innerHTML = '<p>❌ Connection error. Retrying...</p>';
                            document.getElementById('status').innerHTML = '⚠️ Connection issue - Auto-retrying';
                            document.getElementById('status').className = 'status error';
                        } else {
                            document.getElementById('qrContainer').innerHTML = '<div class="loader"></div>';
                            document.getElementById('status').innerHTML = '🔄 Initializing WhatsApp...';
                            document.getElementById('status').className = 'status waiting';
                        }
                    } catch (err) {
                        document.getElementById('qrContainer').innerHTML = '<p>❌ Error connecting to server</p>';
                        document.getElementById('status').innerHTML = '❌ Server error';
                        document.getElementById('status').className = 'status error';
                    }
                }
                
                checkStatus();
                setInterval(checkStatus, 3000);
            </script>
        </body>
        </html>
    `);
});

// ============= START SERVER =============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║     WHATSAPP AI AUTO-REPLY BOT BACKEND SERVER               ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  🚀 Server running on http://localhost:${PORT}                  ║`);
    console.log(`║  🌐 Open your browser: http://localhost:${PORT}                  ║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║  🤖 AI Auto-Reply is ACTIVE                                   ║');
    console.log('║  📨 Any incoming message will get AI reply                    ║');
    console.log(`║  💻 Platform: ${process.platform}                                           ║`);
    console.log(`║  🔧 Chrome: ${chromeExecutablePath ? '✅ Custom Path' : '🔄 Auto-detect'}                                      ║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
});