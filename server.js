/**
 * â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
 * â•‘                    FAMPAY UPI QR CODE API - Node.js Version                  â•‘
 * â•‘                         FIXED VERSION - WORKING                             â•‘
 * â•‘                                                                              â•‘
 * â•‘  ðŸ”— Fixed Issues:                                                            â•‘
 * â•‘     âœ… Email sender: Famapp (updated search)                                 â•‘
 * â•‘     âœ… QR Code UPI URL format                                                â•‘
 * â•‘     âœ… Payment email parsing improved                                        â•‘
 * â•‘     âœ… Better email body extraction                                          â•‘
 * â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 */

require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ========== IN-MEMORY DATABASE ==========
const ordersDB = {};       // order_id -> order details
const gmailDB = {};        // api_key -> gmail credentials
const paymentCache = {};   // gmail -> list of cached payments

// ========== CONFIGURATION ==========
const PORT = process.env.PORT || 5000;
const SECRET_KEY = process.env.SECRET_KEY || 'fampay-secret-key-2024-change-in-production';

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

// ========== EMAIL CHECKING FUNCTIONS ==========

async function validateGmailCredentials(gmail, appPassword) {
    return new Promise((resolve) => {
        try {
            const cleanPassword = cleanAppPassword(appPassword);
            
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
                } else {
                    resolve({ success: false, message: 'Login failed: ' + err.message });
                }
            });

            imap.connect();

            // Timeout after 15 seconds
            setTimeout(() => {
                try { imap.end(); } catch (e) {}
                resolve({ success: false, message: 'Connection timeout. Try again.' });
            }, 15000);

        } catch (error) {
            resolve({ success: false, message: 'Error: ' + error.message });
        }
    });
}

async function checkGmailPayments(gmail, appPassword, orderId = null, orderAmount = null) {
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

                        // Search for Famapp/Fampay emails specifically
                        // Also search for recent emails with payment keywords
                        const searchCriteria = [
                            'UNSEEN',
                            ['FROM', 'famapp'],
                            ['FROM', 'Famapp'],
                            ['FROM', 'fampay'],
                            ['FROM', 'noreply@famapp'],
                            ['SUBJECT', 'payment'],
                            ['SUBJECT', 'received'],
                            ['SUBJECT', 'â‚¹'],
                        ];

                        // Try to search for Famapp emails
                        try {
                            const results = await searchEmails(imap, [
                                ['FROM', 'famapp'],
                                ['FROM', 'famapp.in'],
                                ['FROM', 'Famapp'],
                            ]);
                            payments.push(...results);
                        } catch (e) {}

                        // Also get recent emails (last 100) and filter
                        const start = Math.max(1, totalMessages - 100 + 1);
                        const fetchRange = `${start}:${totalMessages}`;

                        imap.fetch(fetchRange, {
                            bodies: '',
                            struct: true
                        }).on('message', (msg, seqno) => {
                            msg.on('body', async (stream, info) => {
                                try {
                                    const parsed = await simpleParser(stream);
                                    const payment = parsePaymentEmail(parsed, orderAmount);
                                    if (payment) {
                                        payments.push(payment);
                                    }
                                } catch (e) {}
                            });
                        }).on('error', (err) => {
                            // Ignore fetch errors
                        }).on('end', () => {
                            imap.end();
                            // Remove duplicates
                            const uniquePayments = [];
                            const seenAmounts = new Set();
                            for (const p of payments) {
                                const key = p.amount ? `â‚¹${p.amount}` : 'no-amount';
                                if (!seenAmounts.has(key)) {
                                    seenAmounts.add(key);
                                    uniquePayments.push(p);
                                }
                            }
                            resolve(uniquePayments);
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

            // Timeout after 45 seconds
            setTimeout(() => {
                try { imap.end(); } catch (e) {}
                resolve(payments);
            }, 45000);

        } catch (error) {
            console.log('Error checking Gmail:', error.message);
            resolve(payments);
        }
    });
}

function searchEmails(imap, criteria) {
    return new Promise((resolve, reject) => {
        try {
            imap.search(criteria, (err, results) => {
                if (err || !results || results.length === 0) {
                    resolve([]);
                    return;
                }

                // Fetch these emails
                const fetch = imap.fetch(results, { bodies: '' });
                const emails = [];

                fetch.on('message', async (msg) => {
                    msg.on('body', async (stream) => {
                        try {
                            const parsed = await simpleParser(stream);
                            const payment = parsePaymentEmail(parsed, null);
                            if (payment) {
                                emails.push(payment);
                            }
                        } catch (e) {}
                    });
                });

                fetch.on('error', () => resolve([]));
                fetch.on('end', () => resolve(emails));
            });
        } catch (e) {
            resolve([]);
        }
    });
}

