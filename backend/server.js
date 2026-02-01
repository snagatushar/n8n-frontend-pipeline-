const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

// Load env
const envPathFrontend = path.resolve(__dirname, '../Fend-processing/.env');
if (fs.existsSync(envPathFrontend)) {
    console.log(`Loading .env from ${envPathFrontend}`);
    require('dotenv').config({ path: envPathFrontend });
} else {
    require('dotenv').config();
}

const app = express();
const PORT = process.env.PORT || 5000;

// Security Middleware
app.use(helmet());

// Middleware to strip /api prefix for Vercel
app.use((req, res, next) => {
  if (req.url.startsWith('/api')) {
    req.url = req.url.replace('/api', '') || '/';
  }
  next();
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Disable caching for API routes to ensure fresh data
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

app.use('/invoices/files', express.static(path.join(__dirname, 'public/invoices')));

const pdfDir = path.join(__dirname, 'public/invoices');
if (!fs.existsSync(pdfDir)) {
    fs.mkdirSync(pdfDir, { recursive: true });
}

const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false
});

// Helper: Convert CSV string to Array (for Frontend)
// Handles null/undefined -> []
const csvToArray = (str) => {
    if (!str) return [];
    return String(str).split(',');
};

// Helper: Convert Array to CSV string (for DB)
// Handles array -> join(',')
// Handles string -> as is
const arrayToCsv = (val) => {
    if (Array.isArray(val)) return val.join(',');
    if (!val) return "";
    // If it's already a JSON string array (from App.js legacy logic), parse then join?
    // App.js sends JSON.stringify([...]).
    // So if val is '[ "a", "b" ]', we need to parse it first.
    try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) return parsed.join(',');
    } catch (e) {
        // Not JSON, return as string
    }
    return String(val);
};

// Initialize Table
pool.connect(async (err, client, release) => {
    if (err) return console.error('Error acquiring client', err.stack);
    console.log('Connected to Postgres');

    // We are using the existing table 'client_smd.backend' provided by the user.
    // No need to create table.
    
    // Just verify connection is good
    try {
        await client.query('SELECT 1');
        console.log("Verified connection to DB.");
    } catch (e) {
        console.error("Error verifying connection:", e);
    } finally {
        release();
    }
});

// --- Webhook System ---
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const sendWebhook = async (invoice) => {
    if (!WEBHOOK_URL) {
        // Only log once or if explicitly needed, to avoid spamming logs if not configured
        return false;
    }

    try {
        // Read PDF file to send as Base64 (Robustness for Localhost -> Cloud)
        let pdfBase64 = null;
        if (invoice.pdf_url) {
            try {
                const filename = invoice.pdf_url.split('/').pop();
                const filePath = path.join(pdfDir, filename);
                if (fs.existsSync(filePath)) {
                    pdfBase64 = fs.readFileSync(filePath, { encoding: 'base64' });
                }
            } catch (fileErr) {
                console.warn(`⚠️ Could not read PDF file for invoice ${invoice.id}:`, fileErr.message);
            }
        }

        console.log(`🚀 Sending webhook for invoice ${invoice.id}...`);
        await axios.post(WEBHOOK_URL, {
            event: 'invoice_approved',
            invoice_id: invoice.id,
            phone: invoice.phonenumber,
            pdf_url: invoice.pdf_url,
            pdf_base64: pdfBase64, // Allows n8n to use file content directly
            total: invoice.total,
            dealer: invoice.dealer,
            timestamp: new Date().toISOString()
        });

        await pool.query(
            `UPDATE client_smd.backend SET webhook_status = 'SENT' WHERE id = $1`,
            [invoice.id]
        );
        console.log(`✅ Webhook sent successfully for ${invoice.id}`);
        return true;
    } catch (err) {
        console.error(`❌ Webhook failed for ${invoice.id}:`, err.message);
        await pool.query(
            `UPDATE client_smd.backend SET webhook_status = 'FAILED', webhook_attempts = COALESCE(webhook_attempts, 0) + 1 WHERE id = $1`,
            [invoice.id]
        );
        return false;
    }
};

