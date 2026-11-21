const pool = require('../config/db');

exports.listEvents = async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                e.id AS event_id,
                e.name AS event_name,
                e.description,
                e.date AS event_date,
                e.location,
                tt.id AS ticket_type_id,
                tt.name AS ticket_type_name,
                tt.price,
                tt.quota,
                GREATEST(
                    tt.quota - COALESCE(
                        SUM(o.quantity) FILTER (
                            WHERE o.status = 'paid'
                               OR (o.status = 'pending' AND o.expires_at > NOW())
                        ),
                        0
                    ),
                    0
                )::int AS remaining
            FROM events e
            LEFT JOIN ticket_types tt ON tt.event_id = e.id
            LEFT JOIN orders o ON o.ticket_type_id = tt.id
            GROUP BY e.id, tt.id
            ORDER BY e.date, e.name, tt.name
        `);

        const eventsById = new Map();
        for (const row of result.rows) {
            if (!eventsById.has(row.event_id)) {
                eventsById.set(row.event_id, {
                    id: row.event_id,
                    name: row.event_name,
                    description: row.description,
                    date: row.event_date,
                    location: row.location,
                    ticketTypes: []
                });
            }
            if (row.ticket_type_id) {
                eventsById.get(row.event_id).ticketTypes.push({
                    id: row.ticket_type_id,
                    name: row.ticket_type_name,
                    price: row.price,
                    quota: row.quota,
                    remaining: row.remaining
                });
            }
        }
        return res.json({ events: [...eventsById.values()] });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Could not load events' });
    }
};

exports.createEvent = async (req, res) => {
    const { name, description, date, location, ticketTypes } = req.body;
    if (!name || !date || !Array.isArray(ticketTypes) || ticketTypes.length === 0) {
        return res.status(400).json({ error: 'Name, date, and at least one ticket type are required' });
    }
    if (Number.isNaN(new Date(date).getTime())) {
        return res.status(400).json({ error: 'Date must be a valid date' });
    }
    const invalidTicketType = ticketTypes.some((type) =>
        !type.name ||
        !Number.isFinite(Number(type.price)) ||
        Number(type.price) < 0 ||
        !Number.isInteger(Number(type.quota)) ||
        Number(type.quota) <= 0
    );
    if (invalidTicketType) {
        return res.status(400).json({
            error: 'Each ticket type needs a name, non-negative price, and positive whole-number quota'
        });
    }

    let client;
    let transactionStarted = false;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        transactionStarted = true;

        const eventResult = await client.query(
            `INSERT INTO events (organizer_id, name, description, date, location)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, organizer_id, name, description, date, location`,
            [req.user.id, name.trim(), description || null, date, location || null]
        );
        const event = eventResult.rows[0];
        const savedTicketTypes = [];
        for (const type of ticketTypes) {
            const ticketResult = await client.query(
                `INSERT INTO ticket_types (event_id, name, price, quota)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id, name, price, quota`,
                [event.id, type.name.trim(), Number(type.price), Number(type.quota)]
            );
            savedTicketTypes.push(ticketResult.rows[0]);
        }

        await client.query('COMMIT');
        transactionStarted = false;
        return res.status(201).json({ event: { ...event, ticketTypes: savedTicketTypes } });
    } catch (error) {
        if (client && transactionStarted) await client.query('ROLLBACK');
        console.error(error);
        return res.status(500).json({ error: 'Could not create event' });
    } finally {
        if (client) client.release();
    }
};