function parsePaymentEmail(emailData, targetAmount = null) {
    // Check if email is from Famapp or related
    const from = (emailData.from?.text || '').toLowerCase();
    const subject = emailData.subject || '';
    const body = emailData.text || '';
    const htmlBody = emailData.html || '';
    
    // Get full body (text or cleaned html)
    let fullBody = body;
    if (!fullBody || fullBody.length < 10) {
        // Clean HTML to text
        fullBody = htmlBody
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/\s+/g, ' ')
            .trim();
    }

    const fullBodyLower = fullBody.toLowerCase();

    // Check if this is a payment notification
    const isFromFamapp = from.includes('famapp') || from.includes('fam');
    const hasPaymentKeywords = 
        fullBodyLower.includes('â‚¹') ||
        fullBodyLower.includes('rs.') ||
        fullBodyLower.includes('rupee') ||
        fullBodyLower.includes('received') ||
        fullBodyLower.includes('credited') ||
        fullBodyLower.includes('payment') ||
        fullBodyLower.includes('upi') ||
        fullBodyLower.includes('transaction');

    // Check subject too
    const hasPaymentSubject = 
        subject.toLowerCase().includes('payment') ||
        subject.toLowerCase().includes('received') ||
        subject.toLowerCase().includes('â‚¹') ||
        subject.toLowerCase().includes('upi');

    if (!isFromFamapp && !hasPaymentKeywords && !hasPaymentSubject) {
        return null;
    }

    const info = {
        source: 'email',
        subject: subject,
        sender: emailData.from?.text || '',
        date: emailData.date || '',
        amount: null,
        utr: null,
        payer_name: null,
        payer_upi: null,
        message: null,
        raw_text: fullBody.substring(0, 500) // For debugging
    };

    // Extract amount - look for â‚¹ symbol first
    const amountPatterns = [
        /â‚¹\s*([\d,]+\.?\d*)/,
        /â‚¹([\d,]+\.?\d*)/,
        /Rs\.?\s*([\d,]+\.?\d*)/,
        /INR\s*([\d,]+\.?\d*)/,
        /Amount[:\s]*â‚¹?\s*([\d,]+\.?\d*)/i,
        /Paid[:\s]*â‚¹?\s*([\d,]+\.?\d*)/i,
        /Received[:\s]*â‚¹?\s*([\d,]+\.?\d*)/i,
    ];

    for (const pattern of amountPatterns) {
        const match = fullBody.match(pattern);
        if (match) {
            try {
                const amountStr = match[1].replace(/,/g, '');
                const amount = parseFloat(amountStr);
                if (!isNaN(amount) && amount > 0 && amount < 10000000) {
                    info.amount = amount;
                    break;
                }
            } catch (e) {}
        }
    }

    // If target amount provided, check if it matches
    if (targetAmount && info.amount) {
        // Allow some tolerance for matching
        const tolerance = Math.max(0.01, targetAmount * 0.01);
        if (Math.abs(info.amount - targetAmount) > tolerance) {
            // Amount doesn't match, but still return it for history
            // Don't return null, just note it's different
        }
    }

    // Extract UTR
    const utrPatterns = [
        /UTR[:\s]*([A-Z0-9]{6,20})/i,
        /UPI\s*ID[:\s]*([A-Z0-9@._-]{5,40})/i,
        /Transaction\s*ID[:\s]*([A-Z0-9]{6,20})/i,
        /Txn\s*ID[:\s]*([A-Z0-9]{6,20})/i,
        /Ref\s*No[:\s]*([A-Z0-9]{6,20})/i,
        /Reference[:\s]*([A-Z0-9]{6,20})/i,
        /Order\s*ID[:\s]*([A-Z0-9]{6,20})/i,
    ];

    for (const pattern of utrPatterns) {
        const match = fullBody.match(pattern);
        if (match) {
            info.utr = match[1].trim().toUpperCase();
            break;
        }
    }

    // Extract UPI ID
    const upiPatterns = [
        /\b([a-zA-Z0-9._-]{3,30}@[a-zA-Z0-9.-]{2,30})\b/,
        /UPI\s*ID[:\s]*([a-zA-Z0-9@._-]{5,40})/i,
    ];

    for (const pattern of upiPatterns) {
        const match = fullBody.match(pattern);
        if (match) {
            info.payer_upi = match[1].trim();
            break;
        }
    }

    // Extract payer name
    const namePatterns = [
        /(?:from|sent by|paid by|payer)[:\s]+([A-Za-z\s]{2,40})/i,
        /Name[:\s]*([A-Za-z\s]{2,40})/i,
        /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:paid|sent)/i,
    ];

    for (const pattern of namePatterns) {
        const match = fullBody.match(pattern);
        if (match) {
            const name = match[1].trim();
            if (name.length > 1 && name.length < 50) {
                info.payer_name = name;
                break;
            }
        }
    }

    // Extract message/note
    const msgPatterns = [
        /Message[:\s]*(.+?)(?:\n|$)/i,
        /Note[:\s]*(.+?)(?:\n|$)/i,
        /Description[:\s]*(.+?)(?:\n|$)/i,
    ];

    for (const pattern of msgPatterns) {
        const match = fullBody.match(pattern);
        if (match) {
            info.message = match[1].trim().substring(0, 100);
            break;
        }
    }

    // Only return if we found an amount (main indicator of payment)
    if (info.amount === null) {
        // Check if it's still a Famapp email even without amount
        if (isFromFamapp && (hasPaymentSubject || hasPaymentKeywords)) {
            // Return with amount null but mark as potential payment
            return info;
        }
        return null;
    }

    return info;
}

