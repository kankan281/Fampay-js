/**
 * â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
 * â•‘                    FAMPAY UPI QR CODE API - Node.js Version                  â•‘
 * â•‘                                                                              â•‘
 * â•‘  ðŸ”— API ENDPOINTS:                                                           â•‘
 * â•‘     POST /api/create-order   â†’ Create order + Generate QR code              â•‘
 * â•‘     POST /api/gmail-login    â†’ Login with Gmail + App Password â†’ Get API Keyâ•‘
 * â•‘     GET  /api/verify-payment â†’ Verify payment via API Key + Order ID        â•‘
 * â•‘     GET  /api/payment-historyâ†’ Get all payment history from Gmail           â•‘
 * â•‘     GET  /api/get-qr         â†’ Get QR code image                            â•‘
 * â•‘     GET  /api/orders         â†’ Get all orders                               â•‘
 * â•‘     GET  /api/health         â†’ Health check                                 â•‘
 * â•‘                                                                              â•‘
 * â•‘  ðŸ’° Example: upi_id: kankan1@fam, amount: 1                                  â•‘
 * â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 */

require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ========== IN-MEMORY DATABASE ==========
const ordersDB = {};       // order_id -> order details
const gmailDB = {};        // api_key -> gmail credentials
const paymentCache = {};   // gmail -> list of cached payments

// ========== CONFIGURATION ==========
const PORT = process.env.PORT || 5000;
const SECRET_KEY = process.env.SECRET_KEY || 'fampay-secret-key-2024-change-in-production';
const MAX_EMAIL_CHECK = 100;

// ========== UTILITY FUNCTIONS ==========

function getUTCTimestamp() {
    return new Date().toISOString();
}

function generateAPIKey(gmail) {
    const rawData = `${gmail}${getUTCTimestamp()}${SECRET_KEY}${uuidv4()}`;
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(rawData).digest('base64').slice(0, 32);
}

function cleanAppPassword(password) {
    return password.replace(/[\s-]/g, '');
}

function validateGmail(gmail) {
    return gmail && gmail.endsWith('@gmail.com') && gmail.length > 10;
}

function validateAppPassword(password) {
    const clean = cleanAppPassword(password);
    return clean && clean.length >= 10;
}

// ========== EMAIL CHECKING FUNCTIONS ==========

async function validateGmailCredentials(gmail, appPassword) {
    return new Promise((resolve) => {
        try {
            const cleanPassword = cleanAppPassword(appPassword);
            
            if (!validateGmail(gmail)) {
                resolve({ success: false, message: 'Only Gmail accounts are supported' });
                return;
            }
            
            if (!validateAppPassword(appPassword)) {
                resolve({ success: false, message: 'App password must be at least 10 characters' });
                return;
            }

            const imap = new Imap({
                user: gmail,
                password: cleanPassword,
                host: 'imap.gmail.com',
                port: 993,
                tls: true,
                tlsOptions: { rejectUnauthorized: false }
            });

            imap.once('ready', () => {
                imap.end();
                resolve({ success: true, message: 'Login successful' });
            });

            imap.once('error', (err) => {
                const errorMsg = err.message.toLowerCase();
                if (errorMsg.includes('authentication') || errorMsg.includes('invalid')) {
                    resolve({ success: false, message: 'Invalid Gmail or App Password' });
                } else if (errorMsg.includes('connect')) {
                    resolve({ success: false, message: 'Connection failed. Check internet.' });
                } else {
                    resolve({ success: false, message: 'Login failed: ' + err.message });
                }
            });

            imap.connect();

            // Timeout after 10 seconds
            setTimeout(() => {
                if (!imap._state || imap._state !== 'authenticated') {
                    imap.end();
                    resolve({ success: false, message: 'Connection timeout. Try again.' });
                }
            }, 10000);

        } catch (error) {
            resolve({ success: false, message: 'Error: ' + error.message });
        }
    });
}

