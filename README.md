# Exora Hospitality Intelligence Demo

A local demonstration dashboard for hotel owners, built with React, Vite, Node.js, Express, and SQLite. It includes seeded example data for two Fargo properties, with dashboards for pricing recommendations, room and category setup, bookings, revenue, and the Exora owner agent.

> **Demo only:** the records and pricing recommendations are illustrative. No live PMS, OTA, SynXis, ChoiceADVANTAGE, or RevIQ connections are configured.

## Requirements

- Node.js 20 or newer (Node.js 22 is supported)
- npm

## Run locally

1. Clone the repository and enter its folder:

   ```powershell
   git clone https://github.com/renukaprasadbs454/motel-systems-usa.git
   cd motel-systems-usa
   ```

2. Install dependencies:

   ```powershell
   npm install
   ```

3. Create a local environment file (optional for the demo defaults):

   ```powershell
   Copy-Item .env.example .env
   ```

   The included `.env.example` uses the demo login shown below. Change `JWT_SECRET` before exposing the app beyond your own computer.

4. Start the API and frontend together:

   ```powershell
   npm run dev
   ```

5. Open [http://localhost:5173](http://localhost:5173) and sign in:

   - **Email:** `owner@exora.demo`
   - **Password:** `exora-demo`

The Express API runs on [http://localhost:4000](http://localhost:4000). The frontend proxies `/api` requests to it.

## Demo database

The seeded SQLite database is included at `server/data/exora-demo.db`. The API opens this file on startup. If the database is absent or empty, the server creates the schema and inserts demo seed records automatically. Local changes made in the demo are stored in this SQLite file.

To reset the demo to its original seeded state, stop the server, delete `server/data/exora-demo.db`, then run `npm run dev` again. The server will recreate and seed it. (Do not delete the database if you want to keep your local edits.)

## Useful commands

```powershell
npm run dev     # Run API and Vite frontend together
npm run server  # Run only the Express API
npm run client  # Run only the Vite frontend
npm run build   # Build the frontend for production
```

## Voice demo

The owner agent can use browser speech recognition where available. If the browser does not support it or microphone access is unavailable, the microphone opens a simulated demo recording that submits a seeded question and displays the agent's answer. Microphone permissions and speech recognition support depend on the browser and device.

## Project layout

```text
src/                    React dashboard and styles
server/index.js          Express API, SQLite schema, and demo seed data
server/data/exora-demo.db Seeded SQLite demo database
```