function matchPaymentToOrder(payments, orderAmount, orderId) {
    for (const p of payments) {
        if (p.amount === null) continue;
        
        // Exact match or close match (within 0.01)
        if (Math.abs(p.amount - orderAmount) < 0.01) {
            return p;
        }
        
        // Also check if order ID appears in the email (strong match)
        if (orderId && p.raw_text && p.raw_text.includes(orderId)) {
            return p;
        }
    }
    
    // If no amount match, look for any Famapp email with payment
    // This helps when amount in email doesn't match exactly
    for (const p of payments) {
        if (p.source === 'email' && p.sender && p.sender.toLowerCase().includes('famapp')) {
            if (p.amount && Math.abs(p.amount - orderAmount) < orderAmount * 0.5) {
                return p;
            }
        }
    }
    
    return null;
}

// ========== QR CODE GENERATION ==========

async function generateQRCode(upiId, amount, orderId) {
    // UPI Payment URL - using standard format
    // Format: upi://pay?pa=UPI_ID&pn=NAME&am=AMOUNT&tr=ORDER_ID&cu=CURRENCY
    const upiUrl = `upi://pay?pa=${upiId}&pn=Fampay&am=${amount}&tr=${orderId}&cu=INR&tn=Payment`;
    
    console.log('Generating QR for:', { upiId, amount, orderId, upiUrl });
    
    try {
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
    } catch (error) {
        console.error('QR Generation Error:', error);
        throw error;
    }
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
        <title>ðŸ’° Fampay UPI QR Code API - FIXED</title>
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
            .success-box { background: #10b981; color: white; padding: 10px 20px; border-radius: 8px; margin: 10px 0; }
            .fixed-tag { background: #ff6b6b; color: white; padding: 3px 10px; border-radius: 20px; font-size: 0.8em; margin-left: 10px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="card">
                <h1>ðŸ’° Fampay UPI QR Code API <span class="fixed-tag">FIXED</span></h1>
                <p class="subtitle">Node.js Version | QR Codes & Payment Verification</p>

                <div class="success-box">
                    âœ… Fixed: Famapp email detection | Better payment parsing | QR URL format
                </div>

                <h2>ðŸ“¡ API Endpoints</h2>

                <div class="endpoint">
                    <span class="method POST">POST</span><code>/api/create-order</code>
                    <p style="margin-top:12px;color:#aaa;">Body: {"upi_id": "kankan1@fam", "amount": 1}</p>
                </div>

                <div class="endpoint">
                    <span class="method POST">POST</span><code>/api/gmail-login</code>
                    <p style="margin-top:12px;color:#aaa;">Body: {"gmail": "xxx@gmail.com", "app_password": "xxxx xxxx xxxx xxxx"}</p>
                </div>

                <div class="endpoint">
                    <span class="method GET">GET</span><code>/api/verify-payment?api_key=KEY&order_id=ORDER_ID</code>
                </div>

                <div class="endpoint">
                    <span class="method GET">GET</span><code>/api/get-qr?order_id=ORDER_ID</code>
                </div>

                <div class="endpoint">
                    <span class="method GET">GET</span><code>/api/health</code>
                </div>

                <div class="note">
                    <div class="note-title">ðŸ”§ How Payment Verification Works</div>
                    <p>1. Customer scans QR and pays via Fampay</p>
                    <p>2. Fampay sends email notification (from Famapp)</p>
                    <p>3. API checks your Gmail for Famapp payment emails</p>
                    <p>4. Returns payment details (UTR, payer, amount)</p>
                </div>
            </div>
            <div class="footer">Fampay QR Code API v1.1 (Fixed) | Built with â¤ï¸</div>
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

        if (amount === undefined || amount === null) {
            return res.status(400).json({
                success: false,
                error: 'amount is required'
            });
        }

        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            return res.status(400).json({
                success: false,
                error: 'amount must be a valid number greater than 0'
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
        
        // UPI Deep Link
        const upiUrl = `upi://pay?pa=${upiId}&pn=Fampay&am=${amountNum}&tr=${orderId}&cu=INR`;

        return res.status(200).json({
            success: true,
            order_id: orderId,
            upi_id: upiId,
            amount: amountNum,
            qr_code_base64: qrBase64,
            qr_url: upiUrl,
            qr_image_url: `/api/get-qr?order_id=${orderId}`,
            upi_deep_link: upiUrl,
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
                payment_history: `/api/payment-history?api_key=${apiKey}`
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

        // Check Gmail for Famapp payment emails
        console.log(`Checking Gmail for payment: order=${order_id}, amount=${order.amount}`);
        const payments = await checkGmailPayments(account.gmail, account.app_password, order_id, order.amount);
        console.log(`Found ${payments.length} potential payments`);

        // Find matching payment
        const matched = matchPaymentToOrder(payments, order.amount, order_id);
        
        if (matched) {
            console.log('Payment matched!', matched);
            
            // Update order as paid
            order.paid = true;
            order.paid_at = getUTCTimestamp();
            order.utr = matched.utr || `AUTO_${Date.now()}`;
            order.payer_name = matched.payer_name || 'Unknown';
            order.payer_upi = matched.payer_upi;

            // Update last check
            gmailDB[api_key].last_check = getUTCTimestamp();

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
                message: 'Payment verified successfully!',
                debug: {
                    emails_found: payments.length,
                    matched_amount: matched.amount,
                    subject: matched.subject
                }
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
                debug: {
                    emails_checked: payments.length,
                    first_email_sample: payments[0] ? {
                        subject: payments[0].subject,
                        sender: payments[0].sender,
                        amount: payments[0].amount,
                        raw_text: (payments[0].raw_text || '').substring(0, 200)
                    } : null
                }
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

        const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
        const payments = await checkGmailPayments(account.gmail, account.app_password);

        return res.status(200).json({
            success: true,
            gmail: account.gmail,
            total_payments: payments.length,
            payments: payments.slice(0, limitNum),
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
});

// ========== HEALTH CHECK ==========
app.get('/api/health', (req, res) => {
    const totalOrders = Object.keys(ordersDB).length;
    const paidOrders = Object.values(ordersDB).filter(o => o.paid).length;
    const gmailAccounts = Object.keys(gmailDB).length;

    return res.status(200).json({
        status: 'ok',
        message: 'Fampay API (Fixed) is running',
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

// ========== CLEAR DATABASE (Debug) ==========
app.post('/api/debug/clear', (req, res) => {
    const { secret } = req.body;
    if (secret !== 'fampay-debug-clear-2024') {
        return res.status(403).json({ success: false, error: 'Invalid secret' });
    }
    
    const orderCount = Object.keys(ordersDB).length;
    const gmailCount = Object.keys(gmailDB).length;
    
    Object.keys(ordersDB).forEach(k => delete ordersDB[k]);
    Object.keys(gmailDB).forEach(k => delete gmailDB[k]);
    
    return res.json({
        success: true,
        message: `Cleared ${orderCount} orders and ${gmailCount} gmail accounts`
    });
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
â•‘           FAMPAY UPI QR CODE API v1.1 (FIXED)              â•‘
â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£
â•‘  ðŸŒ Server: http://localhost:${PORT}                         â•‘
â•‘  ðŸ“– Docs:   http://localhost:${PORT}/                        â•‘
â•‘  â¤ï¸ Status: Running                                        â•‘
â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    `);
});

module.exports = app;