async function checkGmailPayments(gmail, appPassword, maxCheck = 50) {
    const payments = [];
    
    return new Promise((resolve) => {
        try {
            const cleanPassword = cleanAppPassword(appPassword);
            
            const imap = new Imap({
                user: gmail,
                password: cleanPassword,
                host: 'imap.gmail.com',
                port: 993,
                tls: true,
                tlsOptions: { rejectUnauthorized: false }
            });

            imap.once('ready', async () => {
                try {
                    imap.openBox('INBOX', true, async (err, box) => {
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

                        // Get last N messages
                        const start = Math.max(1, totalMessages - maxCheck + 1);
                        const fetchRange = `${start}:${totalMessages}`;

                        const fetch = imap.seq.fetch(fetchRange, {
                            bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)',
                            struct: true
                        });

                        fetch.on('message', async (msg, seqno) => {
                            msg.on('body', async (stream, info) => {
                                try {
                                    const parsed = await simpleParser(stream);
                                    const payment = parsePaymentEmail(parsed);
                                    if (payment) {
                                        payments.push(payment);
                                    }
                                } catch (e) {
                                    // Skip invalid emails
                                }
                            });
                        });

                        fetch.once('error', (err) => {
                            imap.end();
                            resolve(payments);
                        });

                        fetch.once('end', () => {
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
                console.log('IMAP Error:', err.message);
                resolve(payments);
            });

            imap.connect();

            // Timeout after 30 seconds
            setTimeout(() => {
                try { imap.end(); } catch (e) {}
                resolve(payments);
            }, 30000);

        } catch (error) {
            console.log('Error checking Gmail:', error.message);
            resolve(payments);
        }
    });
}

function parsePaymentEmail(emailData) {
    const info = {
        source: 'email',
        subject: emailData.subject || '',
        sender: emailData.from?.text || '',
        date: emailData.date || '',
        amount: null,
        utr: null,
        payer_name: null,
        payer_upi: null,
        message: null
    };

    // Get text body
    let body = '';
    if (emailData.text) {
        body = emailData.text;
    } else if (emailData.html) {
        // Simple HTML to text
        body = emailData.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    }

    const bodyLower = body.toLowerCase();

    // Check if it's a payment email
    const paymentKeywords = ['â‚¹', 'rs.', 'amount', 'credited', 'received', 'upi', 'payment'];
    if (!paymentKeywords.some(kw => bodyLower.includes(kw))) {
        return null;
    }

    // Extract amount
    const amountPatterns = [
        /â‚¹\s*([\d,]+\.?\d*)/i,
        /Rs\.?\s*([\d,]+\.?\d*)/i,
        /Amount[:\s]*â‚¹?\s*([\d,]+\.?\d*)/i,
        /inr\s*([\d,]+\.?\d*)/i
    ];

    for (const pattern of amountPatterns) {
        const match = body.match(pattern);
        if (match) {
            try {
                const amountStr = match[1].replace(/,/g, '');
                info.amount = parseFloat(amountStr);
                break;
            } catch (e) {}
        }
    }

    // Extract UTR
    const utrPatterns = [
        /UTR[:\s]*([A-Z0-9]{6,12})/i,
        /UPI\s?ID[:\s]*([a-zA-Z0-9@._-]+)/i,
        /Txn\s?ID[:\s]*([A-Z0-9]+)/i,
        /Transaction\s?ID[:\s]*([A-Z0-9]+)/i,
        /Reference[:\s]*([A-Z0-9]+)/i
    ];

    for (const pattern of utrPatterns) {
        const match = body.match(pattern);
        if (match) {
            info.utr = match[1].trim().toUpperCase();
            break;
        }
    }

    // Extract payer UPI ID
    const upiMatch = body.match(/\b([a-zA-Z0-9._-]{3,30}@[a-zA-Z0-9.-]{2,20})\b/);
    if (upiMatch) {
        info.payer_upi = upiMatch[1].trim();
    }

    // Extract payer name
    const namePatterns = [
        /from\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i,
        /Sent\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i,
        /Name[:\s]*([A-Za-z\s]{2,30})/i
    ];

    for (const pattern of namePatterns) {
        const match = body.match(pattern);
        if (match) {
            info.payer_name = match[1].trim().slice(0, 50);
            break;
        }
    }

    // Extract message
    const msgPatterns = [
        /Message[:\s]*(.+)/i,
        /Note[:\s]*(.+)/i,
        /Description[:\s]*(.+)/i
    ];

    for (const pattern of msgPatterns) {
        const match = body.match(pattern);
        if (match) {
            info.message = match[1].trim().slice(0, 100);
            break;
        }
    }

    return info;
}

function matchPaymentToOrder(payments, orderAmount) {
    for (const p of payments) {
        if (p.amount && Math.abs(p.amount - orderAmount) < 0.01) {
            return p;
        }
    }
    return null;
}

// ========== QR CODE GENERATION ==========

async function generateQRCode(upiId, amount, orderId) {
    const upiUrl = `upi://pay?pa=${upiId}&pn=Fampay&am=${amount}&tr=${orderId}&tn=Payment for Order ${orderId}&cu=INR`;
    
    const qrBuffer = await QRCode.toBuffer(upiUrl, {
        type: 'png',
        width: 400,
        margin: 2,
        color: {
            dark: '#000000',
            light: '#FFFFFF'
        },
        errorCorrectionLevel: 'M'
    });
    
    return qrBuffer;
}

// ========== API ROUTES ==========

// Home - API Documentation
app.get('/', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>ðŸ’° Fampay UPI QR Code API - Node.js</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                min-height: 100vh;
                padding: 40px 20px;
                color: #fff;
            }
            .container { max-width: 950px; margin: 0 auto; }
            .card {
                background: rgba(255,255,255,0.05);
                backdrop-filter: blur(10px);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 20px;
                padding: 35px;
                margin-bottom: 25px;
            }
            h1 {
                text-align: center;
                font-size: 2.5em;
                margin-bottom: 10px;
                background: linear-gradient(135deg, #667eea, #764ba2);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
            }
            .subtitle { text-align: center; color: #888; margin-bottom: 30px; }
            h2 { color: #667eea; margin: 25px 0 15px; border-bottom: 2px solid rgba(102,126,234,0.3); padding-bottom: 10px; }
            .endpoint { background: rgba(0,0,0,0.3); border-left: 4px solid #667eea; padding: 20px; margin: 20px 0; border-radius: 0 12px 12px 0; }
            .method { display: inline-block; padding: 5px 14px; border-radius: 8px; font-weight: bold; margin-right: 12px; }
            .POST { background: #10b981; color: white; }
            .GET { background: #3b82f6; color: white; }
            code { background: #1e1e1e; color: #4ade80; padding: 4px 10px; border-radius: 6px; font-family: monospace; }
            pre { background: #0d1117; color: #c9d1d9; padding: 20px; border-radius: 10px; overflow-x: auto; margin: 12px 0; font-size: 0.85em; }
            .note { background: rgba(255,193,7,0.1); border: 1px solid rgba(255,193,7,0.3); padding: 18px; border-radius: 12px; margin: 18px 0; }
            .note-title { font-weight: bold; color: #ffc107; margin-bottom: 10px; }
            .footer { text-align: center; color: #666; margin-top: 30px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="card">
                <h1>ðŸ’° Fampay UPI QR Code API</h1>
                <p class="subtitle">Node.js Version | Generate QR Codes & Verify Payments</p>

                <h2>ðŸ“¡ API Endpoints</h2>

                <div class="endpoint">
                    <span class="method POST">POST</span><code>/api/create-order</code>
                    <p style="margin-top:12px;color:#aaa;">Body: {"upi_id": "kankan1@fam", "amount": 1}</p>
                    <pre>Response: {"success": true, "order_id": "ORD_XXX", "qr_code_base64": "...", ...}</pre>
                </div>

                <div class="endpoint">
                    <span class="method POST">POST</span><code>/api/gmail-login</code>
                    <p style="margin-top:12px;color:#aaa;">Body: {"gmail": "xxx@gmail.com", "app_password": "xxxx xxxx xxxx xxxx"}</p>
                    <div class="note">
                        <div class="note-title">âš ï¸ How to Generate App Password</div>
                        <p>1. myaccount.google.com â†’ Security â†’ Enable 2-Step Verification</p>
                        <p>2. Go to App Passwords â†’ Generate â†’ Select "Mail" â†’ Copy 16-char password</p>
                        <p>3. Enable IMAP in Gmail Settings â†’ Forwarding and POP/IMAP</p>
                    </div>
                </div>

                <div class="endpoint">
                    <span class="method GET">GET</span><code>/api/verify-payment?api_key=KEY&order_id=ORDER_ID</code>
                    <p style="margin-top:12px;color:#aaa;">Verify if payment was received</p>
                </div>

                <div class="endpoint">
                    <span class="method GET">GET</span><code>/api/get-qr?order_id=ORDER_ID</code>
                    <p style="margin-top:12px;color:#aaa;">Get QR code PNG image</p>
                </div>

                <div class="endpoint">
                    <span class="method GET">GET</span><code>/api/health</code>
                    <p style="margin-top:12px;color:#aaa;">Health check</p>
                </div>

                <h2>ðŸ”„ How It Works</h2>
                <ol style="margin:15px 0;padding-left:20px;line-height:2;color:#aaa;">
                    <li><strong>Step 1:</strong> Create order â†’ Get QR code + Order ID</li>
                    <li><strong>Step 2:</strong> Share QR code with customer</li>
                    <li><strong>Step 3:</strong> Customer pays â†’ Fampay sends email</li>
                    <li><strong>Step 4:</strong> Gmail login â†’ Get API key</li>
                    <li><strong>Step 5:</strong> Verify payment â†’ Get payment details!</li>
                </ol>
            </div>
            <div class="footer">Fampay QR Code API v1.0 (Node.js) | Built with â¤ï¸</div>
        </div>
    </body>
    </html>
    `;
    res.send(html);
});

// ========== CREATE ORDER ==========
app.post('/api/create-order', async (req, res) => {
    try {
        const { upi_id, amount } = req.body;

        // Validate UPI ID
        if (!upi_id || typeof upi_id !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'upi_id is required'
            });
        }

        const upiId = upi_id.trim();
        if (!upiId.includes('@')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid UPI ID format. Must contain @ symbol (e.g., kankan1@fam)'
            });
        }

        // Validate amount
        if (amount === undefined || amount === null) {
            return res.status(400).json({
                success: false,
                error: 'amount is required'
            });
        }

        const amountNum = parseFloat(amount);
        if (isNaN(amountNum)) {
            return res.status(400).json({
                success: false,
                error: 'amount must be a valid number'
            });
        }

        if (amountNum <= 0) {
            return res.status(400).json({
                success: false,
                error: 'amount must be greater than 0'
            });
        }

        if (amountNum > 100000) {
            return res.status(400).json({
                success: false,
                error: 'amount exceeds maximum limit (100000)'
            });
        }

        // Generate order ID
        const orderId = `ORD_${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

        // Store order
        const orderData = {
            order_id: orderId,
            upi_id: upiId,
            amount: amountNum,
            created_at: getUTCTimestamp(),
            paid: false,
            paid_at: null,
            utr: null,
            payer_name: null,
            payer_upi: null
        };
        ordersDB[orderId] = orderData;

        // Generate QR code
        const qrBuffer = await generateQRCode(upiId, amountNum, orderId);
        const qrBase64 = qrBuffer.toString('base64');
        const upiUrl = `upi://pay?pa=${upiId}&pn=Fampay&am=${amountNum}&tr=${orderId}&cu=INR`;

        return res.status(200).json({
            success: true,
            order_id: orderId,
            upi_id: upiId,
            amount: amountNum,
            qr_code_base64: qrBase64,
            qr_url: upiUrl,
            qr_image_url: `/api/get-qr?order_id=${orderId}`,
            upi_deep_link: `https://upi://pay?pa=${upiId}&pn=Fampay&am=${amountNum}&tr=${orderId}&cu=INR`,
            created_at: orderData.created_at,
            message: `QR code generated for â‚¹${amountNum} to ${upiId}`
        });

    } catch (error) {
        console.error('Create order error:', error);
        return res.status(500).json({
            success: false,
            error: 'Server error: ' + error.message
        });
    }
});

// ========== GMAIL LOGIN ==========
app.post('/api/gmail-login', async (req, res) => {
    try {
        const { gmail, app_password } = req.body;

        // Validate inputs
        if (!gmail || typeof gmail !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'gmail is required'
            });
        }

        if (!app_password || typeof app_password !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'app_password is required'
            });
        }

        const gmailTrim = gmail.trim().toLowerCase();

        if (!gmailTrim.endsWith('@gmail.com')) {
            return res.status(400).json({
                success: false,
                error: 'Only Gmail accounts are supported'
            });
        }

        // Validate credentials
        const validation = await validateGmailCredentials(gmailTrim, app_password);

        if (!validation.success) {
            return res.status(401).json({
                success: false,
                error: validation.message
            });
        }

        // Generate API key
        const apiKey = generateAPIKey(gmailTrim);
        const cleanPassword = cleanAppPassword(app_password);

        // Store in database
        gmailDB[apiKey] = {
            gmail: gmailTrim,
            app_password: cleanPassword,
            logged_in_at: getUTCTimestamp(),
            last_check: null
        };

        return res.status(200).json({
            success: true,
            api_key: apiKey,
            gmail: gmailTrim,
            logged_in_at: gmailDB[apiKey].logged_in_at,
            message: 'Login successful! Save your API key securely.',
            usage: {
                verify_payment: `/api/verify-payment?api_key=${apiKey}&order_id=YOUR_ORDER_ID`,
                payment_history: `/api/payment-history?api_key=${apiKey}`,
                all_orders: `/api/orders?api_key=${apiKey}`
            }
        });

    } catch (error) {
        console.error('Gmail login error:', error);
        return res.status(500).json({
            success: false,
            error: 'Server error: ' + error.message
        });
    }
});

// ========== VERIFY PAYMENT ==========
app.get('/api/verify-payment', async (req, res) => {
    try {
        const { api_key, order_id } = req.query;

        // Validate inputs
        if (!api_key) {
            return res.status(400).json({
                success: false,
                error: 'api_key is required'
            });
        }

        if (!order_id) {
            return res.status(400).json({
                success: false,
                error: 'order_id is required'
            });
        }

        // Get Gmail credentials
        const account = gmailDB[api_key];
        if (!account) {
            return res.status(401).json({
                success: false,
                error: 'Invalid API key. Please login with /api/gmail-login first.'
            });
        }

        // Check if order exists
        const order = ordersDB[order_id];
        if (!order) {
            return res.status(404).json({
                success: false,
                error: `Order not found: ${order_id}`
            });
        }

        // If already paid, return cached data
        if (order.paid) {
            return res.status(200).json({
                success: true,
                payment_received: true,
                order_id: order_id,
                amount: order.amount,
                upi_id: order.upi_id,
                utr: order.utr,
                payer_name: order.payer_name,
                payer_upi: order.payer_upi,
                paid_at: order.paid_at,
                message: 'Payment already verified!'
            });
        }

        // Check Gmail for payment emails
        const payments = await checkGmailPayments(account.gmail, account.app_password, MAX_EMAIL_CHECK);

        // Find matching payment
        const matched = matchPaymentToOrder(payments, order.amount);

        if (matched) {
            // Update order as paid
            order.paid = true;
            order.paid_at = getUTCTimestamp();
            order.utr = matched.utr;
            order.payer_name = matched.payer_name;
            order.payer_upi = matched.payer_upi;

            // Update last check
            gmailDB[api_key].last_check = getUTCTimestamp();

            return res.status(200).json({
                success: true,
                payment_received: true,
                order_id: order_id,
                amount: order.amount,
                upi_id: order.upi_id,
                utr: matched.utr,
                payer_name: matched.payer_name,
                payer_upi: matched.payer_upi,
                paid_at: order.paid_at,
                message: 'Payment verified successfully!'
            });
        } else {
            // Update last check
            gmailDB[api_key].last_check = getUTCTimestamp();

            return res.status(200).json({
                success: true,
                payment_received: false,
                order_id: order_id,
                amount: order.amount,
                upi_id: order.upi_id,
                created_at: order.created_at,
                message: 'No payment found for this order. Please check again in a few minutes.',
                hint: 'Make sure the customer has completed payment and Fampay has sent email notification.'
            });
        }

    } catch (error) {
        console.error('Verify payment error:', error);
        return res.status(500).json({
            success: false,
            error: 'Server error: ' + error.message
        });
    }
});

// ========== PAYMENT HISTORY ==========
app.get('/api/payment-history', async (req, res) => {
    try {
        const { api_key, limit = 50 } = req.query;

        if (!api_key) {
            return res.status(400).json({
                success: false,
                error: 'api_key is required'
            });
        }

        const account = gmailDB[api_key];
        if (!account) {
            return res.status(401).json({
                success: false,
                error: 'Invalid API key'
            });
        }

        // Get payments from Gmail
        const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
        const payments = await checkGmailPayments(account.gmail, account.app_password, limitNum);

        // Get verified orders
        const verifiedOrders = [];
        for (const order of Object.values(ordersDB)) {
            if (order.paid && order.upi_id) {
                verifiedOrders.push({
                    order_id: order.order_id,
                    amount: order.amount,
                    utr: order.utr,
                    payer_name: order.payer_name,
                    paid_at: order.paid_at,
                    source: 'verified'
                });
            }
        }

        // Combine
        const allPayments = [...payments, ...verifiedOrders];

        return res.status(200).json({
            success: true,
            gmail: account.gmail,
            total_payments: allPayments.length,
            payments: allPayments.slice(0, limitNum),
            last_checked: getUTCTimestamp()
        });

    } catch (error) {
        console.error('Payment history error:', error);
        return res.status(500).json({
            success: false,
            error: 'Server error: ' + error.message
        });
    }
});

// ========== GET QR IMAGE ==========
app.get('/api/get-qr', async (req, res) => {
    try {
        const { order_id } = req.query;

        if (!order_id) {
            return res.status(400).json({
                success: false,
                error: 'order_id is required'
            });
        }

        const order = ordersDB[order_id];
        if (!order) {
            return res.status(404).json({
                success: false,
                error: `Order not found: ${order_id}`
            });
        }

        const qrBuffer = await generateQRCode(order.upi_id, order.amount, order.order_id);

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', `inline; filename="qr_${order_id}.png"`);
        res.send(qrBuffer);

    } catch (error) {
        console.error('Get QR error:', error);
        return res.status(500).json({
            success: false,
            error: 'Server error: ' + error.message
        });
    }
});

// ========== GET ALL ORDERS ==========
app.get('/api/orders', (req, res) => {
    try {
        const { api_key } = req.query;

        if (!api_key) {
            return res.status(400).json({
                success: false,
                error: 'api_key is required'
            });
        }

        const account = gmailDB[api_key];
        if (!account) {
            return res.status(401).json({
                success: false,
                error: 'Invalid API key'
            });
        }

        const ordersList = Object.values(ordersDB);

        return res.status(200).json({
            success: true,
            total_orders: ordersList.length,
            orders: ordersList
        });

    } catch (error) {
        console.error('Get orders error:', error);
        return res.status(500).json({
            success: false,
            error: 'Server error: ' + error.message
        });
    }
});

// ========== HEALTH CHECK ==========
app.get('/api/health', (req, res) => {
    const totalOrders = Object.keys(ordersDB).length;
    const paidOrders = Object.values(ordersDB).filter(o => o.paid).length;
    const gmailAccounts = Object.keys(gmailDB).length;

    return res.status(200).json({
        status: 'ok',
        message: 'Fampay API (Node.js) is running',
        timestamp: getUTCTimestamp(),
        stats: {
            total_orders: totalOrders,
            total_gmail_accounts: gmailAccounts,
            paid_orders: paidOrders
        }
    });
});

// ========== MARK PAID (TEST FEATURE) ==========
app.post('/api/mark-paid', (req, res) => {
    try {
        const { api_key, order_id, utr, payer_name, payer_upi } = req.body;

        if (!api_key || !order_id) {
            return res.status(400).json({
                success: false,
                error: 'api_key and order_id are required'
            });
        }

        const account = gmailDB[api_key];
        if (!account) {
            return res.status(401).json({
                success: false,
                error: 'Invalid API key'
            });
        }

        const order = ordersDB[order_id];
        if (!order) {
            return res.status(404).json({
                success: false,
                error: 'Order not found'
            });
        }

        order.paid = true;
        order.paid_at = getUTCTimestamp();
        order.utr = utr || `TEST_${uuidv4().slice(0, 8).toUpperCase()}`;
        order.payer_name = payer_name || 'Manual Payment';
        order.payer_upi = payer_upi;

        return res.status(200).json({
            success: true,
            message: 'Order marked as paid',
            order_id: order_id
        });

    } catch (error) {
        console.error('Mark paid error:', error);
        return res.status(500).json({
            success: false,
            error: 'Server error: ' + error.message
        });
    }
});

// ========== ERROR HANDLERS ==========
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// ========== START SERVER ==========
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
â•‘           FAMPAY UPI QR CODE API v1.0 (Node.js)            â•‘
â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£
â•‘  ðŸŒ Server: http://localhost:${PORT}                         â•‘
â•‘  ðŸ“– Docs:   http://localhost:${PORT}/                        â•‘
â•‘  â¤ï¸ Status: Running                                        â•‘
â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    `);
});

module.exports = app;
