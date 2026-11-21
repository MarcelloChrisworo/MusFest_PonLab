const pool = require('../config/db');

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

        await client.query('COMMIT');
        transactionStarted = false;

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