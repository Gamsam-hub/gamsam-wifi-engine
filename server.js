const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { exec } = require('child_process'); // For automated Router SSH control
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// In-memory cluster storage to handle transactional pipeline tracking safely
let sessionRegistry = {};

// 1. Endpoint to initiate the mobile money prompt request
app.post('/pay', async (req, res) => {
    const { phone, amount, business } = req.body;
    
    let network = "MTN";
    if (phone.startsWith("25670") || phone.startsWith("25675") || phone.startsWith("25673") || phone.startsWith("25674")){
        network = "AIRTEL";
    }

    // Dynamic reference tracks which client business owns the transaction
    const tx_ref = `GAMSAM-${business ? business.toUpperCase() : 'HOTSPOT'}-${Date.now()}`;

    const payload = {
        "amount": amount,
        "currency": "UGX",
        "phone_number": phone,
        "network": network,
        "email": "billing@gamsamtechnologies.com",
        "tx_ref": tx_ref,
        "order_id": "WIFI-" + Date.now(),
        "fullname": "Wi-Fi Subscriber"
    };

    try {
        const response = await axios.post(
            'https://flutterwave.com', 
            payload,
            { headers: { 'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`, 'Content-Type': 'application/json' } }
        );

        // Track state securely inside server memory
        sessionRegistry[tx_ref] = {
            status: 'pending',
            voucher: null,
            phone: phone,
            amount: amount,
            limitBytes: amount === "1000" ? "2147483648" : "0" // Example: 2GB limit for 1000, unlimited for others
        };

        return res.status(200).json({ status: 'success', tx_ref: tx_ref });
    } catch (error) {
        return res.status(500).json({ status: 'error', message: "Gateway connection dropped." });
    }
});

// 2. PRODUCTION WEBHOOK RECEIVER (Fires ONLY when customer enters true PIN code)
app.post('/webhook', (req, res) => {
    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers['verif-hash'];
    
    if (!signature || signature !== secretHash) {
        return res.status(401).end(); // Discard unverified fake simulation requests
    }

    const payload = req.body;
    if (payload.status === 'successful' && payload.currency === 'UGX') {
        const referenceKey = payload.tx_ref;
        
        if (sessionRegistry[referenceKey] && sessionRegistry[referenceKey].status === 'pending') {
            
            // 1. Generate a real 6-digit numeric voucher code securely on the server
            const numericToken = Math.floor(100000 + Math.random() * 900000); 
            const finalVoucherCode = `GSM-${numericToken}`;

            // 2. Update tracking session parameters
            sessionRegistry[referenceKey].status = 'paid';
            sessionRegistry[referenceKey].voucher = finalVoucherCode;
            
            console.log(`[PAID SUCCESS] Payment verified for ${referenceKey}. Code created: ${finalVoucherCode}`);
            
            // 3. MIKROTIK ROUTER AUTOMATION INTEGRATION
            // Automatically add the user voucher directly into the Mikrotik Hotspot user database via SSH
            const targetPhone = sessionRegistry[referenceKey].phone;
            const dataLimit = sessionRegistry[referenceKey].limitBytes;
            
            // Script dynamically injects user credentials into Mikrotik RouterOS
            const routerCommand = `ssh -i /path/to/router_key admin@client_router_ip "/ip hotspot user add name=${finalVoucherCode} password=${finalVoucherCode} comment=${targetPhone} limit-bytes=${dataLimit}"`;
            
            exec(routerCommand, (error, stdout, stderr) => {
                if (error) {
                    console.error(`[ROUTER ERROR] Could not register user on client Mikrotik: ${error.message}`);
                    return;
                }
                console.log(`[ROUTER SUCCESS] Active profile pushed to Mikrotik memory.`);
            });
        }
    }
    res.status(200).end();
});

// 3. Status long-polling endpoint for frontend tracking interface
app.get('/check-status/:tx_ref', (req, res) => {
    const transactionRecord = sessionRegistry[req.params.tx_ref];
    if (transactionRecord) {
        return res.status(200).json(transactionRecord);
    }
    return res.status(404).json({ status: 'not_found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`System Core functioning smoothly on port ${PORT}`));