// Retry Job: Runs every 60 seconds
// Retries invoices that are APPROVED but webhook failed or is pending
setInterval(async () => {
    try {
        if (!WEBHOOK_URL) return;

        const result = await pool.query(`
            SELECT * FROM client_smd.backend 
            WHERE status = 'APPROVED' 
            AND (webhook_status = 'FAILED' OR webhook_status = 'PENDING')
            AND (webhook_attempts IS NULL OR webhook_attempts < 10)
            LIMIT 10
        `);

        if (result.rows.length > 0) {
            console.log(`🔄 Retrying webhooks for ${result.rows.length} invoices...`);
            for (const invoice of result.rows) {
                await sendWebhook(invoice);
            }
        }
    } catch (e) {
        console.error('Webhook retry job error:', e);
    }
}, 60 * 1000); 

// Routes

// 1. Create Invoice (Webhook/n8n)
app.post('/invoices', async (req, res) => {
    const data = req.body;
    
    // Generate UUID if not provided
    const id = data.id || data.uuid || crypto.randomUUID();
    
    // Basic validation
    if (!data.phonenumber) {
        return res.status(400).json({ error: 'phonenumber is required' });
    }

    // Convert Arrays to CSV Strings
    const productname = arrayToCsv(data.productname);
    const description = arrayToCsv(data.description);
    const quantity = arrayToCsv(data.quantity);
    const units = arrayToCsv(data.units);
    const rate = arrayToCsv(data.rate);

    const query = `
        INSERT INTO client_smd.backend (
            id, phonenumber, dealer, invoice_number, invoice_date, 
            productname, description, quantity, units, rate, 
            amount, total, status, gstin
        ) VALUES (
            $1, $2, $3, $4, $5, 
            $6, $7, $8, $9, $10, 
            $11, $12, $13, $14
        ) RETURNING *
    `;

    const values = [
        id,
        data.phonenumber,
        data.Dealer || data.dealer || '',
        data.invoice_number || '',
        data.invoice_date || '',
        productname,
        description,
        quantity,
        units,
        rate,
        data.amount || 0,
        data.total || 0,
        data.status || 'created',
        data.gstin || ''
    ];

    try {
        const result = await pool.query(query, values);
        const row = result.rows[0];
        
        // Return structured data with absolute link for n8n convenience
        const protocol = req.protocol;
        const host = req.get('host');
        // Note: Frontend URL might be different from Backend URL. 
        // Assuming Frontend is on port 3000 for now, or user can configure.
        // But here we return the identifiers so n8n can construct the link.
        
        const responseData = {
            ...row,
            uuid: row.id,
            link: `${protocol}://${host.replace('5000', '3000')}/${row.id}/${row.phonenumber}`
        };
        
        res.status(201).json(responseData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Creation failed' });
    }
});

// 2. Get Pending Invoices
// Returns pending invoices for a specific phone number (Privacy: One person cannot see others)
app.get('/invoices/pending', async (req, res) => {
    const { phone } = req.query;
    if (!phone) {
        // If no phone provided, return empty list to protect privacy
        return res.json([]);
    }
    try {
        const result = await pool.query(`
            SELECT id as uuid, phonenumber, dealer as "Dealer" 
            FROM client_smd.backend 
            WHERE (status != 'APPROVED' OR status IS NULL) AND phonenumber = $1
            ORDER BY created_at DESC
        `, [phone]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. Get Invoice by ID and Phone
app.get('/invoices/:id/:phone', async (req, res) => {
    const { id, phone } = req.params;
    try {
        const result = await pool.query(
            'SELECT * FROM client_smd.backend WHERE id = $1 AND phonenumber = $2', 
            [id, phone]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }
        
        const row = result.rows[0];
        
        // Transform for Frontend (Arrays)
        // Frontend expects: productname: ["A", "B"] (or JSON string of array if legacy)
        // App.js uses safeParse which handles JSON string or Array.
        // Let's send Array.
        const responseData = {
            ...row,
            uuid: row.id, // For compatibility
            Dealer: row.dealer, // For compatibility
            productname: csvToArray(row.productname),
            description: csvToArray(row.description),
            quantity: csvToArray(row.quantity),
            units: csvToArray(row.units),
            rate: csvToArray(row.rate)
        };
        
        res.json(responseData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 3. Update Invoice
app.put('/invoices/:id/:phone', async (req, res) => {
    const { id, phone } = req.params;
    const data = req.body;

    console.log(`[PUT] Update request for ID: ${id}, Phone: ${phone}`);
    console.log(`[PUT] Payload:`, JSON.stringify(data, null, 2));

    // Convert Arrays to CSV Strings
    const productname = arrayToCsv(data.productname);
    const description = arrayToCsv(data.description);
    const quantity = arrayToCsv(data.quantity);
    const units = arrayToCsv(data.units);
    const rate = arrayToCsv(data.rate);

    const query = `
        UPDATE client_smd.backend SET
            invoice_number = $1,
            dealer = $2,
            invoice_date = $3,
            productname = $4,
            description = $5,
            quantity = $6,
            units = $7,
            rate = $8,
            amount = $9,
            total = $10,
            status = $11,
            gstin = $12,
            phonenumber = $15
        WHERE id = $13 AND phonenumber = $14
        RETURNING *
    `;
    
    const values = [
        data.invoice_number,
        data.Dealer || data.dealer, // Handle both casing
        data.invoice_date,
        productname,
        description,
        quantity,
        units,
        rate,
        data.amount,
        data.total,
        data.status,
        data.gstin || "",
        id,
        phone,
        data.phonenumber || phone
    ];

    try {
        const result = await pool.query(query, values);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Invoice not found' });
        }
        
        const row = result.rows[0];
        const responseData = {
            ...row,
            uuid: row.id,
            Dealer: row.dealer,
            productname: csvToArray(row.productname),
            description: csvToArray(row.description),
            quantity: csvToArray(row.quantity),
            units: csvToArray(row.units),
            rate: csvToArray(row.rate)
        };

        res.json(responseData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Update failed' });
    }
});

// 4. Approve Invoice
app.post('/invoices/:id/:phone/approve', async (req, res) => {
    const { id, phone } = req.params;
    const { pdfBase64, total } = req.body;
    
    if (!pdfBase64) return res.status(400).json({ error: 'Missing PDF data' });

    try {
        // Only try to write file if not in serverless environment (optional check)
        // In Vercel, /tmp is the only writable place, but we don't really need to save the file
        // if we are just generating the URL. 
        // However, the original logic relies on serving the file via static folder.
        // On Vercel, this won't work well for persistent storage. 
        // Ideally, upload to S3/Blob storage.
        // For now, we will skip file writing if in production/vercel to avoid errors, 
        // OR write to /tmp.
        
        let filename = `invoice_${phone}_${id}_${Date.now()}.pdf`;
        let pdfUrl = "";

        // Check if running in Vercel
        if (process.env.VERCEL) {
             // In Vercel, we can't store files persistently. 
             // We will assume the frontend generates the PDF and n8n handles it.
             // We can return a dummy URL or construct one if we had S3.
             // For this specific use case (n8n), we are sending the Base64 directly!
             // So the URL is less critical for the n8n part, but maybe critical for the user to "view" it later.
             // Without S3, the "view later" feature will break on Vercel.
             // We'll warn the user about this.
             pdfUrl = `https://placeholder-storage.com/${filename}`; // Placeholder
        } else {
             const buffer = Buffer.from(pdfBase64, 'base64');
             const filepath = path.join(pdfDir, filename);
             fs.writeFileSync(filepath, buffer);
             const protocol = req.protocol;
             const host = req.get('host');
             pdfUrl = `${protocol}://${host}/invoices/files/${filename}`;
        }
        
        const result = await pool.query(`
            UPDATE client_smd.backend SET
                status = 'APPROVED',
                total = $1,
                pdf_url = $2,
                webhook_status = 'PENDING',
                webhook_attempts = 0
            WHERE id = $3 AND phonenumber = $4
            RETURNING *
        `, [total, pdfUrl, id, phone]);
        
        const row = result.rows[0];

        // Trigger webhook immediately (async, don't block response)
        // If it fails, the background job will pick it up
        if (WEBHOOK_URL) {
            sendWebhook(row).catch(e => console.error("Immediate webhook trigger error:", e));
        } else {
            console.log("ℹ️ No WEBHOOK_URL configured, skipping webhook.");
        }

        // Send back formatted data just in case
        res.json({ ...row, uuid: row.id, Dealer: row.dealer });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Approval failed' });
    }
});

// Export for Vercel
module.exports = app;

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}
