const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });

const pool = require('../src/config/db');

test('connects to the musfest_test database', async () => {
    const result = await pool.query('SELECT current_database() AS name');

    expect(result.rows[0].name).toBe('musfest_test');
});

afterAll(async () => {
    await pool.end();
});