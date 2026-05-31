# ðŸ’° Fampay UPI QR Code API - Node.js Version

> Complete Node.js solution for generating UPI QR codes and verifying Fampay payments via Gmail integration

![Node](https://img.shields.io/badge/Node.js-18+-green)
![Express](https://img.shields.io/badge/Express-4.18+-grey)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## ðŸš€ Quick Start

### Install & Run

```bash
# Install dependencies
npm install

# Run the server
npm start

# Open in browser
# http://localhost:5000
```

### Run Tests

```bash
npm test
# or
node test.js
```

---

## ðŸ“¡ API Endpoints

### 1ï¸âƒ£ Create Order (Generate QR Code)

```bash
POST /api/create-order
Content-Type: application/json

{
  "upi_id": "kankan1@fam",
  "amount": 1
}
```

**Response:**
```json
{
  "success": true,
  "order_id": "ORD_789A57CA01B7",
  "upi_id": "kankan1@fam",
  "amount": 1,
  "qr_code_base64": "iVBORw0KGgo...",
  "qr_url": "upi://pay?pa=kankan1@fam&am=1&tr=ORD_...",
  "qr_image_url": "/api/get-qr?order_id=ORD_...",
  "created_at": "2026-05-31T11:58:11.101Z"
}
```

---

### 2ï¸âƒ£ Gmail Login (Get API Key)

```bash
POST /api/gmail-login
Content-Type: application/json

{
  "gmail": "yourmail@gmail.com",
  "app_password": "xxxx xxxx xxxx xxxx"
}
```

**âš ï¸ How to Generate App Password:**

1. Go to [myaccount.google.com â†’ Security](https://myaccount.google.com/security)
2. Enable **2-Step Verification**
3. Go to **App Passwords** â†’ Generate
4. Select app: `Mail`, Device: `Other`
5. Copy the **16-character password**
6. Enable IMAP in Gmail Settings

**Response:**
```json
{
  "success": true,
  "api_key": "k4j8h2m5n7p9q1r3s5t7u9v0w2x4y6z8",
  "gmail": "yourmail@gmail.com",
  "message": "Login successful!"
}
```

---

### 3ï¸âƒ£ Verify Payment

```bash
GET /api/verify-payment?api_key=YOUR_API_KEY&order_id=ORDER_ID
```

**Response:**
```json
{
  "success": true,
  "payment_received": true,
  "amount": 1,
  "utr": "ABC123456789",
  "payer_name": "John Doe",
  "payer_upi": "john@upi",
  "paid_at": "2026-05-31T12:00:00Z"
}
```

---

### 4ï¸âƒ£ Payment History

```bash
GET /api/payment-history?api_key=YOUR_API_KEY&limit=50
```

---

### 5ï¸âƒ£ Get QR Image

```bash
GET /api/get-qr?order_id=ORDER_ID
```

Returns PNG image directly.

---

### 6ï¸âƒ£ Health Check

```bash
GET /api/health
```

---

## ðŸ’¡ Complete Example (cURL)

```bash
# 1. Create order
curl -X POST http://localhost:5000/api/create-order \
  -H "Content-Type: application/json" \
  -d '{"upi_id": "kankan1@fam", "amount": 100}'

# 2. Login with Gmail
curl -X POST http://localhost:5000/api/gmail-login \
  -H "Content-Type: application/json" \
  -d '{"gmail": "your@gmail.com", "app_password": "xxxx xxxx xxxx xxxx"}'

# 3. Verify payment
curl "http://localhost:5000/api/verify-payment?api_key=YOUR_KEY&order_id=YOUR_ORDER"
```

---

## ðŸ“¦ Project Structure

```
fampay-api/
â”œâ”€â”€ server.js          # Main Express application
â”œâ”€â”€ package.json       # Dependencies and scripts
â”œâ”€â”€ test.js            # Test suite
â”œâ”€â”€ .env.example       # Environment variables
â””â”€â”€ README_NODE.md     # This documentation
```

---

## ðŸ§ª Test Results: 8/8 PASSED âœ…

```
âœ… Health Check
âœ… Create Order (â‚¹1 to kankan1@fam)
âœ… Input Validation (all edge cases)
âœ… Get QR Image (PNG, correct content-type)
âœ… QR for Invalid Order (404)
âœ… Gmail Login Validation
âœ… Verify Payment (API key check)
âœ… Orders List (requires valid API key)
```

---

## ðŸ³ Deploy on Render.com

### Option 1: Use render.yaml

Create `render.yaml`:
```yaml
services:
  - type: web
    name: fampay-api-node
    env: node
    buildCommand: npm install
    startCommand: npm start
    plan: free
```

### Option 2: Manual Deploy

1. Push to GitHub
2. Go to render.com â†’ **Web Services** â†’ **New**
3. Connect repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Deploy!

---

## ðŸ”§ Configuration

Create `.env` file:
```env
PORT=5000
SECRET_KEY=your-secret-key-change-this
```

---

## âš ï¸ Important Notes

1. **IMAP Must Be Enabled** in Gmail Settings
2. **App Password Required** (not regular password)
3. **2-Factor Auth** must be enabled before generating App Password
4. **Wait 1-2 minutes** after payment for email notification
5. **API Key Security** - keep it secret!

---

## ðŸ“„ License

MIT License
