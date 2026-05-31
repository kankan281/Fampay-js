/**
 * â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
 * â•‘              FAMPAY API v2.2 - PERMANENT LOGIN + REAL-TIME                   â•‘
 * â•‘                                                                              â•‘
 * â•‘  âœ… NEW FEATURES:                                                            â•‘
 * â•‘     1. PERMANENT Google Login (No Expiry)                                    â•‘
 * â•‘     2. Continuous Payment Monitoring (Real-time)                             â•‘
 * â•‘     3. Auto-check every 10 seconds for new payments                          â•‘
 * â•‘     4. Webhook/Callback support for instant notification                     â•‘
 * â•‘     5. Persistent sessions with auto-recovery                                â•‘
 * â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 */

require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ========== FILE-BASED STORAGE ==========

function loadJSON(filename, defaultValue = {}) {
    try {
        const filepath = path.join(DATA_DIR, filename);
        if (fs.existsSync(filepath)) {
            const data = fs.readFileSync(filepath, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {}
    return defaultValue;
}

function saveJSON(filename, data) {
    try {
        const filepath = path.join(DATA_DIR, filename);
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        console.error('[Save Error]', e.message);
        return false;
    }
}

// Load all data
let ordersDB = loadJSON('orders.json', {});
let sessionsDB = loadJSON('sessions.json', {});
let credentialsDB = loadJSON('credentials.json', {});
let paymentCallbacksDB = loadJSON('callbacks.json', {});

// Auto-save every 10 seconds
setInterval(() => {
    saveJSON('orders.json', ordersDB);
    saveJSON('sessions.json', sessionsDB);
    saveJSON('credentials.json', credentialsDB);
    saveJSON('callbacks.json', paymentCallbacksDB);
    console.log('[Auto-Save] Data saved at', new Date().toISOString());
}, 10000);

// ========== CONFIGURATION ==========
const PORT = process.env.PORT || 5000;
const SECRET_KEY = process.env.SECRET_KEY || 'fampay-v2-permanent-2024';
const QR_EXPIRY_MINUTES = 15;
const PAYMENT_CHECK_INTERVAL = 10000; // 10 seconds
const PAYMENT_EMAIL_DEPTH = 500; // Check last 500 emails

// ========== UTILITY FUNCTIONS ==========

function getUTCTimestamp() {
    return new Date().toISOString();
}

function getBaseUrl(req) {
    return `${req.protocol}://${req.get('host')}`;
}

function isExpired(order) {
    if (!order || !order.created_at || order.paid) return false;
    const created = new Date(order.created_at);
    const now = new Date();
    const diffMinutes = (now - created) / (1000 * 60);
    return diffMinutes >= QR_EXPIRY_MINUTES;
}

function getExpiryTime(created_at) {
    return new Date(new Date(created_at).getTime() + QR_EXPIRY_MINUTES * 60 * 1000).toISOString();
}

function getTimeRemaining(created_at) {
    const expiry = new Date(new Date(created_at).getTime() + QR_EXPIRY_MINUTES * 60 * 1000);
    const remaining = Math.max(0, Math.floor((expiry - new Date()) / 1000));
    return {
        seconds: remaining,
        minutes: Math.floor(remaining / 60),
        expires_at: expiry.toISOString(),
        expired: remaining <= 0
    };
}

// ========== PERMANENT SESSION MANAGEMENT ==========

function createPermanentSession(gmail) {
    const sessionId = uuidv4();
    // Permanent API key (no expiry)
    const apiKey = crypto.createHash('sha256')
        .update(`${gmail}:${sessionId}:${SECRET_KEY}:${Date.now()}:permanent`)
        .digest('hex');
    
    const session = {
        gmail,
        session_id: sessionId,
        api_key: apiKey,
        created_at: getUTCTimestamp(),
        last_used: getUTCTimestamp(),
        last_payment_check: null,
        total_verifies: 0,
        permanent: true, // NEVER EXPIRES
        status: 'active'
    };
    
    // Store by gmail
    sessionsDB[gmail] = sessionsDB[gmail] || {};
    sessionsDB[gmail][sessionId] = session;
    
    // Also store by api_key for quick lookup
    sessionsDB[`key_${apiKey}`] = { gmail, session_id: sessionId };
    
    saveJSON('sessions.json', sessionsDB);
    
    console.log(`[Session] Created permanent session for ${gmail}`);
    
    return session;
}

function verifySession(apiKey) {
    try {
        // Try to find session
        const keyData = sessionsDB[`key_${apiKey}`];
        if (!keyData) return null;
        
        const { gmail, session_id } = keyData;
        const userSessions = sessionsDB[gmail];
        
        if (!userSessions || !userSessions[session_id]) return null;
        
        const session = userSessions[session_id];
        
        // Update last used
        session.last_used = getUTCTimestamp();
        session.total_verifies = (session.total_verifies || 0) + 1;
        saveJSON('sessions.json', sessionsDB);
        
        // Get stored credentials
        const credentials = credentialsDB[gmail];
        
        return { 
            gmail, 
            session,
            app_password: credentials?.app_password || null,
            has_credentials: !!credentials
        };
    } catch (e) {
        console.error('[Verify Error]', e);
        return null;
    }
}

function storeCredentials(gmail, appPassword) {
    credentialsDB[gmail] = {
        app_password: appPassword.replace(/[\s-]/g, ''),
        stored_at: getUTCTimestamp(),
        last_verified: getUTCTimestamp()
    };
    saveJSON('credentials.json', credentialsDB);
    console.log(`[Credentials] Stored for ${gmail}`);
}

// ========== EMAIL CHECKING ==========

async function validateGmailCredentials(gmail, appPassword) {
    return new Promise((resolve) => {
        try {
            const cleanPassword = appPassword.replace(/[\s-]/g, '');
            
            if (!gmail.endsWith('@gmail.com')) {
                resolve({ success: false, message: 'Only Gmail accounts are supported' });
                return;
            }
            
            if (cleanPassword.length < 10) {
                resolve({ success: false, message: 'App password must be at least 10 characters' });
                return;
            }

            const imap = new Imap({
                user: gmail,
                password: cleanPassword,
                host: 'imap.gmail.com',
                port: 993,
                tls: true,
                tlsOptions: { rejectUnauthorized: false },
                connTimeout: 20000
            });

            imap.once('ready', () => {
                imap.end();
                resolve({ success: true, message: 'Login successful' });
            });

            imap.once('error', (err) => {
                if (err.message.toLowerCase().includes('authentication')) {
                    resolve({ success: false, message: 'Invalid Gmail or App Password. Make sure IMAP is enabled in Gmail settings.' });
                } else {
                    resolve({ success: false, message: 'Connection failed: ' + err.message });
                }
            });

            imap.connect();

            setTimeout(() => {
                try { imap.end(); } catch (e) {}
                resolve({ success: false, message: 'Connection timeout. Check your internet.' });
            }, 20000);

        } catch (error) {
            resolve({ success: false, message: 'Error: ' + error.message });
        }
    });
}

async function checkGmailPayments(gmail, appPassword, orderId = null, orderAmount = null) {
    const payments = [];
    
    return new Promise((resolve) => {
        try {
            const cleanPassword = appPassword.replace(/[\s-]/g, '');
            
            const imap = new Imap({
                user: gmail,
                password: cleanPassword,
                host: 'imap.gmail.com',
                port: 993,
                tls: true,
                tlsOptions: { rejectUnauthorized: false },
                connTimeout: 60000
            });

            imap.once('ready', async () => {
                try {
                    imap.openBox('INBOX', false, async (err, box) => {
                        if (err) {
                            imap.end();
                            resolve(payments);
                            return;
                        }

                        const totalMessages = box.messages.total;
                        if (totalMessages === 0) {
                            imap.end();
                            resolve(payments);
                            return;
                        }

                        // Check last PAYMENT_EMAIL_DEPTH emails
                        const start = Math.max(1, totalMessages - PAYMENT_EMAIL_DEPTH + 1);
                        
                        imap.fetch(`${start}:${totalMessages}`, {
                            bodies: 'HEADER.FIELDS (FROM SUBJECT DATE UID)',
                            struct: true
                        }).on('message', (msg) => {
                            let msgData = { from: '', subject: '', date: '', uid: null };
                            
                            msg.on('body', (stream) => {
                                let buffer = '';
                                stream.on('data', (chunk) => buffer += chunk.toString());
                                stream.on('end', () => {
                                    const lines = buffer.split('\r\n');
                                    for (const line of lines) {
                                        if (line.startsWith('From: ')) msgData.from = line.replace('From: ', '');
                                        else if (line.startsWith('Subject: ')) msgData.subject = line.replace('Subject: ', '');
                                        else if (line.startsWith('Date: ')) msgData.date = line.replace('Date: ', '');
                                    }
                                });
                            });

                            msg.on('attributes', (attrs) => {
                                msgData.uid = attrs.uid;
                            });

                            msg.on('end', () => {
                                const fromLower = (msgData.from || '').toLowerCase();
                                const subjectLower = (msgData.subject || '').toLowerCase();
                                
                                // Famapp detection
                                const isFamapp = fromLower.includes('famapp') || 
                                                 fromLower.includes('fampay') ||
                                                 fromLower.includes('fam');
                                
                                // Payment detection
                                const isPayment = subjectLower.includes('â‚¹') ||
                                                  subjectLower.includes('payment') ||
                                                  subjectLower.includes('received') ||
                                                  subjectLower.includes('credited');
                                
                                if (isFamapp || (isPayment && fromLower.includes('fam'))) {
                                    payments.push({
                                        uid: msgData.uid,
                                        from: msgData.from,
                                        subject: msgData.subject,
                                        date: msgData.date,
                                        isFamapp
                                    });
                                }
                            });
                        }).on('end', () => {
                            imap.end();
                            console.log(`[Payment Check] Found ${payments.length} potential emails`);
                            resolve(payments);
                        }).on('error', () => {
                            imap.end();
                            resolve(payments);
                        });

                    });
                } catch (e) {
                    imap.end();
                    resolve(payments);
                }
            });

            imap.once('error', (err) => {
                console.log('[IMAP Error]', err.message);
                resolve(payments);
            });

            imap.connect();

            setTimeout(() => {
                try { imap.end(); } catch (e) {}
                resolve(payments);
            }, 90000);

        } catch (error) {
            console.log('[Check Error]', error.message);
            resolve(payments);
        }
    });
}

async function getEmailBody(gmail, appPassword, uid) {
    return new Promise((resolve) => {
        try {
            const cleanPassword = appPassword.replace(/[\s-]/g, '');
            
            const imap = new Imap({
                user: gmail,
                password: cleanPassword,
                host: 'imap.gmail.com',
                port: 993,
                tls: true,
                tlsOptions: { rejectUnauthorized: false },
                connTimeout: 25000
            });

            imap.once('ready', () => {
                imap.openBox('INBOX', false, (err) => {
                    if (err) {
                        imap.end();
                        resolve(null);
                        return;
                    }

                    const fetch = imap.fetch(uid, { bodies: '' });
                    
                    fetch.on('message', async (msg) => {
                        msg.on('body', async (stream) => {
                            try {
                                const parsed = await simpleParser(stream);
                                resolve({
                                    subject: parsed.subject || '',
                                    from: parsed.from?.text || '',
                                    date: parsed.date || '',
                                    text: parsed.text || '',
                                    html: parsed.html || ''
                                });
                            } catch (e) {
                                resolve(null);
                            }
                        });
                    });

                    fetch.on('error', () => {
                        imap.end();
                        resolve(null);
                    });

                    fetch.on('end', () => imap.end());
                });
            });

            imap.once('error', () => resolve(null));
            imap.connect();

            setTimeout(() => {
                try { imap.end(); } catch (e) {}
                resolve(null);
            }, 25000);

        } catch (error) {
            resolve(null);
        }
    });
}

function parsePayment(emailData, targetAmount = null) {
    if (!emailData) return null;
    
    const body = emailData.text || 
        (emailData.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    
    const result = {
        subject: emailData.subject || '',
        sender: emailData.from || '',
        amount: null,
        utr: null,
        payer_name: null,
        payer_upi: null,
        confidence: 0
    };

    // Extract amount
    const amountPatterns = [
        /â‚¹\s*([\d,]+\.?\d*)/,
        /Rs\.?\s*([\d,]+\.?\d*)/,
        /INR\s*([\d,]+\.?\d*)/,
    ];

    for (const pattern of amountPatterns) {
        const match = body.match(pattern);
        if (match) {
            try {
                const amount = parseFloat(match[1].replace(/,/g, ''));
                if (amount > 0 && amount < 10000000) {
                    result.amount = amount;
                    result.confidence += 50;
                    break;
                }
            } catch (e) {}
        }
    }

    // Extract UTR
    const utrMatch = body.match(/UTR[:\s]*([A-Z0-9]{6,20})/i) ||
                     body.match(/Transaction\s*ID[:\s]*([A-Z0-9]{6,20})/i);
    if (utrMatch) {
        result.utr = utrMatch[1].toUpperCase();
        result.confidence += 30;
    }

    // Extract UPI
    const upiMatch = body.match(/\b([a-zA-Z0-9._-]{3,30}@[a-zA-Z0-9.-]{2,20})\b/);
    if (upiMatch) {
        result.payer_upi = upiMatch[1];
        result.confidence += 10;
    }

    // Extract name
    const nameMatch = body.match(/(?:from|sent by)[:\s]+([A-Za-z\s.]{2,40})/i);
    if (nameMatch) {
        result.payer_name = nameMatch[1].trim();
        result.confidence += 10;
    }

    // Check amount match
    if (targetAmount && result.amount) {
        const tolerance = Math.max(0.01, targetAmount * 0.02);
        result.amount_match = Math.abs(result.amount - targetAmount) <= tolerance;
    }

    return result;
}

// ========== REAL-TIME PAYMENT MONITORING ==========

const paymentMonitorIntervals = {};

function startPaymentMonitoring(gmail, appPassword) {
    if (paymentMonitorIntervals[gmail]) {
        console.log(`[Monitor] Already monitoring ${gmail}`);
        return;
    }
    
    console.log(`[Monitor] Starting continuous monitoring for ${gmail}`);
    
    // Check every 10 seconds
    paymentMonitorIntervals[gmail] = setInterval(async () => {
        try {
            console.log(`[Monitor] Checking payments for ${gmail}...`);
            
            // Get all unpaid orders for this gmail's upi
            const unpaidOrders = Object.values(ordersDB)
                .filter(o => !o.paid && !isExpired(o));
            
            if (unpaidOrders.length === 0) {
                console.log(`[Monitor] No unpaid orders for ${gmail}`);
                return;
            }
            
            // Check Gmail for new payments
            const payments = await checkGmailPayments(gmail, appPassword);
            
            console.log(`[Monitor] Found ${payments.length} potential payments`);
            
            // Check each payment email
            for (const email of payments) {
                const emailBody = await getEmailBody(gmail, appPassword, email.uid);
                if (!emailBody) continue;
                
                const paymentInfo = parsePayment(emailBody);
                
                if (paymentInfo && paymentInfo.amount) {
                    // Check against all unpaid orders
                    for (const order of unpaidOrders) {
                        if (paymentInfo.amount_match && Math.abs(paymentInfo.amount - order.amount) < 0.01) {
                            console.log(`[Monitor] ðŸ’° PAYMENT FOUND! Order: ${order.order_id}, Amount: â‚¹${paymentInfo.amount}`);
                            
                            // Mark as paid
                            order.paid = true;
                            order.paid_at = getUTCTimestamp();
                            order.utr = paymentInfo.utr || `AUTO_${Date.now()}`;
                            order.payer_name = paymentInfo.payer_name || 'Unknown';
                            order.payer_upi = paymentInfo.payer_upi;
                            order.email_subject = paymentInfo.subject;
                            order.auto_verified = true;
                            
                            ordersDB[order.order_id] = order;
                            saveJSON('orders.json', ordersDB);
                            
                            // Trigger callbacks if any
                            triggerPaymentCallbacks(order, paymentInfo);
                            
                            console.log(`[Monitor] âœ… Order ${order.order_id} marked as PAID!`);
                        }
                    }
                }
            }
            
        } catch (error) {
            console.error(`[Monitor Error] ${gmail}:`, error.message);
        }
    }, PAYMENT_CHECK_INTERVAL);
}

function stopPaymentMonitoring(gmail) {
    if (paymentMonitorIntervals[gmail]) {
        clearInterval(paymentMonitorIntervals[gmail]);
        delete paymentMonitorIntervals[gmail];
        console.log(`[Monitor] Stopped monitoring for ${gmail}`);
    }
}

function triggerPaymentCallbacks(order, paymentInfo) {
    const callbacks = paymentCallbacksDB[order.gmail] || [];
    
    for (const callback of callbacks) {
        console.log(`[Callback] Triggering: ${callback.url}`);
        // Fire and forget
        fetch(callback.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                event: 'payment_received',
                order_id: order.order_id,
                amount: order.amount,
                upi_id: order.upi_id,
                utr: order.utr,
                payer_name: order.payer_name,
                payer_upi: order.payer_upi,
                paid_at: order.paid_at
            })
        }).catch(e => console.log('[Callback Error]', e.message));
    }
}

// ========== QR CODE GENERATION ==========

async function generateQRCode(upiId, amount, orderId) {
    const upiUrl = `upi://pay?pa=${upiId}&pn=Fampay&am=${amount}&tr=${orderId}&tn=Order%20${orderId}&cu=INR&mam=1&mode=04`;
    
    try {
        return await QRCode.toBuffer(upiUrl, {
            type: 'png',
            width: 400,
            margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' },
            errorCorrectionLevel: 'H'
        });
    } catch (error) {
        console.error('[QR Error]', error);
        throw error;
    }
}

// ========== MIDDLEWARE ==========

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ========== API ROUTES ==========

// Home
app.get('/', (req, res) => {
    const totalOrders = Object.keys(ordersDB).length;
    const paidOrders = Object.values(ordersDB).filter(o => o.paid).length;
    const activeSessions = Object.keys(sessionsDB).filter(k => k.startsWith('key_')).length;
    const monitoring = Object.keys(paymentMonitorIntervals).length;
    
    res.send(`<!DOCTYPE html>
<html><head><title>Fampay API v2.2 - Permanent</title></head>
<body style="font-family:Arial;background:#1a1a2e;color:white;padding:40px;text-align:center">
<h1 style="color:#667eea">ðŸ’° Fampay API v2.2</h1>
<h2 style="color:#10b981">PERMANENT LOGIN + REAL-TIME MONITORING</h2>
<div style="background:rgba(255,255,255,0.1);padding:20px;border-radius:10px;margin:20px auto;max-width:700px;text-align:left">
<h3>ðŸ“Š System Status</h3>
<p>ðŸ“¦ Total Orders: <b>${totalOrders}</b></p>
<p>âœ… Paid Orders: <b>${paidOrders}</b></p>
<p>ðŸ”‘ Active Sessions: <b>${activeSessions}</b></p>
<p>ðŸ”„ Real-time Monitors: <b>${monitoring}</b></p>
</div>
<div style="background:#10b981;padding:15px;border-radius:8px;margin:20px auto;max-width:700px">
âœ… PERMANENT Google Login (Never expires)<br>
âœ… Real-time Payment Detection (Every 10 sec)<br>
âœ… Auto-verify on payment receipt<br>
âœ… Webhook/Callback support
</div>
<div style="background:rgba(255,255,255,0.1);padding:20px;border-radius:10px;margin:20px auto;max-width:700px;text-align:left">
<h3>ðŸ“¡ Endpoints</h3>
<p><b>POST</b> /api/create-order - Create QR</p>
<p><b>POST</b> /api/gmail-login - Permanent Login</p>
<p><b>POST</b> /api/register-callback - Register webhook</p>
<p><b>GET</b> /api/verify-payment - Check payment</p>
<p><b>GET</b> /api/get-qr - Get QR Image</p>
<p><b>GET</b> /api/health - System status</p>
<p><b>GET</b> /api/orders - All orders</p>
</div>
</body></html>`);
});

// ========== CREATE ORDER ==========
app.post('/api/create-order', async (req, res) => {
    try {
        const { upi_id, amount } = req.body;

        if (!upi_id || typeof upi_id !== 'string') {
            return res.status(400).json({ success: false, error: 'upi_id is required' });
        }

        const upiId = upi_id.trim();
        if (!upiId.includes('@')) {
            return res.status(400).json({ success: false, error: 'Invalid UPI ID' });
        }

        if (amount === undefined || amount === null) {
            return res.status(400).json({ success: false, error: 'amount is required' });
        }

        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            return res.status(400).json({ success: false, error: 'amount must be > 0' });
        }

        const orderId = `ORD_${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
        const timestamp = getUTCTimestamp();
        const baseUrl = getBaseUrl(req);

        // Generate QR
        const qrBuffer = await generateQRCode(upiId, amountNum, orderId);
        const qrBase64 = qrBuffer.toString('base64');

        // Save order
        const orderData = {
            order_id: orderId,
            upi_id: upiId,
            amount: amountNum,
            created_at: timestamp,
            expires_at: getExpiryTime(timestamp),
            paid: false,
            paid_at: null,
            utr: null,
            payer_name: null,
            payer_upi: null,
            auto_verified: false
        };
        
        ordersDB[orderId] = orderData;
        saveJSON('orders.json', ordersDB);

        const timeRemaining = getTimeRemaining(timestamp);

        return res.status(200).json({
            success: true,
            order_id: orderId,
            upi_id: upiId,
            amount: amountNum,
            
            // QR Image
            qr_code_base64: qrBase64,
            qr_url: `upi://pay?pa=${upiId}&pn=Fampay&am=${amountNum}&tr=${orderId}&cu=INR`,
            
            // FULL Image URL
            qr_image_url: `${baseUrl}/api/get-qr?order_id=${orderId}`,
            qr_image_direct: `${baseUrl}/api/get-qr?order_id=${orderId}`,
            
            // Deep links
            google_pay_url: `https://pay.google.com/pay?pa=${upiId}&pn=Fampay&am=${amountNum}&tr=${orderId}`,
            
            // Expiry
            expires_in_minutes: QR_EXPIRY_MINUTES,
            expires_at: orderData.expires_at,
            time_remaining_seconds: timeRemaining.seconds,
            time_remaining_formatted: `${timeRemaining.minutes}m ${timeRemaining.seconds % 60}s`,
            
            created_at: timestamp,
            message: `QR generated for â‚¹${amountNum} to ${upiId}. Valid ${QR_EXPIRY_MINUTES} min. Real-time monitoring active!`
        });

    } catch (error) {
        console.error('[Create Error]', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ========== PERMANENT GMAIL LOGIN ==========
app.post('/api/gmail-login', async (req, res) => {
    try {
        const { gmail, app_password } = req.body;

        if (!gmail || !app_password) {
            return res.status(400).json({ success: false, error: 'gmail and app_password required' });
        }

        const gmailTrim = gmail.trim().toLowerCase();
        if (!gmailTrim.endsWith('@gmail.com')) {
            return res.status(400).json({ success: false, error: 'Only Gmail accounts supported' });
        }

        // Validate
        const validation = await validateGmailCredentials(gmailTrim, app_password);
        if (!validation.success) {
            return res.status(401).json({ success: false, error: validation.message });
        }

        // Store credentials permanently
        storeCredentials(gmailTrim, app_password);

        // Create permanent session
        const session = createPermanentSession(gmailTrim);

        // Start real-time payment monitoring
        startPaymentMonitoring(gmailTrim, app_password.replace(/[\s-]/g, ''));

        return res.status(200).json({
            success: true,
            gmail: gmailTrim,
            api_key: session.api_key,
            session_id: session.session_id,
            permanent: true,
            expires_never: true,
            logged_in_at: getUTCTimestamp(),
            monitoring_active: true,
            monitoring_interval_seconds: PAYMENT_CHECK_INTERVAL / 1000,
            message: 'âœ… PERMANENT login successful! Payment monitoring ACTIVE.',
            tips: [
                'API key never expires',
                'Payment auto-verified when received',
                'Real-time monitoring every 10 seconds',
                'Store API key securely'
            ]
        });

    } catch (error) {
        console.error('[Login Error]', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ========== VERIFY PAYMENT ==========
app.get('/api/verify-payment', async (req, res) => {
    try {
        const { api_key, order_id } = req.query;

        if (!api_key || !order_id) {
            return res.status(400).json({ success: false, error: 'api_key and order_id required' });
        }

        // Verify session
        const account = verifySession(api_key);
        if (!account) {
            return res.status(401).json({ success: false, error: 'Invalid API key. Login again.' });
        }

        if (!account.app_password) {
            return res.status(401).json({ success: false, error: 'Credentials not stored. Login again.' });
        }

        // Check order
        const order = ordersDB[order_id];
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        // Check expiry
        if (isExpired(order)) {
            return res.status(200).json({
                success: true,
                payment_received: false,
                order_id: order_id,
                expired: true,
                message: 'QR expired. Create new order.'
            });
        }

        // If already paid, return
        if (order.paid) {
            return res.status(200).json({
                success: true,
                payment_received: true,
                order_id: order_id,
                amount: order.amount,
                utr: order.utr,
                payer_name: order.payer_name,
                payer_upi: order.payer_upi,
                paid_at: order.paid_at,
                auto_verified: order.auto_verified || false,
                message: 'âœ… Payment already verified!',
                monitoring_active: !!paymentMonitorIntervals[account.gmail]
            });
        }

        // Get time remaining
        const timeRemaining = getTimeRemaining(order.created_at);

        // Do fresh payment check
        console.log(`[Verify] Checking for order ${order_id}, amount â‚¹${order.amount}`);
        const payments = await checkGmailPayments(account.gmail, account.app_password, order_id, order.amount);

        let matched = null;
        for (const email of payments) {
            const emailBody = await getEmailBody(account.gmail, account.app_password, email.uid);
            if (!emailBody) continue;

            const paymentInfo = parsePayment(emailBody, order.amount);
            if (paymentInfo && paymentInfo.amount_match) {
                matched = paymentInfo;
                console.log(`[Verify] Match! â‚¹${paymentInfo.amount}`);
                break;
            }
        }

        if (matched) {
            order.paid = true;
            order.paid_at = getUTCTimestamp();
            order.utr = matched.utr || `AUTO_${Date.now()}`;
            order.payer_name = matched.payer_name || 'Unknown';
            order.payer_upi = matched.payer_upi;
            order.email_subject = matched.subject;
            order.auto_verified = false; // Manual verify
            
            ordersDB[order_id] = order;
            saveJSON('orders.json', ordersDB);

            triggerPaymentCallbacks(order, matched);

            return res.status(200).json({
                success: true,
                payment_received: true,
                order_id: order_id,
                amount: order.amount,
                utr: order.utr,
                payer_name: order.payer_name,
                payer_upi: order.payer_upi,
                paid_at: order.paid_at,
                message: 'âœ… Payment verified!',
                monitoring_active: !!paymentMonitorIntervals[account.gmail]
            });
        }

        return res.status(200).json({
            success: true,
            payment_received: false,
            order_id: order_id,
            amount: order.amount,
            time_remaining_seconds: timeRemaining.seconds,
            monitoring_active: !!paymentMonitorIntervals[account.gmail],
            message: 'â³ No payment found. Real-time monitor is checking...',
            auto_retry: true
        });

    } catch (error) {
        console.error('[Verify Error]', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ========== GET QR IMAGE ==========
app.get('/api/get-qr', async (req, res) => {
    try {
        const { order_id } = req.query;

        if (!order_id) {
            return res.status(400).json({ success: false, error: 'order_id required' });
        }

        const order = ordersDB[order_id];
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        if (isExpired(order)) {
            return res.status(410).json({ success: false, error: 'QR expired', expired: true });
        }

        const qrBuffer = await generateQRCode(order.upi_id, order.amount, order.order_id);

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.send(qrBuffer);

    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ========== REGISTER CALLBACK/WEBHOOK ==========
app.post('/api/register-callback', (req, res) => {
    try {
        const { api_key, url, events } = req.body;

        const account = verifySession(api_key);
        if (!account) {
            return res.status(401).json({ success: false, error: 'Invalid API key' });
        }

        if (!url) {
            return res.status(400).json({ success: false, error: 'url required' });
        }

        paymentCallbacksDB[account.gmail] = paymentCallbacksDB[account.gmail] || [];
        
        // Add callback
        const callback = {
            url,
            events: events || ['payment_received'],
            created_at: getUTCTimestamp(),
            active: true
        };
        
        paymentCallbacksDB[account.gmail].push(callback);
        saveJSON('callbacks.json', paymentCallbacksDB);

        return res.status(200).json({
            success: true,
            message: 'Webhook registered!',
            callback_url: url,
            total_callbacks: paymentCallbacksDB[account.gmail].length
        });

    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ========== GET ALL ORDERS ==========
app.get('/api/orders', (req, res) => {
    const { api_key, status } = req.query;

    const account = verifySession(api_key);
    if (!account) {
        return res.status(401).json({ success: false, error: 'Invalid API key' });
    }

    let orders = Object.values(ordersDB);
    
    if (status === 'paid') orders = orders.filter(o => o.paid);
    else if (status === 'pending') orders = orders.filter(o => !o.paid && !isExpired(o));
    else if (status === 'expired') orders = orders.filter(o => isExpired(o) && !o.paid);

    return res.status(200).json({
        success: true,
        total: orders.length,
        paid_count: orders.filter(o => o.paid).length,
        pending_count: orders.filter(o => !o.paid).length,
        orders: orders.reverse()
    });
});

// ========== GET MONITORING STATUS ==========
app.get('/api/monitoring-status', (req, res) => {
    const { api_key } = req.query;

    const account = verifySession(api_key);
    if (!account) {
        return res.status(401).json({ success: false, error: 'Invalid API key' });
    }

    return res.status(200).json({
        success: true,
        gmail: account.gmail,
        monitoring_active: !!paymentMonitorIntervals[account.gmail],
        check_interval_seconds: PAYMENT_CHECK_INTERVAL / 1000,
        last_check: account.session?.last_used,
        unpaid_orders: Object.values(ordersDB).filter(o => !o.paid && !isExpired(o)).length,
        total_paid_orders: Object.values(ordersDB).filter(o => o.paid).length
    });
});

// ========== HEALTH CHECK ==========
app.get('/api/health', (req, res) => {
    const totalOrders = Object.keys(ordersDB).length;
    const paidOrders = Object.values(ordersDB).filter(o => o.paid).length;
    const activeMonitors = Object.keys(paymentMonitorIntervals).length;
    const totalCallbacks = Object.values(paymentCallbacksDB).reduce((sum, cbs) => sum + cbs.length, 0);

    return res.status(200).json({
        status: 'ok',
        timestamp: getUTCTimestamp(),
        version: '2.2',
        uptime: process.uptime(),
        system: {
            total_orders: totalOrders,
            paid_orders: paidOrders,
            active_monitors: activeMonitors,
            total_callbacks: totalCallbacks,
            sessions_active: Object.keys(sessionsDB).filter(k => k.startsWith('key_')).length,
            auto_save_interval: 10
        },
        features: [
            'PERMANENT Login (No Expiry)',
            'Real-time Payment Monitor (10s)',
            'Auto-verify on payment',
            'Webhook/Callback support'
        ]
    });
});

// ========== ERROR HANDLERS ==========
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
    res.status(500).json({ success: false, error: 'Server error' });
});

// ========== START SERVER ==========
process.on('SIGINT', () => {
    console.log('Saving all data...');
    saveJSON('orders.json', ordersDB);
    saveJSON('sessions.json', sessionsDB);
    saveJSON('credentials.json', credentialsDB);
    saveJSON('callbacks.json', paymentCallbacksDB);
    process.exit();
});

app.listen(PORT, '0.0.0.0', () => {
    // Resume monitoring for stored sessions
    console.log('[Init] Resuming payment monitors...');
    for (const gmail in credentialsDB) {
        const cred = credentialsDB[gmail];
        if (cred.app_password) {
            startPaymentMonitoring(gmail, cred.app_password);
        }
    }
    
    console.log(`
â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
â•‘           FAMPAY API v2.2 (PERMANENT + REAL-TIME)          â•‘
â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£
â•‘  ðŸŒ Server: http://localhost:${PORT}                         â•‘
â•‘  â¤ï¸ Status: RUNNING                                        â•‘
â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£
â•‘  âœ… PERMANENT Google Login (Never expires)                  â•‘
â•‘  âœ… Real-time Payment Monitor (Every 10 seconds)            â•‘
â•‘  âœ… Auto-verify on payment receipt                          â•‘
â•‘  âœ… Webhook/Callback support                                â•‘
â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    `);
});

module.exports = app;
