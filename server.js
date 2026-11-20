require('dotenv').config();

const app = require('./src/app');
const pool = require('./src/config/db');

const PORT = process.env.PORT || 3000;

async function start() {
    try {
        await pool.query('SELECT COUNT(*) FROM users');
        console.log('PostgreSQL connected');

        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('PostgreSQL connection failed:', error.message);
        process.exit(1);
    }
}

start();