/**
 * â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
 * â•‘                  FAMPAY API - Node.js Test Suite                             â•‘
 * â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 */

const http = require('http');
const fs = require('fs');

// Configuration
const BASE_URL = 'http://localhost:5000';

// Colors for terminal output
const colors = {
    GREEN: '\x1b[92m',
    RED: '\x1b[91m',
    YELLOW: '\x1b[93m',
    BLUE: '\x1b[94m',
    RESET: '\x1b[0m',
    BOLD: '\x1b[1m'
};

function logSuccess(msg) {
    console.log(`${colors.GREEN}âœ… ${msg}${colors.RESET}`);
}

function logError(msg) {
    console.log(`${colors.RED}âŒ ${msg}${colors.RESET}`);
}

function logInfo(msg) {
    console.log(`${colors.BLUE}â„¹ï¸  ${msg}${colors.RESET}`);
}

function logHeader(msg) {
    console.log(`\n${colors.BOLD}${'='.repeat(60)}`);
    console.log(`  ${msg}`);
    console.log(`${'='.repeat(60)}${colors.RESET}`);
}

// Make HTTP request helper
function httpRequest(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(BASE_URL + path);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: JSON.parse(data)
                    });
                } catch (e) {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: data,
                        raw: true
                    });
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// ========== TESTS ==========

async function testHealth() {
    logHeader('Test 1: Health Check');
    try {
        const resp = await httpRequest('GET', '/api/health');
        if (resp.status === 200 && resp.body.status === 'ok') {
            logSuccess(`Health Check Passed - Status: ${resp.body.status}`);
            logInfo(`Total Orders: ${resp.body.stats.total_orders}`);
            logInfo(`Gmail Accounts: ${resp.body.stats.total_gmail_accounts}`);
            return true;
        } else {
            logError(`Health check failed: ${JSON.stringify(resp.body)}`);
            return false;
        }
    } catch (e) {
        logError(`Connection failed: ${e.message}`);
        return false;
    }
}

async function testCreateOrder(upiId = 'kankan1@fam', amount = 1) {
    logHeader(`Test 2: Create Order (â‚¹${amount} to ${upiId})`);
    try {
        const resp = await httpRequest('POST', '/api/create-order', {
            upi_id: upiId,
            amount: amount
        });
        
        if (resp.status === 200 && resp.body.success) {
            logSuccess('Order Created Successfully!');
            logInfo(`Order ID: ${resp.body.order_id}`);
            logInfo(`Amount: â‚¹${resp.body.amount}`);
            logInfo(`QR Code (Base64): ${resp.body.qr_code_base64.length} chars`);
            
            if (resp.body.qr_code_base64.length > 100) {
                logSuccess('QR Code is valid');
            } else {
                logError('QR Code seems too short');
            }
            
            return resp.body.order_id;
        } else {
            logError(`Order creation failed: ${resp.body.error}`);
            return null;
        }
    } catch (e) {
        logError(`Error: ${e.message}`);
        return null;
    }
}

async function testValidation() {
    logHeader('Test 3: Input Validation');
    
    const testCases = [
        { payload: { upi_id: 'invalid', amount: 1 }, shouldFail: true, desc: 'Invalid UPI ID (no @)' },
        { payload: { upi_id: 'kankan1@fam', amount: 0 }, shouldFail: true, desc: 'Zero amount' },
        { payload: { upi_id: 'kankan1@fam', amount: -1 }, shouldFail: true, desc: 'Negative amount' },
        { payload: { upi_id: 'kankan1@fam' }, shouldFail: true, desc: 'Missing amount' },
        { payload: { amount: 1 }, shouldFail: true, desc: 'Missing UPI ID' },
        { payload: { upi_id: 'kankan1@fam', amount: 100001 }, shouldFail: true, desc: 'Amount too high' },
        { payload: { upi_id: 'kankan1@fam', amount: 50.50 }, shouldFail: false, desc: 'Valid decimal amount' },
    ];
    
    let allPassed = true;
    
    for (const tc of testCases) {
        try {
            const resp = await httpRequest('POST', '/api/create-order', tc.payload);
            const failed = !resp.body.success;
            
            if ((tc.shouldFail && failed) || (!tc.shouldFail && !failed)) {
                logSuccess(`âœ“ Validation working: ${tc.desc}`);
            } else {
                logError(`âœ— Unexpected result: ${tc.desc}`);
                console.log(`  Expected fail: ${tc.shouldFail}, Got fail: ${failed}`);
                console.log(`  Response: ${JSON.stringify(resp.body)}`);
                allPassed = false;
            }
        } catch (e) {
            logError(`Error testing ${tc.desc}: ${e.message}`);
            allPassed = false;
        }
    }
    
    return allPassed;
}

