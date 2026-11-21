const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const pool = require('../src/config/db');

describe('POST /orders', () => {
    let buyerId;
    let organizerId;
    let eventId;
    let ticketTypeId;
    let buyerToken;

    beforeAll(async () => {
        const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

        const organizer = await pool.query(
            `INSERT INTO users (name, email, password, role)
             VALUES ('Test Organizer', $1, 'test-only', 'organizer')
             RETURNING id`,
            [`organizer-${suffix}@test.example`]
        );
        organizerId = organizer.rows[0].id;

        const buyer = await pool.query(
            `INSERT INTO users (name, email, password, role)
             VALUES ('Test Buyer', $1, 'test-only', 'buyer')
             RETURNING id`,
            [`buyer-${suffix}@test.example`]
        );
        buyerId = buyer.rows[0].id;

        const event = await pool.query(
            `INSERT INTO events (organizer_id, name, date)
             VALUES ($1, 'Test Event', NOW() + INTERVAL '1 day')
             RETURNING id`,
            [organizerId]
        );
        eventId = event.rows[0].id;

        const ticketType = await pool.query(
            `INSERT INTO ticket_types (event_id, name, price, quota)
             VALUES ($1, 'Test Ticket', 200000, 10)
             RETURNING id`,
            [eventId]
        );
        ticketTypeId = ticketType.rows[0].id;

        buyerToken = jwt.sign(
            { id: buyerId, role: 'buyer' },
            process.env.JWT_SECRET
        );
    });

    afterAll(async () => {
        if (buyerId) {
            await pool.query(
                `DELETE FROM tickets
                 WHERE order_id IN (SELECT id FROM orders WHERE buyer_id = $1)`,
                [buyerId]
            );
            await pool.query('DELETE FROM orders WHERE buyer_id = $1', [buyerId]);
            await pool.query('DELETE FROM users WHERE id = $1', [buyerId]);
        }

        if (eventId) {
            await pool.query('DELETE FROM ticket_types WHERE event_id = $1', [eventId]);
            await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
        }

        if (organizerId) {
            await pool.query('DELETE FROM users WHERE id = $1', [organizerId]);
        }

        await pool.end();
    });

    test('creates an order with pending status', async () => {
        const response = await request(app)
            .post('/orders')
            .set('Authorization', `Bearer ${buyerToken}`)
            .send({ ticketTypeId, quantity: 2 });

        expect(response.status).toBe(201);
        expect(response.body.order.status).toBe('pending');
        expect(response.body.order.quantity).toBe(2);
    });

    test('simulates payment and creates one ticket per ordered ticket', async () => {
    const orderResponse = await request(app)
        .post('/orders')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ ticketTypeId, quantity: 2 });

    const orderId = orderResponse.body.order.id;

    const paymentResponse = await request(app)
        .post(`/orders/${orderId}/pay`)
        .set('Authorization', `Bearer ${buyerToken}`);

    expect(paymentResponse.status).toBe(200);
    expect(paymentResponse.body.order.status).toBe('paid');
    expect(paymentResponse.body.tickets).toHaveLength(2);
});
test('rejects an order larger than the available quota', async () => {
    const scarceTicket = await pool.query(
        `INSERT INTO ticket_types (event_id, name, price, quota)
         VALUES ($1, 'Scarce Test Ticket', 200000, 1)
         RETURNING id`,
        [eventId]
    );

    const response = await request(app)
        .post('/orders')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ ticketTypeId: scarceTicket.rows[0].id, quantity: 2 });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('Not enough tickets remaining');
});
test('rejects payment for an expired order and issues no tickets', async () => {
    const expiredOrder = await pool.query(
        `INSERT INTO orders
            (buyer_id, ticket_type_id, quantity, total_price, status, expires_at)
         VALUES ($1, $2, 1, 200000, 'pending', NOW() - INTERVAL '1 minute')
         RETURNING id`,
        [buyerId, ticketTypeId]
    );

    const orderId = expiredOrder.rows[0].id;

    const response = await request(app)
        .post(`/orders/${orderId}/pay`)
        .set('Authorization', `Bearer ${buyerToken}`);

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('This order has expired');

    const savedOrder = await pool.query(
        'SELECT status FROM orders WHERE id = $1',
        [orderId]
    );
    expect(savedOrder.rows[0].status).toBe('expired');

    const savedTickets = await pool.query(
        'SELECT id FROM tickets WHERE order_id = $1',
        [orderId]
    );
    expect(savedTickets.rows).toHaveLength(0);
});
});

