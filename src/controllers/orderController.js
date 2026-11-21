const pool = require('../config/db');
const sendEmailNotification = require('../services/emailWebhook');
const { randomUUID } = require('crypto');

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

exports.createOrder = async (req, res) => {
    const ticketTypeId = req.body?.ticketTypeId;
    const quantity = Number(req.body?.quantity);

    if (
        typeof ticketTypeId !== 'string' ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 4
    ) {
        return res.status(400).json({
            error: 'ticketTypeId and a whole-number quantity from 1 to 4 are required'
        });
    }

    let client;
    let transactionStarted = false;

    try {
        client = await pool.connect();
        await client.query('BEGIN');
        transactionStarted = true;

        const ticketResult = await client.query(
            `SELECT e.id AS event_id, e.name AS event_name, e.date AS event_date,
                    tt.id AS ticket_type_id, tt.name AS ticket_type_name,
                    tt.price, tt.quota
             FROM events e
             JOIN ticket_types tt ON tt.event_id = e.id
             WHERE tt.id = $1
             FOR UPDATE OF e`,
            [ticketTypeId]
        );

        if (ticketResult.rowCount === 0) {
            throw httpError(404, 'Ticket type not found');
        }

        const ticketType = ticketResult.rows[0];

        if (new Date(ticketType.event_date).getTime() <= Date.now()) {
            throw httpError(409, 'This event has already started');
        }

        await client.query(
            `UPDATE orders
             SET status = 'expired'
             WHERE status = 'pending'
               AND expires_at <= NOW()
               AND ticket_type_id IN (
                   SELECT id FROM ticket_types WHERE event_id = $1
               )`,
            [ticketType.event_id]
        );

        const availability = await client.query(
            `SELECT COALESCE(SUM(quantity), 0)::int AS used
             FROM orders
             WHERE ticket_type_id = $1
               AND (
                   status = 'paid'
                   OR (status = 'pending' AND expires_at > NOW())
               )`,
            [ticketTypeId]
        );

        const remaining = Number(ticketType.quota) - availability.rows[0].used;

        if (quantity > remaining) {
            throw httpError(409, 'Not enough tickets remaining');
        }

        const buyerUsage = await client.query(
            `SELECT COALESCE(SUM(o.quantity), 0)::int AS used
             FROM orders o
             JOIN ticket_types tt ON tt.id = o.ticket_type_id
             WHERE o.buyer_id = $1
               AND tt.event_id = $2
               AND (
                   o.status = 'paid'
                   OR (o.status = 'pending' AND o.expires_at > NOW())
               )`,
            [req.user.id, ticketType.event_id]
        );

        if (buyerUsage.rows[0].used + quantity > 4) {
            throw httpError(409, 'A buyer may hold or purchase at most 4 tickets per event');
        }

        const orderResult = await client.query(
            `INSERT INTO orders
                 (buyer_id, ticket_type_id, quantity, total_price, status, expires_at)
             SELECT $1, $2, $3::integer, tt.price * $3::integer,
                    'pending', NOW() + INTERVAL '15 minutes'
             FROM ticket_types tt
             WHERE tt.id = $2
             RETURNING id, buyer_id, ticket_type_id, quantity,
                       total_price, status, expires_at, created_at`,
            [req.user.id, ticketTypeId, quantity]
        );

        const buyerResult = await client.query(
            'SELECT email FROM users WHERE id = $1',
            [req.user.id]
        );
        await client.query('COMMIT');
        transactionStarted = false;

        await sendEmailNotification({
            orderId: orderResult.rows[0].id,
            email: buyerResult.rows[0].email,
            status: 'pending',
            quantity: orderResult.rows[0].quantity,
            expiresAt: orderResult.rows[0].expires_at
        });

        return res.status(201).json({
            order: {
                ...orderResult.rows[0],
                eventName: ticketType.event_name,
                ticketTypeName: ticketType.ticket_type_name
            }
        });
    } catch (error) {
        if (client && transactionStarted) {
            await client.query('ROLLBACK');
        }

        if (error.status) {
            return res.status(error.status).json({ error: error.message });
        }

        console.error('Could not create order:', error.message);
        return res.status(500).json({ error: 'Could not create order' });
    } finally {
        if (client) {
            client.release();
        }
    }
};
exports.simulatePayment = async (req, res) => {
    let client;
    let transactionStarted = false;

    try {
        client = await pool.connect();
        await client.query('BEGIN');
        transactionStarted = true;

        const lookup = await client.query(
            `SELECT tt.event_id, u.email
             FROM orders o
             JOIN ticket_types tt ON tt.id = o.ticket_type_id
             JOIN users u ON u.id = o.buyer_id
             WHERE o.id = $1 AND o.buyer_id = $2`,
            [req.params.id, req.user.id]
        );

        if (lookup.rowCount === 0) {
            throw httpError(404, 'Order not found');
        }

        await client.query(
            'SELECT id FROM events WHERE id = $1 FOR UPDATE',
            [lookup.rows[0].event_id]
        );

        const result = await client.query(
            `SELECT id, quantity, status, (expires_at > NOW()) AS is_unexpired
             FROM orders
             WHERE id = $1 AND buyer_id = $2
             FOR UPDATE`,
            [req.params.id, req.user.id]
        );

        const order = result.rows[0];

        if (order.status === 'paid') {
            const existingTickets = await client.query(
                'SELECT id, code, created_at FROM tickets WHERE order_id = $1 ORDER BY created_at',
                [order.id]
            );

            await client.query('COMMIT');
            transactionStarted = false;

            return res.json({
                order: { id: order.id, status: 'paid' },
                tickets: existingTickets.rows,
                alreadyPaid: true
            });
        }

        if (order.status !== 'pending') {
            throw httpError(409, `This order is ${order.status}`);
        }

        if (!order.is_unexpired) {
            await client.query(
                "UPDATE orders SET status = 'expired' WHERE id = $1",
                [order.id]
            );
            await client.query('COMMIT');
            transactionStarted = false;
            return res.status(409).json({ error: 'This order has expired' });
        }

        await client.query(
            "UPDATE orders SET status = 'paid' WHERE id = $1",
            [order.id]
        );

        const tickets = [];
        for (let i = 0; i < order.quantity; i += 1) {
            const code = `MF-${randomUUID().replaceAll('-', '').toUpperCase()}`;
            const ticket = await client.query(
                `INSERT INTO tickets (order_id, code)
                 VALUES ($1, $2)
                 RETURNING id, code, created_at`,
                [order.id, code]
            );
            tickets.push(ticket.rows[0]);
        }

        await client.query('COMMIT');
        transactionStarted = false;

        await sendEmailNotification({
            orderId: order.id,
            email: lookup.rows[0].email,
            status: 'paid',
            quantity: order.quantity,
            ticketCodes: tickets.map((ticket) => ticket.code)
        });

        return res.json({
            order: { id: order.id, status: 'paid' },
            tickets
        });
    } catch (error) {
        if (client && transactionStarted) {
            await client.query('ROLLBACK');
        }

        if (error.status) {
            return res.status(error.status).json({ error: error.message });
        }

        console.error('Could not simulate payment:', error.message);
        return res.status(500).json({ error: 'Could not complete payment' });
    } finally {
        if (client) {
            client.release();
        }
    }
};