async function testGetQR(orderId) {
    logHeader('Test 4: Get QR Image');
    
    if (!orderId) {
        logError('No order_id provided');
        return false;
    }
    
    try {
        const resp = await httpRequest('GET', `/api/get-qr?order_id=${orderId}`);
        
        if (resp.status === 200) {
            const contentType = resp.headers['content-type'] || '';
            if (contentType.includes('image/png')) {
                logSuccess('QR Image retrieved successfully');
                logInfo(`Content-Type: ${contentType}`);
                // Check if it's actually a PNG (starts with PNG signature)
                if (resp.body.raw && resp.body.raw.startsWith('\x89PNG')) {
                    logInfo('Valid PNG file detected');
                }
                return true;
            } else {
                logError(`Wrong content type: ${contentType}`);
                return false;
            }
        } else {
            logError(`Failed to get QR: Status ${resp.status}`);
            return false;
        }
    } catch (e) {
        logError(`Error: ${e.message}`);
        return false;
    }
}

async function testInvalidQR() {
    logHeader('Test 5: QR for Invalid Order');
    
    try {
        const resp = await httpRequest('GET', '/api/get-qr?order_id=INVALID_123');
        
        if (resp.status === 404 && !resp.body.success) {
            logSuccess('Invalid order correctly rejected');
            return true;
        } else {
            logError(`Should return 404, got ${resp.status}`);
            return false;
        }
    } catch (e) {
        logError(`Error: ${e.message}`);
        return false;
    }
}

async function testGmailLoginValidation() {
    logHeader('Test 6: Gmail Login Validation');
    
    const testCases = [
        { payload: { gmail: 'notgmail.com', app_password: 'xxxx' }, shouldFail: true, desc: 'Non-Gmail address' },
        { payload: { gmail: '', app_password: 'xxxx' }, shouldFail: true, desc: 'Empty Gmail' },
        { payload: { app_password: 'xxxx' }, shouldFail: true, desc: 'Missing Gmail' },
        { payload: { gmail: 'test@gmail.com' }, shouldFail: true, desc: 'Missing password' },
    ];
    
    let allPassed = true;
    
    for (const tc of testCases) {
        try {
            const resp = await httpRequest('POST', '/api/gmail-login', tc.payload);
            const failed = !resp.body.success;
            
            if (tc.shouldFail && failed) {
                logSuccess(`âœ“ Validation working: ${tc.desc}`);
            } else {
                logError(`âœ— ${tc.desc} - should fail`);
                console.log(`  Response: ${JSON.stringify(resp.body)}`);
                allPassed = false;
            }
        } catch (e) {
            logError(`Error testing ${tc.desc}: ${e.message}`);
            allPassed = false;
        }
    }
    
    logInfo('Note: Actual Gmail login requires valid credentials');
    return allPassed;
}

async function testVerifyPayment() {
    logHeader('Test 7: Verify Payment (Invalid API Key)');
    
    try {
        const resp = await httpRequest('GET', '/api/verify-payment?api_key=invalid_key&order_id=ORD_TEST');
        
        if (resp.status === 401 && !resp.body.success) {
            logSuccess('Invalid API key correctly rejected');
            return true;
        } else {
            logError(`Should return 401, got ${resp.status}`);
            return false;
        }
    } catch (e) {
        logError(`Error: ${e.message}`);
        return false;
    }
}

async function testOrdersList() {
    logHeader('Test 8: Orders List');
    
    try {
        const resp = await httpRequest('GET', '/api/orders?api_key=invalid');
        
        if (resp.status === 401 && !resp.body.success) {
            logSuccess('Orders requires valid API key');
            return true;
        } else {
            logError(`Should return 401, got ${resp.status}`);
            return false;
        }
    } catch (e) {
        logError(`Error: ${e.message}`);
        return false;
    }
}

// ========== RUN ALL TESTS ==========

async function runAllTests() {
    console.log(`
${colors.BOLD}
â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
â•‘              FAMPAY API (Node.js) - TEST SUITE                  â•‘
â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£
â•‘  Testing: ${BASE_URL}
â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
${colors.RESET}
    `);
    
    const results = [];
    
    // Test 1: Health check
    results.push(['Health Check', await testHealth()]);
    
    // Test 2: Create order
    const orderId = await testCreateOrder();
    results.push(['Create Order', orderId !== null]);
    
    // Test 3: Validation
    results.push(['Input Validation', await testValidation()]);
    
    // Test 4: Get QR image
    if (orderId) {
        results.push(['Get QR Image', await testGetQR(orderId)]);
    }
    
    // Test 5: Invalid QR
    results.push(['QR Invalid Order', await testInvalidQR()]);
    
    // Test 6: Gmail login validation
    results.push(['Gmail Login Validation', await testGmailLoginValidation()]);
    
    // Test 7: Verify payment
    results.push(['Verify Payment', await testVerifyPayment()]);
    
    // Test 8: Orders list
    results.push(['Orders List', await testOrdersList()]);
    
    // Summary
    logHeader('TEST SUMMARY');
    const passed = results.filter(([_, r]) => r).length;
    const total = results.length;
    
    for (const [name, result] of results) {
        const status = result 
            ? `${colors.GREEN}PASS${colors.RESET}` 
            : `${colors.RED}FAIL${colors.RESET}`;
        console.log(`  ${name}: ${status}`);
    }
    
    console.log(`\n${colors.BOLD}Total: ${passed}/${total} tests passed${colors.RESET}`);
    
    if (passed === total) {
        logSuccess('All tests passed! âœ…');
        process.exit(0);
    } else {
        logError(`${total - passed} test(s) failed`);
        process.exit(1);
    }
}

// Run tests
runAllTests().catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
});
