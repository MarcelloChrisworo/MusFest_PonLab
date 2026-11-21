# MusFest Online Ticketing API

A backend API for events, ticket quotas, orders, and simulated payments.

## Run the API and database with Docker

Prerequisite: Docker Desktop.

From the project folder, run:

```powershell
docker compose up --build
```

The API is at `http://localhost:3000`. For example, list events with:

```powershell
Invoke-RestMethod http://localhost:3000/events
```

The database tables are created from `db/schema.sql` when the Docker database is initialized. Press `Ctrl+C` in the Compose terminal to stop the services.

## Main API flow

1. Register an organizer or buyer with `POST /auth/register`.
2. Log in with `POST /auth/login`. The response includes a token.
3. An organizer creates an event and ticket types with `POST /events`.
4. A buyer creates an order with `POST /orders`, using the ticket type ID and a quantity from 1 to 4. The order starts as `pending` and expires after 15 minutes.
5. To simulate payment, the buyer calls `POST /orders/:id/pay` with their token. The API marks that order as `paid` and returns ticket codes.

Example request body for `POST /orders`:

```json
{
  "ticketTypeId": "TICKET_TYPE_ID",
  "quantity": 2
}
```

Example PowerShell request to simulate payment. Set `$orderId` to the ID returned when the order was created, and `$token` to the buyer's login token:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:3000/orders/$orderId/pay" `
  -Headers @{ Authorization = "Bearer $token" }
```

Payment is simulated; this project does not connect to GoPay or another payment gateway.

## Email notifications

To enable email notifications, set `EMAIL_WEBHOOK_URL` to the deployed Apps Script Web app URL and `EMAIL_WEBHOOK_SECRET` to the same value as the Apps Script `WEBHOOK_SECRET` Script Property in the root `.env` file. The API sends a pending notification after saving an order and a paid notification after simulated payment and ticket creation. The payment remains simulated; Apps Script only sends email.

## Run automated tests

The tests use a separate PostgreSQL database named `musfest_test`; they should not use the demo database.

1. Create `musfest_test` in PostgreSQL.
2. Run `db/schema.sql` against `musfest_test`.
3. Create a root-level `.env.test` with your test database connection and a test JWT secret:

```text
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/musfest_test
JWT_SECRET=local-test-secret
```

4. Install dependencies and run the tests:

```powershell
npm ci
npm test -- --runInBand
```

The tests cover database connectivity, pending orders, simulated payment and ticket creation, insufficient quota, expired orders, and 200 simultaneous one-ticket orders. The concurrency test uses 200 different buyers and checks that a quota of 100 produces exactly 100 paid tickets and 100 rejected orders.

## CI/CD

A push to GitHub runs the tests. If they pass, GitHub Actions builds and publishes the Docker image to GitHub Container Registry with a commit SHA tag and a `latest` tag.
