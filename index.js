const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const crypto = require('crypto');
const mysql = require('mysql2/promise');

// Database pool (initialized in init)
let pool;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database: create pool and ensure table exists, with retry logic
async function initDb() {
	const host = process.env.DB_HOST || 'localhost';
	const user = process.env.DB_USER || 'root';
	const password = process.env.DB_PASS || 'Bumi12345+';
	const dbName = process.env.DB_NAME || 'api';
	const port = parseInt(process.env.DB_PORT || '3307', 10);

	const maxAttempts = parseInt(process.env.DB_RETRY_ATTEMPTS || '10', 10);
	const retryDelay = parseInt(process.env.DB_RETRY_DELAY || '1000', 10); // ms

	let attempt = 0;

	while (true) {
		attempt++;
		try {
			console.log(`DB init attempt ${attempt} -> ${host}:${port} (db=${dbName})`);

			// First ensure the database exists (connect without database)
			const tmpConn = await mysql.createConnection({ host, user, password, port, connectTimeout: 5000 });
			await tmpConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
			await tmpConn.end();

			// create pool with the database
			pool = mysql.createPool({ host, user, password, database: dbName, port, waitForConnections: true, connectionLimit: 10, queueLimit: 0 });

			// Create database table if it doesn't exist
			await pool.query(`
				CREATE TABLE IF NOT EXISTS api_keys (
					id INT AUTO_INCREMENT PRIMARY KEY,
					username VARCHAR(191) NOT NULL,
					name VARCHAR(191) DEFAULT '',
					\`key\` VARCHAR(255) NOT NULL,
					createdAt DATETIME NOT NULL
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
			`);

			console.log('DB initialized successfully');
			return;
		} catch (err) {
			console.error(`DB init attempt ${attempt} failed:`, err && err.code ? err.code : err.message || err);
			if (attempt >= maxAttempts) {
				throw err;
			}
			// wait then retry
			await new Promise(resolve => setTimeout(resolve, retryDelay));
		}
	}
}

// POST endpoint to create an API key (generates a random token) and save to DB
app.post('/api/apikey', async (req, res) => {
	const { username, name } = req.body || {};

	if (!username) {
		return res.status(400).json({ success: false, error: 'username is required' });
	}

	const token = crypto.randomBytes(24).toString('hex');
	const createdAt = new Date();

	try {
		const [result] = await pool.execute(
			'INSERT INTO api_keys (username, name, `key`, createdAt) VALUES (?,?,?,?)',
			[ String(username), name ? String(name) : '', token, createdAt ]
		);

		// fetch the inserted row
		const [rows] = await pool.query('SELECT id, username, name, `key`, createdAt FROM api_keys WHERE id = ?', [result.insertId]);
		return res.status(201).json({ success: true, data: rows[0] });
	} catch (err) {
		console.error('DB insert error', err);
		return res.status(500).json({ success: false, error: 'database error' });
	}
});

// GET endpoint to list API keys (show full keys)
app.get('/api/apikey', async (req, res) => {
	try {
		const [rows] = await pool.query('SELECT id, username, name, `key`, createdAt FROM api_keys ORDER BY id DESC');
		res.json({ success: true, data: rows });
	} catch (err) {
		console.error('DB select error', err);
		res.status(500).json({ success: false, error: 'database error' });
	}
});

// Fallback route
app.use((req, res) => {
	res.status(404).send('Not found');
});

// Initialize DB and start server
initDb()
	.then(() => {
		app.listen(PORT, () => {
			console.log(`Server listening on http://localhost:${PORT}`);
		});
	})
	.catch(err => {
		console.error('Failed to initialize DB', err);
		process.exit(1);
	});

