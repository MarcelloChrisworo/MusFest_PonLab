const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });
process.env.NODE_ENV = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const pool = require('../src/config/db');

test('200 simultaneous one-ticket orders produce exactly 100 paid tickets for quota 100', async () => {
    let organizerId;
    let eventId;
    let ticketTypeId;
    let buyerIds = [];

    try {
        const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
        const organizer = await pool.query(
            `INSERT INTO users (name, email, password, role)
             VALUES ('Concurrency Organizer', $1, 'test-only', 'organizer')
             RETURNING id`,
            [`concurrency-organizer-${suffix}@test.example`]
        );
        organizerId = organizer.rows[0].id;

        const event = await pool.query(
            `INSERT INTO events (organizer_id, name, date)
             VALUES ($1, 'Concurrency Event', NOW() + INTERVAL '1 day')
             RETURNING id`,
            [organizerId]
        );
        eventId = event.rows[0].id;

        const ticketType = await pool.query(
            `INSERT INTO ticket_types (event_id, name, price, quota)
             VALUES ($1, 'Concurrency Ticket', 200000, 100)
             RETURNING id`,
            [eventId]
        );
        ticketTypeId = ticketType.rows[0].id;

        const emails = Array.from(
            { length: 200 },
            (_, index) => `concurrency-${suffix}-${index}@test.example`
        );
        const buyers = await pool.query(
            `INSERT INTO users (name, email, password, role)
             SELECT 'Concurrency Buyer', email, 'test-only', 'buyer'
             FROM unnest($1::text[]) AS input(email)
             RETURNING id, email`,
            [emails]
        );
        buyerIds = buyers.rows.map((buyer) => buyer.id);

        const attempts = await Promise.all(
            buyers.rows.map(async (buyer) => {
                const token = jwt.sign(
                    { id: buyer.id, role: 'buyer' },
                    process.env.JWT_SECRET
                );
                const response = await request(app)
                    .post('/orders')
                    .set('Authorization', `Bearer ${token}`)
                    .send({ ticketTypeId, quantity: 1 });
                return { buyerId: buyer.id, token, response };
            })
        );

        const accepted = attempts.filter(({ response }) => response.status === 201);
        const rejected = attempts.filter(({ response }) => response.status === 409);

        expect(accepted).toHaveLength(100);
        expect(rejected).toHaveLength(100);
        expect(rejected.every(({ response }) => response.body.error === 'Not enough tickets remaining')).toBe(true);

        const payments = await Promise.all(
            accepted.map(({ buyerId, token, response }) =>
                request(app)
                    .post(`/orders/${response.body.order.id}/pay`)
                    .set('Authorization', `Bearer ${token}`)
            )
        );
        expect(payments.every((response) => response.status === 200)).toBe(true);

        const orderCounts = await pool.query(
            `SELECT COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_orders,
                    COALESCE(SUM(quantity) FILTER (WHERE status = 'paid'), 0)::int AS paid_tickets
             FROM orders WHERE ticket_type_id = $1`,
            [ticketTypeId]
        );
        const ticketCounts = await pool.query(
            'SELECT COUNT(*)::int AS count FROM tickets WHERE order_id IN (SELECT id FROM orders WHERE ticket_type_id = $1)',
            [ticketTypeId]
        );

        expect(orderCounts.rows[0].paid_orders).toBe(100);
        expect(orderCounts.rows[0].paid_tickets).toBe(100);
        expect(ticketCounts.rows[0].count).toBe(100);
    } finally {
        if (ticketTypeId) {
            await pool.query(
                'DELETE FROM tickets WHERE order_id IN (SELECT id FROM orders WHERE ticket_type_id = $1)',
                [ticketTypeId]
            );
            await pool.query('DELETE FROM orders WHERE ticket_type_id = $1', [ticketTypeId]);
            await pool.query('DELETE FROM ticket_types WHERE id = $1', [ticketTypeId]);
        }
        if (eventId) await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
        if (buyerIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [buyerIds]);
        if (organizerId) await pool.query('DELETE FROM users WHERE id = $1', [organizerId]);
    }
}, 120000);

afterAll(async () => {
    await pool.end();
});
