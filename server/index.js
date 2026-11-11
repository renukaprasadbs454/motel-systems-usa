import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'exora-demo.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function hotelTodayString() {
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

db.exec(`
CREATE TABLE IF NOT EXISTS properties (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL, franchisor TEXT NOT NULL,
 system TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL, rooms INTEGER NOT NULL,
 occupancy REAL NOT NULL, adr REAL NOT NULL, revpar REAL NOT NULL, revenue REAL NOT NULL,
 current_rate REAL NOT NULL, status TEXT NOT NULL DEFAULT 'Healthy'
);
CREATE TABLE IF NOT EXISTS recommendations (
 id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id), stay_date TEXT NOT NULL,
 day_label TEXT NOT NULL, current_rate REAL NOT NULL, recommended_rate REAL NOT NULL,
 occupancy REAL NOT NULL, forecast_occupancy REAL NOT NULL, competitor_rate REAL NOT NULL,
 confidence INTEGER NOT NULL, drivers TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending',
 factors TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS alerts (
 id INTEGER PRIMARY KEY, property_id INTEGER REFERENCES properties(id), kind TEXT NOT NULL,
 title TEXT NOT NULL, detail TEXT NOT NULL, time_label TEXT NOT NULL, severity TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'Open'
);
CREATE TABLE IF NOT EXISTS daily_metrics (
 id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id), day TEXT NOT NULL,
 revenue REAL NOT NULL, occupancy REAL NOT NULL, adr REAL NOT NULL, rooms_sold INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
 id INTEGER PRIMARY KEY, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS locations (
 id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
 name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '',
 postal_code TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT 'United States', timezone TEXT NOT NULL DEFAULT 'America/Chicago',
 latitude REAL, longitude REAL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS room_categories (
 id INTEGER PRIMARY KEY AUTOINCREMENT, location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 name TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'Standard', room_type TEXT NOT NULL DEFAULT 'King',
 description TEXT NOT NULL DEFAULT '', base_price REAL NOT NULL DEFAULT 99, min_rate REAL NOT NULL DEFAULT 59,
 max_rate REAL NOT NULL DEFAULT 249, max_step REAL NOT NULL DEFAULT 25, bed_type TEXT NOT NULL DEFAULT 'King',
 max_guests INTEGER NOT NULL DEFAULT 2, room_size_sqft INTEGER NOT NULL DEFAULT 300,
 amenities TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rooms (
 id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL REFERENCES room_categories(id) ON DELETE CASCADE,
 room_number TEXT NOT NULL, floor TEXT NOT NULL DEFAULT '1', status TEXT NOT NULL DEFAULT 'Ready',
 notes TEXT NOT NULL DEFAULT '', UNIQUE(category_id,room_number)
);
CREATE TABLE IF NOT EXISTS bookings (
 id INTEGER PRIMARY KEY AUTOINCREMENT, confirmation_code TEXT NOT NULL UNIQUE,
 property_id INTEGER NOT NULL REFERENCES properties(id), location_id INTEGER NOT NULL REFERENCES locations(id),
 category_id INTEGER NOT NULL REFERENCES room_categories(id), room_id INTEGER REFERENCES rooms(id),
 reservation_source TEXT NOT NULL, booking_status TEXT NOT NULL DEFAULT 'Confirmed', payment_status TEXT NOT NULL DEFAULT 'Unpaid',
 booking_date TEXT NOT NULL, check_in TEXT NOT NULL, check_out TEXT NOT NULL,
 guest_name TEXT NOT NULL, guest_email TEXT NOT NULL DEFAULT '', guest_phone TEXT NOT NULL DEFAULT '',
 adults INTEGER NOT NULL DEFAULT 1, children INTEGER NOT NULL DEFAULT 0, room_count INTEGER NOT NULL DEFAULT 1,
 rate_per_night REAL NOT NULL, nights INTEGER NOT NULL, room_subtotal REAL NOT NULL, discount_amount REAL NOT NULL DEFAULT 0,
 tax_rate REAL NOT NULL DEFAULT 0, tax_amount REAL NOT NULL DEFAULT 0, fees_amount REAL NOT NULL DEFAULT 0,
 total_amount REAL NOT NULL, advance_amount REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', special_requests TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payment_transactions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, location_id INTEGER NOT NULL REFERENCES locations(id), property_id INTEGER NOT NULL REFERENCES properties(id),
 booking_id INTEGER REFERENCES bookings(id), transaction_date TEXT NOT NULL, type TEXT NOT NULL,
 method TEXT NOT NULL, channel TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'Posted',
 reference TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_bookings_location_dates ON bookings(location_id,check_in,check_out);
CREATE INDEX IF NOT EXISTS idx_booking_status ON bookings(booking_status,payment_status);
CREATE INDEX IF NOT EXISTS idx_payment_date_location ON payment_transactions(transaction_date,location_id);
`);

const recommendationColumns = db.prepare('PRAGMA table_info(recommendations)').all().map(column => column.name);
if (!recommendationColumns.includes('factors')) {
  db.exec("ALTER TABLE recommendations ADD COLUMN factors TEXT NOT NULL DEFAULT '{}'");
}
const categoryColumns=db.prepare('PRAGMA table_info(room_categories)').all().map(column=>column.name);
if(!categoryColumns.includes('image_url'))db.exec("ALTER TABLE room_categories ADD COLUMN image_url TEXT NOT NULL DEFAULT ''");
if(!categoryColumns.includes('image_source'))db.exec("ALTER TABLE room_categories ADD COLUMN image_source TEXT NOT NULL DEFAULT ''");

const recommendationFactorInputs = [
  ['historical.adr', 'number'], ['historical.occupancy', 'number'], ['historical.revpar', 'number'], ['historical.roomRevenue', 'number'], ['historical.pickupRooms', 'number'], ['historical.comparablePeriod', 'text'],
  ['demand.onBooksRooms', 'number'], ['demand.occupancy', 'number'], ['demand.forecastOccupancy', 'number'], ['demand.forecastRooms', 'number'], ['demand.remainingRooms', 'number'], ['demand.sellableRooms', 'number'], ['demand.snapshotType', 'text'],
  ['pace.pickupRooms', 'number'], ['pace.priorSnapshotOccupancy', 'number'], ['pace.leadTimeDays', 'number'], ['pace.lengthOfStayNights', 'number'], ['pace.cancellationPickupRooms', 'number'], ['pace.daysSincePriorSnapshot', 'number'],
  ['cancellations.cancellationRate', 'number'], ['cancellations.noShowRate', 'number'],
  ['market.competitorRate', 'number'], ['market.availability', 'text'], ['market.matchedTerms', 'text'], ['market.sampleHotels', 'number'], ['market.freshnessMinutes', 'number'],
  ['calendar.dayOfWeek', 'text'], ['calendar.season', 'text'], ['calendar.specialEvent', 'text'], ['calendar.eventIntensity', 'number'], ['calendar.eventDistanceMiles', 'number'], ['calendar.eventConfidence', 'number'],
  ['weather.severity', 'text'], ['weather.confidence', 'number'],
  ['channels.mix.direct', 'number'], ['channels.mix.brand', 'number'], ['channels.mix.ota', 'number'], ['channels.mix.other', 'number'], ['channels.commissionEstimatePct', 'number'],
  ['property.positioning', 'text'], ['property.roomClass', 'text'], ['property.ratePlan', 'text'], ['property.roomClassOffset', 'number'], ['property.amenityOffset', 'number'], ['property.amenities', 'text'], ['property.amenitiesMapped', 'boolean'],
  ['capacity.physicalRooms', 'number'], ['capacity.outOfOrderRooms', 'number'], ['capacity.sellableRooms', 'number'], ['capacity.openDays', 'number'], ['capacity.openForSale', 'boolean'],
  ['guardrails.floor', 'number'], ['guardrails.ceiling', 'number'], ['guardrails.maxRateChange', 'number'], ['guardrails.rateParityConstraint', 'text'], ['guardrails.parityFloorRate', 'number'], ['guardrails.excludedDates', 'boolean'], ['guardrails.approvalPolicy', 'text'],
  ['uncertainty.confidence', 'number'], ['uncertainty.forecastUncertaintyPct', 'number'], ['uncertainty.bandLow', 'number'], ['uncertainty.bandHigh', 'number'], ['uncertainty.sourceQuality', 'text'], ['uncertainty.dataFreshnessMinutes', 'number'],
  ['priceResponse.elasticity', 'number'], ['decision.currentRate', 'number'],
];

function readPath(value, path) { return path.split('.').reduce((node, key) => node && node[key], value); }
function writePath(target, path, value) { const keys = path.split('.'); let node = target; for (const key of keys.slice(0, -1)) node = node[key] ||= {}; node[keys.at(-1)] = value; }
function completeRecommendationFactors(factors, rec) {
  const f = JSON.parse(JSON.stringify(factors || {}));
  f.historical ||= {}; f.demand ||= {}; f.pace ||= {}; f.cancellations ||= {}; f.market ||= {}; f.calendar ||= {}; f.weather ||= {}; f.channels ||= {}; f.channels.mix ||= {}; f.property ||= {}; f.capacity ||= {}; f.guardrails ||= {}; f.uncertainty ||= {}; f.priceResponse ||= {}; f.decision ||= {};
  Object.assign(f.pace, { cancellationPickupRooms: f.pace.cancellationPickupRooms ?? 0, daysSincePriorSnapshot: f.pace.daysSincePriorSnapshot ?? 1 });
  f.historical.pickupRooms ??= f.pace.pickupRooms ?? 0; f.historical.comparablePeriod ||= 'Comparable recent dates';
  Object.assign(f.demand, { snapshotType: f.demand.snapshotType || 'On-the-books snapshot' });
  Object.assign(f.market, { availability: f.market.availability?.startsWith('Available') ? 'Available' : 'Unconfirmed', matchedTerms: f.market.matchedTerms?.startsWith('Date/room') ? 'Matched' : 'Partial match' });
  f.calendar.eventDistanceMiles ??= 0; f.calendar.eventConfidence ??= 0; f.calendar.eventIntensity ??= 0;
  Object.assign(f.property, { roomClassOffset: f.property.roomClassOffset ?? 0, amenityOffset: f.property.amenityOffset ?? 0, ratePlan: f.property.ratePlan || 'Standard' });
  f.property.amenities = Array.isArray(f.property.amenities) ? f.property.amenities.join(', ') : String(f.property.amenities || '');
  Object.assign(f.capacity, { openDays: f.capacity.openDays ?? 7, openForSale: f.capacity.openForSale ?? true });
  Object.assign(f.guardrails, { rateParityConstraint: f.guardrails.rateParityConstraint || 'Not configured', parityFloorRate: f.guardrails.parityFloorRate ?? 0, excludedDates: Boolean(f.guardrails.excludedDates), approvalPolicy: f.guardrails.approvalPolicy || 'Owner approval required' });
  Object.assign(f.uncertainty, { forecastUncertaintyPct: f.uncertainty.forecastUncertaintyPct ?? Math.max(0, 100 - (f.uncertainty.confidence || rec.confidence)), dataFreshnessMinutes: f.uncertainty.dataFreshnessMinutes ?? 60 });
  f.priceResponse.elasticity = Number.isFinite(Number(f.priceResponse.elasticity)) ? Number(f.priceResponse.elasticity) : -0.8;
  f.decision.currentRate = Number(f.decision.currentRate ?? rec.current_rate);
  for (const [path, type] of recommendationFactorInputs) {
    const value = readPath(f, path);
    if (type === 'number' && value !== undefined && value !== null) writePath(f, path, Number(value));
  }
  return f;
}

function calculateRecommendation(rec, submittedFactors) {
  const factors = completeRecommendationFactors(submittedFactors, rec);
  for (const [path, type] of recommendationFactorInputs) {
    if (type === 'text' || type === 'boolean') continue;
    const value = readPath(factors, path);
    if (value !== undefined && value !== null && (!Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1000000)) throw new Error(`Invalid value for ${path}.`);
  }
  const current = Math.max(1, Number(factors.decision.currentRate || rec.current_rate));
  const floor = Math.max(1, Number(factors.guardrails.floor || 1), Number(factors.guardrails.parityFloorRate || 0));
  const ceiling = Math.max(floor, Number(factors.guardrails.ceiling || 1000));
  const maxStep = Math.max(0, Number(factors.guardrails.maxRateChange || 0));
  const physicalRooms = Math.max(1, Number(factors.capacity.physicalRooms || factors.capacity.sellableRooms || 1));
  const sellableRooms = Math.max(1, Math.min(Number(factors.capacity.sellableRooms || physicalRooms), physicalRooms - Math.max(0, Number(factors.capacity.outOfOrderRooms || 0))));
  const projectedOcc = Number(factors.demand.forecastOccupancy || 0);
  const forecastRoomOcc = Number(factors.demand.forecastRooms || 0) / sellableRooms * 100;
  const otbRoomOcc = Number(factors.demand.onBooksRooms || 0) / sellableRooms * 100;
  const demand = Math.min(100, Math.max(0, projectedOcc * 0.7 + forecastRoomOcc * 0.15 + otbRoomOcc * 0.15));
  const pickup = Number(factors.pace.pickupRooms || 0) - Number(factors.pace.cancellationPickupRooms || 0);
  const adr = Number(factors.historical.adr || current);
  const historicalOcc = Number(factors.historical.occupancy || 0);
  const revpar = Number(factors.historical.revpar || adr * historicalOcc / 100);
  const historicalRoomRevenuePerRoom = Number(factors.historical.roomRevenue || 0) / physicalRooms;
  const competitorRate = Number(factors.market.competitorRate || current);
  const comparableMarket = factors.market.availability === 'Available' && factors.market.matchedTerms === 'Matched';
  const marketFreshnessFactor = Number(factors.market.freshnessMinutes || 0) > 1440 ? 0.35 : Number(factors.market.freshnessMinutes || 0) > 360 ? 0.7 : 1;
  const marketSampleFactor = Math.min(1, Math.max(0, Number(factors.market.sampleHotels || 0) / 4));
  const marketSignal = comparableMarket ? Math.max(-6, Math.min(6, (competitorRate - current) * 0.12 * marketFreshnessFactor * marketSampleFactor)) : 0;
  const eventDistance = Number(factors.calendar.eventDistanceMiles || 0);
  const eventSignal = Number(factors.calendar.eventIntensity || 0) > 0 && eventDistance > 0
    ? Math.min(4, Number(factors.calendar.eventIntensity) / 100 * Math.max(0, 1 - eventDistance / 25) * (Number(factors.calendar.eventConfidence || 0) / 100) * 5) : 0;
  const daySignal = ['Friday', 'Saturday'].includes(factors.calendar.dayOfWeek) ? 3 : factors.calendar.dayOfWeek === 'Sunday' ? 1 : 0;
  const seasonSignal = /peak|high|summer/i.test(factors.calendar.season) ? 2 : /low|off|winter/i.test(factors.calendar.season) ? -1 : 0;
  const cancelDrag = Math.min(5, Number(factors.cancellations.cancellationRate || 0) * 0.12 + Number(factors.cancellations.noShowRate || 0) * 0.08 + Number(factors.pace.cancellationPickupRooms || 0) * 0.5);
  const mix = factors.channels.mix;
  const mixTotal = ['direct', 'brand', 'ota', 'other'].reduce((sum, key) => sum + Math.max(0, Number(mix[key] || 0)), 0) || 100;
  const otaShare = Math.max(0, Number(mix.ota || 0)) / mixTotal;
  const channelSignal = Math.min(2, otaShare * Number(factors.channels.commissionEstimatePct || 0) * 0.08);
  const elasticityDamp = Math.min(1.5, Math.max(0.35, Math.abs(Number(factors.priceResponse.elasticity || -0.8)) / 0.8));
  const quality = Math.min(1, Math.max(0.25, Number(factors.uncertainty.confidence ?? 50) / 100));
  const freshness = Number(factors.uncertainty.dataFreshnessMinutes || 0) > 1440 ? 0.5 : 1;
  const sourceQuality = /partial|stale|missing/i.test(factors.uncertainty.sourceQuality || '') ? 0.75 : 1;
  const snapshotQuality = /manual|forecast/i.test(factors.demand.snapshotType || '') ? 0.9 : 1;
  const leadTimeDamp = 0.65 + 0.35 * Math.min(1, 14 / Math.max(1, Number(factors.pace.leadTimeDays || 1)));
  const staySignal = Math.min(1.5, Math.max(-1.5, (Number(factors.pace.lengthOfStayNights || 1) - 1) * 0.25));
  const historicalSignal = (adr - current) * 0.08 + (historicalOcc - 65) * 0.06 + (revpar - adr * historicalOcc / 100) * 0.03 + (historicalRoomRevenuePerRoom - adr * historicalOcc / 100) * 0.02 + Number(factors.historical.pickupRooms || 0) * 0.12;
  const scarcitySignal = sellableRooms > 0 ? Math.max(-1, Math.min(2, (1 - Number(factors.demand.remainingRooms || sellableRooms) / sellableRooms) * 2)) : 0;
  const change = ((demand - 65) * 0.24 + pickup * 0.9 * leadTimeDamp + historicalSignal + scarcitySignal + staySignal + marketSignal + eventSignal + daySignal + seasonSignal + Number(factors.property.roomClassOffset || 0) + Number(factors.property.amenityOffset || 0) + channelSignal - cancelDrag) * elasticityDamp * quality * freshness * sourceQuality * snapshotQuality;
  let suggested = current;
  if (!factors.guardrails.excludedDates && factors.capacity.openForSale !== false) {
    const upper = Math.max(floor, Math.min(ceiling, current + maxStep));
    const lower = Math.min(upper, Math.max(floor, current - maxStep));
    suggested = Math.round(Math.max(lower, Math.min(upper, current + change)));
  }
  factors.decision.currentRate = Math.round(current * 100) / 100;
  factors.demand.forecastOccupancy = Math.round(demand * 10) / 10;
  factors.demand.sellableRooms = sellableRooms;
  factors.demand.forecastRooms = Math.min(sellableRooms, Math.max(0, Number(factors.demand.forecastRooms || (sellableRooms * demand / 100))));
  factors.channels.netRateEstimate = Math.round(current * (1 - Number(factors.channels.commissionEstimatePct || 0) / 100) * 100) / 100;
  factors.market.competitiveIndex = competitorRate > 0 ? Math.round(current / competitorRate * 1000) / 10 : null;
  factors.property.amenities = String(factors.property.amenities || '').split(',').map(x => x.trim()).filter(Boolean);
  factors.guardrails.changeApplied = suggested - current;
  factors.guardrails.constrained = !factors.guardrails.excludedDates && (Math.abs(suggested - (current + change)) > 0.01);
  factors.uncertainty.bandLow = Math.round(Math.max(floor, suggested - Math.max(2, Number(factors.uncertainty.forecastUncertaintyPct || 0) * 0.2)));
  factors.uncertainty.bandHigh = Math.round(Math.min(ceiling, suggested + Math.max(2, Number(factors.uncertainty.forecastUncertaintyPct || 0) * 0.2)));
  factors.recommendation ||= {};
  factors.recommendation.method = 'Transparent demo rule: occupancy, pickup net of cancellations, historical ADR, comparable market signal, event/calendar context, channel cost, price response, data confidence and owner guardrails.';
  factors.recommendation.optimization = 'Illustrative advisory calculation only; not a trained model, validated price-elasticity estimate, or live rate update.';
  const drivers = [`Current/base rate: $${current.toFixed(0)}`, `Projected occupancy: ${demand.toFixed(1)}%`, `Net pickup: ${pickup >= 0 ? '+' : ''}${pickup} rooms`, `Historical performance: ADR $${adr.toFixed(0)}, occupancy ${historicalOcc.toFixed(1)}%`, ...(comparableMarket ? [`Comparable market context: $${competitorRate.toFixed(0)}`] : ['Market context excluded: availability or room/terms match not confirmed']), ...(factors.guardrails.excludedDates || factors.capacity.openForSale === false ? ['Rate held at current: date excluded or property closed'] : []), ...(factors.guardrails.constrained ? ['Owner rate guardrails applied'] : []), `Confidence/data quality dampening applied`];
  const confidence = Math.round(quality * freshness * sourceQuality * snapshotQuality * 100);
  return { currentRate: factors.decision.currentRate, recommendedRate: suggested, confidence, forecastOccupancy: demand, factors, drivers };
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_locations_property ON locations(property_id);
CREATE INDEX IF NOT EXISTS idx_room_categories_location ON room_categories(location_id);
CREATE INDEX IF NOT EXISTS idx_rooms_category ON rooms(category_id);
`);

if (db.prepare('SELECT COUNT(*) AS count FROM properties').get().count === 0) seedDatabase();
else if (db.prepare('SELECT COUNT(*) AS count FROM recommendations WHERE factors != \'{}\'').get().count === 0) {
  db.exec('DELETE FROM recommendations');
  seedRecommendations();
}
if (db.prepare('SELECT COUNT(*) AS count FROM locations').get().count === 0) seedRoomManagement();
if (db.prepare('SELECT COUNT(*) AS count FROM bookings').get().count === 0) seedBookingsAndRevenue();
seedExpandedRoomInventory();
if (!db.prepare("SELECT value FROM settings WHERE key='cash_seed_v2'").get()) {
  db.prepare("UPDATE payment_transactions SET amount=CASE property_id WHEN 1 THEN 1300 WHEN 2 THEN 1200 ELSE amount END WHERE type='Opening balance' AND note='Illustrative starting cash balance'").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('cash_seed_v2','true')").run();
}
if (!db.prepare("SELECT value FROM settings WHERE key='booking_seed_v2'").get()) {
  const today=new Date(`${hotelTodayString()}T12:00:00`);const checkIn=new Date(today);checkIn.setDate(today.getDate()-2);
  const priorBookingDate=new Date(checkIn);priorBookingDate.setDate(checkIn.getDate()-12);
  for(const propertyId of [1,2])db.prepare("UPDATE bookings SET check_in=?,check_out=?,booking_date=?,booking_status='Checked out' WHERE confirmation_code=?").run(checkIn.toISOString().slice(0,10),today.toISOString().slice(0,10),priorBookingDate.toISOString().slice(0,10),`EX${propertyId}005`);
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('booking_seed_v2','true')").run();
}
if (!db.prepare("SELECT value FROM settings WHERE key='booking_seed_v3'").get()) {
  const today=new Date(`${hotelTodayString()}T12:00:00`);const checkIn=new Date(today);checkIn.setDate(today.getDate()-2);const bookingDate=new Date(checkIn);bookingDate.setDate(checkIn.getDate()-12);
  for(const propertyId of [1,2])db.prepare("UPDATE bookings SET check_in=?,check_out=?,booking_date=?,booking_status='Checked out' WHERE confirmation_code=?").run(checkIn.toISOString().slice(0,10),today.toISOString().slice(0,10),bookingDate.toISOString().slice(0,10),`EX${propertyId}005`);
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('booking_seed_v3','true')").run();
}
if(!db.prepare("SELECT value FROM settings WHERE key='prediction_window_v2'").get()){
  db.exec('DELETE FROM recommendations');
  insertRecommendations(seedRecommendationsData(db.prepare('SELECT * FROM properties ORDER BY id').all()));
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('prediction_window_v2','true')").run();
}
{
  const updateFactors = db.prepare('UPDATE recommendations SET factors=? WHERE id=?');
  for (const row of db.prepare('SELECT id,current_rate,confidence,factors FROM recommendations').all()) {
    const completed = completeRecommendationFactors(JSON.parse(row.factors || '{}'), row);
    updateFactors.run(JSON.stringify(completed), row.id);
  }
}

function seedDatabase() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const properties = [
    { id: 1, name: 'Travelodge Fargo West Acres', brand: 'Travelodge', franchisor: 'Wyndham Hotels & Resorts', system: 'SynXis · revIQ', city: 'Fargo', state: 'North Dakota', rooms: 70, occupancy: 78.4, adr: 112, revpar: 87.81, revenue: 7840, current_rate: 114, status: 'Healthy' },
    { id: 2, name: 'Quality Suites Fargo West Acres', brand: 'Quality Suites', franchisor: 'Choice Hotels International', system: 'ChoiceADVANTAGE', city: 'Fargo', state: 'North Dakota', rooms: 50, occupancy: 71.2, adr: 128, revpar: 91.14, revenue: 4550, current_rate: 129, status: 'Review' },
  ];
  const insertProperty = db.prepare(`INSERT INTO properties VALUES (@id,@name,@brand,@franchisor,@system,@city,@state,@rooms,@occupancy,@adr,@revpar,@revenue,@current_rate,@status)`);
  for (const p of properties) insertProperty.run(p);

  const recommendations = seedRecommendationsData(properties);
  insertRecommendations(recommendations);

  const alerts = [
    { id: 1, property_id: 2, kind: 'cash', title: 'Night audit reconciliation needs review', detail: 'Payments are $186 below reported room revenue.', time_label: 'Today · 7:12 AM', severity: 'High', status: 'Open' },
    { id: 2, property_id: 1, kind: 'trend', title: 'Weekend pickup is above the usual pace', detail: 'Friday occupancy is tracking 14 points ahead of the weekday baseline.', time_label: 'Today · 6:40 AM', severity: 'Medium', status: 'Open' },
    { id: 3, property_id: 2, kind: 'weather', title: 'Winter weather watch for Fargo', detail: 'Forecast context may affect arrival patterns. No automatic rate adjustment applied.', time_label: 'Yesterday · 4:26 PM', severity: 'Low', status: 'Open' },
    { id: 4, property_id: 1, kind: 'data', title: 'Competitor sample refreshed', detail: 'Matched-rate coverage: 4 of 5 sample properties.', time_label: 'Yesterday · 2:10 PM', severity: 'Low', status: 'Open' },
  ];
  const insertAlert = db.prepare(`INSERT INTO alerts VALUES (@id,@property_id,@kind,@title,@detail,@time_label,@severity,@status)`);
  for (const a of alerts) insertAlert.run(a);

  const insertMetric = db.prepare('INSERT INTO daily_metrics (property_id,day,revenue,occupancy,adr,rooms_sold) VALUES (?,?,?,?,?,?)');
  for (let i = 27; i >= 0; i--) {
    for (const p of properties) {
      const date = new Date(start); date.setDate(start.getDate() - i);
      const occupancy = Math.round((p.occupancy + Math.sin(i / 3) * 8 + (i % 7 === 1 || i % 7 === 2 ? 8 : -3)) * 10) / 10;
      const roomsSold = Math.round(p.rooms * occupancy / 100);
      const adr = Math.round(p.adr + Math.cos(i / 4) * 8);
      insertMetric.run(p.id, date.toISOString().slice(0, 10), roomsSold * adr, occupancy, adr, roomsSold);
    }
  }
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('demo_mode', 'true');
}

function seedRecommendations() {
  const properties = db.prepare('SELECT * FROM properties ORDER BY id').all();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  insertRecommendations(seedRecommendationsData(properties, start));
}

function insertRecommendations(recommendations) {
  const insertRec = db.prepare(`INSERT INTO recommendations (id,property_id,stay_date,day_label,current_rate,recommended_rate,occupancy,forecast_occupancy,competitor_rate,confidence,drivers,status,factors) VALUES (@id,@property_id,@stay_date,@day_label,@current_rate,@recommended_rate,@occupancy,@forecast_occupancy,@competitor_rate,@confidence,@drivers,@status,@factors)`);
  for (const r of recommendations) insertRec.run(r);
}

function seedRoomManagement() {
  const locations = [
    { property_id: 1, name: 'Travelodge Fargo West Acres', city: 'Fargo', state: 'North Dakota', timezone: 'America/Chicago', notes: 'Street address and coordinates to confirm with owner.' },
    { property_id: 2, name: 'Quality Suites Fargo West Acres', city: 'Fargo', state: 'North Dakota', timezone: 'America/Chicago', notes: 'Street address and coordinates to confirm with owner.' },
  ];
  const insertLocation = db.prepare('INSERT INTO locations (property_id,name,city,state,timezone,notes) VALUES (@property_id,@name,@city,@state,@timezone,@notes)');
  const insertCategory = db.prepare('INSERT INTO room_categories (location_id,name,tier,room_type,description,base_price,min_rate,max_rate,max_step,bed_type,max_guests,room_size_sqft,amenities) VALUES (@location_id,@name,@tier,@room_type,@description,@base_price,@min_rate,@max_rate,@max_step,@bed_type,@max_guests,@room_size_sqft,@amenities)');
  const insertRoom = db.prepare('INSERT INTO rooms (category_id,room_number,floor,status) VALUES (?,?,?,?)');
  for (const location of locations) {
    const result = insertLocation.run(location);
    const categories = location.property_id === 1 ? [
      { name: 'Standard King', tier: 'Basic', room_type: 'King', description: 'Base king room category · details to confirm', base_price: 112, min_rate: 79, max_rate: 189, max_step: 25, bed_type: '1 King', max_guests: 2, room_size_sqft: 300, amenities: ['Wi-Fi', 'Breakfast · confirm', 'Free parking · confirm'], rooms: ['101','102','103','104','105','106','107','108'] },
      { name: 'Double Queen', tier: 'Standard', room_type: 'Two Queen', description: 'Two queen bed category · seeded example', base_price: 121, min_rate: 85, max_rate: 199, max_step: 25, bed_type: '2 Queen', max_guests: 4, room_size_sqft: 330, amenities: ['Wi-Fi', 'Breakfast · confirm', 'Free parking · confirm'], rooms: ['109','110','111','112'] },
    ] : [
      { name: 'Standard Suite', tier: 'Basic', room_type: 'King Suite', description: 'Base suite category · details to confirm', base_price: 128, min_rate: 89, max_rate: 219, max_step: 30, bed_type: '1 King', max_guests: 4, room_size_sqft: 420, amenities: ['Wi-Fi', 'Breakfast · confirm', 'Sitting area · confirm'], rooms: ['201','202','203','204','205','206'] },
      { name: 'Double Queen Suite', tier: 'Luxury', room_type: 'Two Queen Suite', description: 'Larger suite category · seeded example', base_price: 144, min_rate: 99, max_rate: 239, max_step: 30, bed_type: '2 Queen', max_guests: 6, room_size_sqft: 480, amenities: ['Wi-Fi', 'Breakfast · confirm', 'Sitting area · confirm', 'Pool access · confirm'], rooms: ['207','208','209','210'] },
    ];
    for (const category of categories) {
      const roomNumbers = category.rooms; delete category.rooms;
      const cat = insertCategory.run({ ...category, location_id: result.lastInsertRowid, amenities: JSON.stringify(category.amenities) });
      for (const number of roomNumbers) insertRoom.run(cat.lastInsertRowid, number, number[0], 'Ready');
    }
  }
}

// Add realistic room types to databases created by earlier demo versions.
// This migration is idempotent and never replaces owner-edited categories.
function seedExpandedRoomInventory() {
  const locationRows=db.prepare('SELECT * FROM locations ORDER BY id').all();
  const insertCategory=db.prepare('INSERT INTO room_categories (location_id,name,tier,room_type,description,base_price,min_rate,max_rate,max_step,bed_type,max_guests,room_size_sqft,amenities,image_url,image_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertRoom=db.prepare('INSERT OR IGNORE INTO rooms (category_id,room_number,floor,status,notes) VALUES (?,?,?,?,?)');
  const specsByProperty={
    1:[
      {name:'Accessible Queen',tier:'Accessible',type:'Queen',description:'Accessible room with a queen bed; verify accessibility features with the property.',base:118,min:79,max:189,step:20,beds:'1 Queen',guests:2,size:320,amenities:['Wi-Fi','Accessible bathroom · confirm','Free parking · confirm'],rooms:['113','114','115']},
      {name:'Premium King',tier:'Comfort',type:'King',description:'King room with upgraded location or finish; confirm amenities.',base:132,min:89,max:209,step:25,beds:'1 King',guests:2,size:340,amenities:['Wi-Fi','Breakfast · confirm','Premium view · confirm'],rooms:['116','117','118']},
    ],
    2:[
      {name:'Accessible King Suite',tier:'Accessible',type:'King Suite',description:'Accessible suite with separate sitting area; verify property details.',base:139,min:95,max:229,step:25,beds:'1 King',guests:4,size:440,amenities:['Wi-Fi','Accessible bathroom · confirm','Sitting area · confirm'],rooms:['211','212','213']},
      {name:'Family Suite',tier:'Deluxe',type:'Family Suite',description:'Larger suite for families; confirm bedding and occupancy limits.',base:159,min:109,max:259,step:30,beds:'2 Queen + sofa bed · confirm',guests:6,size:520,amenities:['Wi-Fi','Breakfast · confirm','Sitting area · confirm','Pool access · confirm'],rooms:['214','215','216']},
    ],
  };
  const createExtras=db.transaction(()=>{
    for(const location of locationRows){
      const specs=specsByProperty[location.property_id]||[];
      for(const spec of specs){
        let category=db.prepare('SELECT * FROM room_categories WHERE location_id=? AND name=?').get(location.id,spec.name);
        if(!category){
          const result=insertCategory.run(location.id,spec.name,spec.tier,spec.type,spec.description,spec.base,spec.min,spec.max,spec.step,spec.beds,spec.guests,spec.size,JSON.stringify(spec.amenities),'','');
          category=db.prepare('SELECT * FROM room_categories WHERE id=?').get(result.lastInsertRowid);
        }
        spec.rooms.forEach((number,index)=>insertRoom.run(category.id,number,number[0],index===2?'Maintenance':'Ready',index===2?'Seeded maintenance example; update after owner confirmation':''));
      }
    }
  });
  createExtras();
  const fillInventory=db.transaction(()=>{
    const targets={1:70,2:50};
    for(const location of locationRows){
      const target=targets[location.property_id]; if(!target)continue;
      const categories=db.prepare('SELECT id FROM room_categories WHERE location_id=? ORDER BY id').all(location.id);
      let total=db.prepare('SELECT COUNT(*) count FROM rooms r JOIN room_categories c ON c.id=r.category_id WHERE c.location_id=?').get(location.id).count;
      let number=301;
      while(total<target){
        const category=categories[(total)%categories.length];
        const roomNo=String(number++);
        if(db.prepare('SELECT 1 FROM rooms r JOIN room_categories c ON c.id=r.category_id WHERE c.location_id=? AND r.room_number=?').get(location.id,roomNo))continue;
        insertRoom.run(category.id,roomNo,roomNo[0],'Ready','Seeded demo inventory');total++;
      }
    }
  });
  fillInventory();
  const demoImages={
    'Standard King':['https://images.trvl-media.com/lodging/1000000/330000/327400/327372/0bb62eed.jpg?impolicy=resizecrop&ra=fill&rh=575&rw=575','https://www.hotels.com/ho153112/comfort-inn-duncansville-altoona-duncansville-united-states-of-america/'],
    'Double Queen':['https://images.trvl-media.com/lodging/18000000/17140000/17137400/17137367/3d7725eb.jpg?impolicy=resizecrop&ra=fill&rh=575&rw=575','https://www.expedia.ca/New-York-Hotels-The-Watson-Hotel.h17137367.Hotel-Information'],
    'Accessible Queen':['https://images.mirai.com/INFOROOMS/100379307/YE3MCUPRTpGKCyUccG2M/YE3MCUPRTpGKCyUccG2M_original.jpg','https://www.extendedsuites.com.mx/hotel-extended-suites-monterrey-aeropuerto/habitaciones/suite-minusvalidos-69250/'],
    'Premium King':['https://images.bestwestern.com/bwi/brochures/10380/photos/1024/29628152.jpg','https://www.bestwestern.com/en_US/book/hotel-rooms.10380.html'],
    'Standard Suite':['https://www.keioplaza.co.jp/images/corporate/sdgs/certification/certification08.jpg','https://www.keioplaza.co.jp/en/corporate/sdgs/certification/'],
    'Double Queen Suite':['https://www.parksleephotels.com/am-images/154136544164.png','https://www.parksleephotels.com/country-inn-suites-dearborn-am-243.html'],
    'Accessible King Suite':['https://images.mirai.com/INFOROOMS/100379307/YE3MCUPRTpGKCyUccG2M/YE3MCUPRTpGKCyUccG2M_original.jpg','https://www.extendedsuites.com.mx/hotel-extended-suites-monterrey-aeropuerto/habitaciones/suite-minusvalidos-69250/'],
    'Family Suite':['https://assets.simpleviewinc.com/simpleview/image/upload/crm/kansas/Sonesta-Essential-Hotel-Overland-Park-Room-copy_0CACD866-BC91-464A-D05A1E940A8F7B17-0cacd51ea1cfd23_47a42e89-ca3a-5a11-43403f8bc848e002.png','https://www.travelks.com/listing/sonesta-essential-hotels-overland-park/2041/'],
  };
  const setImage=db.prepare('UPDATE room_categories SET image_url=?,image_source=? WHERE name=? AND (image_url IS NULL OR image_url=\'\')');
  for(const [name,[url,source]] of Object.entries(demoImages))setImage.run(url,source,name);
  // Older databases already have reservations; add examples for each newly seeded category.
  const insertBooking=db.prepare(`INSERT OR IGNORE INTO bookings (confirmation_code,property_id,location_id,category_id,room_id,reservation_source,booking_status,payment_status,booking_date,check_in,check_out,guest_name,guest_email,guest_phone,adults,children,room_count,rate_per_night,nights,room_subtotal,discount_amount,tax_rate,tax_amount,fees_amount,total_amount,advance_amount,currency,special_requests) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertTxn=db.prepare('INSERT INTO payment_transactions (location_id,property_id,booking_id,transaction_date,type,method,channel,amount,status,reference,category,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const today=new Date(`${hotelTodayString()}T12:00:00`);
  const addReservations=db.transaction(()=>{
    for(const location of locationRows){
      const property=db.prepare('SELECT * FROM properties WHERE id=?').get(location.property_id);
      const extras=db.prepare("SELECT * FROM room_categories WHERE location_id=? AND name IN ('Accessible Queen','Premium King','Accessible King Suite','Family Suite') ORDER BY id").all(location.id);
      extras.forEach((category,index)=>{
        if(db.prepare('SELECT 1 FROM bookings WHERE category_id=? LIMIT 1').get(category.id))return;
        const rooms=db.prepare("SELECT * FROM rooms WHERE category_id=? AND status='Ready' ORDER BY room_number").all(category.id);
        for(let j=0;j<3;j++){
          const offset=[-4,2,12][j],checkIn=new Date(today);checkIn.setDate(today.getDate()+offset);const nights=j===2?2:1;const checkOut=new Date(checkIn);checkOut.setDate(checkIn.getDate()+nights);const bookingDate=new Date(checkIn);bookingDate.setDate(checkIn.getDate()-(3+j));
          const status=j===0?'Checked out':j===1?'Confirmed':'Pending';const rate=category.base_price+(j*5);const subtotal=rate*nights;const tax=Math.round(subtotal*0.095*100)/100;const fee=j===2?8:0;const total=Math.round((subtotal+tax+fee)*100)/100;const advance=j===0?total:Math.round(total*0.3*100)/100;const method=['Cash','Booking.com collect','Online card'][(index+j)%3];const channel=['Cash','Card present'].includes(method)?'Offline':'Online';const code=`EX${location.property_id}X${String(category.id).padStart(3,'0')}${j+1}`;
          const room=rooms[j%Math.max(1,rooms.length)];
          const result=insertBooking.run(code,location.property_id,location.id,category.id,room?.id||null,['Walk-in','Booking.com','Direct website'][j],status,advance>=total?'Paid':advance?'Partially paid':'Unpaid',bookingDate.toISOString().slice(0,10),checkIn.toISOString().slice(0,10),checkOut.toISOString().slice(0,10),['Morgan Carter','Jamie Brooks','Riley Patel'][j],`roomseed${category.id}${j}@example.demo`,`+1 701 555 ${String(2400+category.id*10+j)}`,j===2?2:1,j===2?1:0,1,rate,nights,subtotal,0,9.5,tax,fee,total,advance,'USD',j===2?'Seeded family room request':'' );
          if(advance>0)insertTxn.run(location.id,property.id,result.lastInsertRowid,bookingDate.toISOString().slice(0,10),'Receipt',method,channel,advance,'Posted',`PAY-${code}`,'Advance / room payment','Added for category inventory demo');
        }
      });
    }
  });
  addReservations();
}

function seedBookingsAndRevenue() {
  const locations = db.prepare('SELECT * FROM locations ORDER BY id').all();
  const insertBooking = db.prepare(`INSERT INTO bookings (confirmation_code,property_id,location_id,category_id,room_id,reservation_source,booking_status,payment_status,booking_date,check_in,check_out,guest_name,guest_email,guest_phone,adults,children,room_count,rate_per_night,nights,room_subtotal,discount_amount,tax_rate,tax_amount,fees_amount,total_amount,advance_amount,currency,special_requests) VALUES (@confirmation_code,@property_id,@location_id,@category_id,@room_id,@reservation_source,@booking_status,@payment_status,@booking_date,@check_in,@check_out,@guest_name,@guest_email,@guest_phone,@adults,@children,@room_count,@rate_per_night,@nights,@room_subtotal,@discount_amount,@tax_rate,@tax_amount,@fees_amount,@total_amount,@advance_amount,@currency,@special_requests)`);
  const insertTxn = db.prepare('INSERT INTO payment_transactions (location_id,property_id,booking_id,transaction_date,type,method,channel,amount,status,reference,category,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const today = new Date(`${hotelTodayString()}T12:00:00`);
  const offsets = [-28,-22,-16,-10,-2,0,5,10,15,20,25,28];
  const sources = ['Walk-in','Phone','Direct website','Booking.com','Expedia','Agoda','Hotels.com','Brand website','Corporate / group','Walk-in','Booking.com','Direct website'];
  const guests = ['Jamie Carter','Morgan Lee','Taylor Brooks','Jordan Patel','Casey Morgan','Riley Anderson','Avery Thompson','Drew Walker','Quinn Martinez','Skylar Davis','Reese Johnson','Cameron Wilson'];
  const methods = ['Cash','Card present','Bank transfer','Booking.com collect','Expedia Collect','Online card','Card present','Online card','Bank transfer','Cash','Booking.com collect','Online card'];
  const percentages = [0,0.25,0.5,1,0.3,0.5,1,0.2,0.5,1,0.25,0.75];
  for (const location of locations) {
    const categories = db.prepare('SELECT * FROM room_categories WHERE location_id=? ORDER BY id').all(location.id);
    const property = db.prepare('SELECT * FROM properties WHERE id=?').get(location.property_id);
    offsets.forEach((offset,index) => {
      const category=categories[index%categories.length];
      const room=db.prepare('SELECT * FROM rooms WHERE category_id=? ORDER BY room_number LIMIT 1 OFFSET ?').get(category.id,Math.floor(index/categories.length));
      const checkIn=new Date(today);checkIn.setDate(today.getDate()+offset);
      const nights=1+(index%3===0?2:index%4===0?1:0);
      const checkOut=new Date(checkIn);checkOut.setDate(checkIn.getDate()+nights);
      const bookingDate=new Date(checkIn);bookingDate.setDate(checkIn.getDate()-(2+(index%10)));
      let bookingStatus=offset<0?'Checked out':'Confirmed';
      if(index===1)bookingStatus='Cancelled';
      if(index===3)bookingStatus='No-show';
      if(index===5)bookingStatus='Checked in';
      const rate=category.base_price + (index%4)*4;
      const subtotal=rate*nights;
      const discount=index%5===0?Math.round(subtotal*.05*100)/100:0;
      const taxable=Math.max(0,subtotal-discount);
      const taxRate=9.5; // Illustrative demo rate; property must configure jurisdiction-specific tax rules.
      const tax=Math.round(taxable*taxRate)/100;
      const fees=index%4===0?8:0;
      const total=Math.round((taxable+tax+fees)*100)/100;
      let advance=Math.round(total*percentages[index]*100)/100;
      if(bookingStatus==='Cancelled')advance=Math.round(total*.25*100)/100;
      const paymentStatus=advance<=0?'Unpaid':advance>=total?'Paid':'Partially paid';
      const method=methods[index];
      const channel=['Cash','Card present'].includes(method)?'Offline':'Online';
      const code=`EX${location.property_id}${String(index+1).padStart(3,'0')}`;
      const bookingResult=insertBooking.run({confirmation_code:code,property_id:location.property_id,location_id:location.id,category_id:category.id,room_id:room?.id||null,reservation_source:sources[index],booking_status:bookingStatus,payment_status:paymentStatus,booking_date:bookingDate.toISOString().slice(0,10),check_in:checkIn.toISOString().slice(0,10),check_out:checkOut.toISOString().slice(0,10),guest_name:guests[index],guest_email:`guest${index+1}@example.demo`,guest_phone:`+1 701 555 ${String(1000+location.id*100+index).slice(-4)}`,adults:index%3===0?2:1,children:index%5===0?1:0,room_count:1,rate_per_night:rate,nights,room_subtotal:subtotal,discount_amount:discount,tax_rate:taxRate,tax_amount:tax,fees_amount:fees,total_amount:total,advance_amount:advance,currency:'USD',special_requests:index%4===0?'Late arrival · sample request':''});
      if(advance>0){
        const refund=bookingStatus==='Cancelled'?Math.round(advance*.5*100)/100:0;
        insertTxn.run(location.id,location.property_id,bookingResult.lastInsertRowid,bookingDate.toISOString().slice(0,10),'Receipt',method,channel,advance,'Posted',`PAY-${code}`,'Advance / room payment','Seeded demo payment; no card details stored');
        if(refund>0){const refundDate=new Date(today);refundDate.setDate(today.getDate()-1);insertTxn.run(location.id,location.property_id,bookingResult.lastInsertRowid,refundDate.toISOString().slice(0,10),'Refund',method,channel,refund,'Posted',`REF-${code}`,'Cancellation refund','Seeded demo refund');}
      }
    });
    const openingDate=new Date(today);openingDate.setDate(today.getDate()-40);
    insertTxn.run(location.id,location.property_id,null,openingDate.toISOString().slice(0,10),'Opening balance','Cash','Offline',location.property_id===1?1300:1200,'Posted',`OPEN-${location.id}`,'Cash drawer','Illustrative starting cash balance');
    for(let day=3;day<=30;day+=7){const date=new Date(today);date.setDate(today.getDate()-day);insertTxn.run(location.id,location.property_id,null,date.toISOString().slice(0,10),'Expense','Cash','Offline',25+(day%3)*8,'Posted',`CASH-${location.id}-${day}`,'Housekeeping / petty cash','Sample cash expense for reconciliation demo');}
    const depositDate=new Date(today);depositDate.setDate(today.getDate()-6);insertTxn.run(location.id,location.property_id,null,depositDate.toISOString().slice(0,10),'Cash deposit','Cash','Offline',location.property_id===1?180:120,'Posted',`DEP-${location.id}`,'Bank deposit','Illustrative cash deposit to bank');
  }
}

function seedRecommendationsData(properties, start = new Date()) {
  const recommendations = [];
  start = new Date(start); start.setHours(0, 0, 0, 0);
  const special = [3, 8, 11, 17, 21, 26];
  for (const p of properties) for (let i = -15; i < 14; i++) {
    const date = new Date(start); date.setDate(start.getDate() + i + 1);
    const weekday = date.getDay();
    const event = special.includes(i);
    const demand = Math.round(Math.min(94, Math.max(39, 58 + Math.sin(i / 4.3) * 13 + (weekday === 5 || weekday === 6 ? 13 : 0) + (event ? 12 : 0) + (p.id === 1 ? 2 : -3))) * 10) / 10;
    const current = Math.round((p.id === 1 ? 112 : 128) + (weekday === 5 || weekday === 6 ? 9 : 0) + Math.sin(i / 5) * 6);
    const suggested = Math.round(Math.max(p.id === 1 ? 79 : 89, Math.min(p.id === 1 ? 189 : 219, current + (demand > 79 ? 12 : demand > 66 ? 5 : demand < 51 ? -8 : 0) + (event ? 7 : 0))));
    const competitor = Math.round((p.id === 1 ? 116 : 124) + Math.sin(i / 3.7) * 12 + (weekday === 5 || weekday === 6 ? 8 : 0));
    const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const onBooks = Math.max(0, Math.min(p.rooms, Math.round(p.rooms * Math.max(26, Math.min(92, demand - 8)) / 100)));
    const previousOccupancy = Math.max(20, demand - 12 - (i % 4));
    const pickup = Math.max(-2, Math.round((demand - 8 - previousOccupancy) * p.rooms / 100));
    const leadTime = Math.max(1, Math.round((date - start) / 86400000));
    const historicalAdr = Math.round(p.adr + Math.sin((date.getMonth() + 1) / 2) * 5);
    const historicalOccupancy = Math.round(Math.min(90, Math.max(42, p.occupancy + Math.sin(i / 6) * 7)) * 10) / 10;
    const roomRevenue = Math.round(historicalAdr * historicalOccupancy / 100 * p.rooms);
    const sellableRooms = Math.max(1, p.rooms - (i % 13 === 5 ? 2 : 0));
    const bookedRooms = Math.min(sellableRooms, onBooks);
    const cancellationRate = Math.round((3 + ((i + p.id) % 7) * 0.7) * 10) / 10;
    const noShowRate = Math.round((1 + ((i + p.id * 2) % 4) * 0.4) * 10) / 10;
    const channelMix = { direct: 34 + (i % 4) * 2, brand: 26, ota: 30 - (i % 4) * 2, other: 10 };
    const channelCost = Math.round((channelMix.ota * 0.17 + channelMix.brand * 0.05) * 10) / 10;
    const competitorAvailability = i % 9 === 0 ? 'Not confirmed' : 'Available · sample';
    const competitorMatch = i % 9 === 0 ? 'Partial match' : 'Date/room/terms · sample';
    const competitiveIndex = Math.round(current / competitor * 1000) / 10;
    const eventIntensity = event ? 72 + (i % 3) * 8 : 0;
    const eventDistance = event ? 3.4 + (i % 4) * 1.2 : null;
    const weatherSeverity = i % 11 === 4 ? 'Watch · sample' : 'No severe alert · sample';
    const weatherConfidence = i % 11 === 4 ? 64 : 81;
    const amenities = p.id === 1 ? ['Breakfast', 'Free parking', 'Wi-Fi'] : ['Suite rooms', 'Breakfast', 'Pool · confirm'];
    const roomClass = 'Standard / base room · demo';
    const positioning = p.id === 1 ? 'Travelodge · economy select' : 'Quality Suites · suite positioning';
    const outOfOrder = i % 13 === 5 ? 2 : 0;
    const floor = p.id === 1 ? 79 : 89;
    const ceiling = p.id === 1 ? 189 : 219;
    const maxStep = p.id === 1 ? 25 : 30;
    const unconstrained = current + (demand > 79 ? 12 : demand > 66 ? 5 : demand < 51 ? -8 : 0) + (event ? 7 : 0);
    const guardrailApplied = suggested !== unconstrained || suggested <= floor || suggested >= ceiling;
    const confidence = Math.round(77 + (i % 6) * 3 - (event ? 4 : 0) - (i % 9 === 0 ? 7 : 0));
    const factors = {
      historical: { adr: historicalAdr, occupancy: historicalOccupancy, revpar: Math.round(historicalAdr * historicalOccupancy / 100 * 100) / 100, roomRevenue, roomRevenueBasis: 'Excluding tax · demo accounting basis', source: 'Seeded historical performance' },
      demand: { onBooksRooms: bookedRooms, sellableRooms, occupancy: Math.round(bookedRooms / sellableRooms * 1000) / 10, forecastOccupancy: demand, forecastRooms: Math.round(sellableRooms * demand / 100), remainingRooms: sellableRooms - bookedRooms, source: 'Seeded PMS / inventory snapshot' },
      pace: { pickupRooms: pickup, priorSnapshotOccupancy: previousOccupancy, daysSincePriorSnapshot: 1, leadTimeDays: leadTime, lengthOfStayNights: 1 + (i % 4), cancellationPickupRooms: 0, source: 'Synthetic daily snapshot history · not client history' },
      cancellations: { cancellationRate, noShowRate, note: 'Separate demo estimates; not used as reliable client observations', source: 'Synthetic sample' },
      market: { competitorRate: competitor, competitiveIndex, availability: competitorAvailability, matchedTerms: competitorMatch, sampleHotels: 4 + (i % 2), collectedAt: `${new Date().toISOString().slice(0, 10)}T06:30:00Z`, freshnessMinutes: 45 + (i % 5) * 20, source: 'Illustrative comp-set sample · not a live quote' },
      calendar: { dayOfWeek: date.toLocaleDateString('en-US', { weekday: 'long' }), season: date.getMonth() >= 10 || date.getMonth() <= 1 ? 'Winter' : 'Fall', specialEvent: event ? 'Regional event · sample' : 'No configured event', eventIntensity, eventDistanceMiles: eventDistance, eventConfidence: event ? 67 : null, source: 'Calendar rule + sample event context' },
      weather: { severity: weatherSeverity, confidence: weatherConfidence, source: 'Illustrative local weather context' },
      channels: { mix: channelMix, commissionEstimatePct: channelCost, netRateEstimate: Math.round(current * (1 - channelCost / 100)), source: 'Illustrative mix and commission assumptions' },
      property: { brand: p.brand, positioning, roomClass, roomClassOffset: 0, amenities, amenitiesMapped: false, source: 'Property profile · amenities require confirmation' },
      capacity: { physicalRooms: p.rooms, outOfOrderRooms: outOfOrder, sellableRooms, oversellOptimizationEnabled: false, source: 'Seeded inventory rule · demo' },
      guardrails: { floor, ceiling, maxRateChange: maxStep, changeApplied: suggested - current, constrained: guardrailApplied, rateParityConstraint: 'Not configured', excludedDates: false, approvalPolicy: 'Owner approval required', source: 'Demo property constraints; replace with owner-approved values' },
      uncertainty: { confidence, bandLow: Math.max(floor, suggested - (14 + (100 - confidence) * 0.4)), bandHigh: Math.min(ceiling, suggested + (14 + (100 - confidence) * 0.4)), forecastUncertaintyPct: 100 - confidence, dataFreshnessMinutes: 60, dataFreshness: 'Demo snapshot · recent', sourceQuality: i % 9 === 0 ? 'Partial market match' : 'Seeded complete fields', recommendationPublishable: false, reasons: ['Illustrative model only', ...(i % 9 === 0 ? ['Competitor match incomplete'] : []), 'No client source data validated'] },
      priceResponse: { elasticity: -0.8, status: 'Illustrative assumption · validate before use', note: 'Requires sufficient history and validated price-response analysis' },
      decision: { currentRate: current, ratePlan: 'Standard', source: 'Seeded current/base rate' },
      recommendation: { method: 'Transparent demand baseline + calendar/market sample adjustments + rate constraints', demandSignal: demand > 79 ? 'High' : demand < 51 ? 'Soft' : 'Steady', marketAdjustment: competitor > current ? 'Below sample market rate' : 'At/above sample market rate', eventAdjustment: event ? '+$7 illustrative event adjustment' : '$0 event adjustment', optimization: 'Expected net room revenue objective is a future stage; this demo does not claim revenue optimization' },
    };
    const drivers = [
      `Historical performance: ADR ${historicalAdr}, occupancy ${historicalOccupancy}%`,
      `Demand forecast: ${demand}% · ${sellableRooms - bookedRooms} rooms remain`,
      `Booking pace: ${pickup >= 0 ? '+' : ''}${pickup} rooms since prior demo snapshot · ${leadTime}-day lead time`,
      ...(cancellationRate > 7 ? [`Cancellation estimate: ${cancellationRate}%`] : []),
      ...(event ? ['Regional event context · illustrative sample'] : []),
      competitor > current ? ['Current rate below sample market reference'] : ['Current rate at/above sample market reference'],
      ...(guardrailApplied ? ['Property rate guardrail applied'] : []),
      'Recommendation confidence reduced by sample-data limitations',
    ];
    recommendations.push({ id: recommendations.length + 1, property_id: p.id, stay_date: date.toISOString().slice(0, 10), day_label: label, current_rate: current, recommended_rate: suggested, occupancy: Math.max(26, Math.min(92, Math.round(demand - 8))), forecast_occupancy: demand, competitor_rate: competitor, confidence, drivers: JSON.stringify(drivers), factors: JSON.stringify(factors), status: date < start ? 'Approved' : 'Pending' });
  }
  return recommendations;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET || 'exora-local-demo-secret-change-before-deploy';
const DEMO_EMAIL = process.env.DEMO_EMAIL || 'owner@exora.demo';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'exora-demo';

function cashEffect(type, amount) {
  if (type === 'Receipt' || type === 'Cash withdrawal' || type === 'Opening balance' || type === 'Adjustment') return Number(amount);
  if (type === 'Refund' || type === 'Expense' || type === 'Cash deposit') return -Number(amount);
  return 0;
}

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (email !== DEMO_EMAIL || password !== DEMO_PASSWORD) return res.status(401).json({ error: 'Email or password is incorrect.' });
  const token = jwt.sign({ sub: 'owner-1', email, role: 'owner' }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { name: 'Alex Morgan', role: 'Owner', email } });
});

function auth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Please sign in to continue.' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Your session has expired. Please sign in again.' }); }
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok', mode: 'demo', database: 'sqlite' }));
app.use('/api', auth);

app.get('/api/overview', (_req, res) => {
  const properties = db.prepare('SELECT * FROM properties ORDER BY id').all();
  const metrics = db.prepare(`SELECT property_id,day,revenue,occupancy,adr,rooms_sold FROM daily_metrics WHERE day >= date('now','-13 days') ORDER BY day,property_id`).all();
  const alertCount = db.prepare("SELECT COUNT(*) AS count FROM alerts WHERE status='Open'").get().count;
  const pendingCount = db.prepare("SELECT COUNT(*) AS count FROM recommendations WHERE status='Pending'").get().count;
  const today = properties.reduce((sum, p) => sum + p.revenue, 0);
  res.json({ properties, metrics, alerts: alertCount, pending: pendingCount, today, demo: true });
});

app.get('/api/properties', (_req, res) => res.json(db.prepare('SELECT * FROM properties ORDER BY id').all()));
app.get('/api/room-management', (_req, res) => {
  const properties = db.prepare('SELECT id,name,brand,franchisor,system,city,state,rooms FROM properties ORDER BY id').all();
  const locations = db.prepare('SELECT * FROM locations ORDER BY id').all().map(location => {
    const categories = db.prepare('SELECT * FROM room_categories WHERE location_id=? ORDER BY id').all(location.id).map(category => ({
      ...category,
      amenities: JSON.parse(category.amenities || '[]'),
      rooms: db.prepare('SELECT * FROM rooms WHERE category_id=? ORDER BY room_number').all(category.id),
    }));
    return { ...location, categories };
  });
  res.json({ properties, locations });
});
app.get('/api/booking-management', (_req, res) => {
  const properties=db.prepare('SELECT id,name,brand,city,state FROM properties ORDER BY id').all();
  const locations=db.prepare('SELECT * FROM locations ORDER BY id').all().map(location=>({...location,categories:db.prepare('SELECT * FROM room_categories WHERE location_id=? ORDER BY name').all(location.id).map(category=>({...category,amenities:JSON.parse(category.amenities||'[]'),rooms:db.prepare('SELECT * FROM rooms WHERE category_id=? ORDER BY room_number').all(category.id)}))}));
  const bookings=db.prepare(`SELECT b.*,c.name AS category_name,c.room_type,r.room_number FROM bookings b JOIN room_categories c ON c.id=b.category_id LEFT JOIN rooms r ON r.id=b.room_id ORDER BY b.check_in,b.id DESC`).all();
  res.json({properties,locations,bookings});
});
app.post('/api/bookings', (req,res)=>{
  const b=req.body||{};const location=db.prepare('SELECT * FROM locations WHERE id=?').get(Number(b.location_id));
  if(!location)return res.status(400).json({error:'Select a valid location first.'});
  const category=db.prepare('SELECT * FROM room_categories WHERE id=? AND location_id=?').get(Number(b.category_id),location.id);
  if(!category)return res.status(400).json({error:'Select a room category from this location.'});
  if(!String(b.guest_name||'').trim()||!b.check_in||!b.check_out)return res.status(400).json({error:'Booker name and stay dates are required.'});
  const checkIn=new Date(`${b.check_in}T12:00:00`),checkOut=new Date(`${b.check_out}T12:00:00`),nights=Math.round((checkOut-checkIn)/86400000);
  if(!Number.isFinite(nights)||nights<1)return res.status(400).json({error:'Check-out must be after check-in.'});
  const roomId=b.room_id?Number(b.room_id):null;
  if(roomId&&Number(b.room_count)>1)return res.status(400).json({error:'Assign one numbered room per booking. For multiple rooms, leave room assignment open and add the room numbers after splitting the reservation.'});
  if(roomId){
    const room=db.prepare('SELECT * FROM rooms WHERE id=? AND category_id=?').get(roomId,category.id);
    if(!room)return res.status(400).json({error:'Choose a room belonging to this category.'});
    if(room.status!=='Ready')return res.status(409).json({error:`Room ${room.room_number} is ${room.status.toLowerCase()} and cannot be booked.`});
    const conflict=db.prepare(`SELECT confirmation_code FROM bookings WHERE room_id=? AND booking_status NOT IN ('Cancelled','No-show') AND check_in < ? AND check_out > ?`).get(roomId,b.check_out,b.check_in);
    if(conflict)return res.status(409).json({error:`This room is already booked for those dates (${conflict.confirmation_code}).`});
  }
  const roomCount=Math.max(1,Math.min(10,Number(b.room_count)||1));
  const rate=Number(b.rate_per_night)||category.base_price;
  const subtotal=Math.round(rate*nights*roomCount*100)/100;
  const discount=Math.max(0,Math.min(subtotal,Number(b.discount_amount)||0));
  const taxRate=Math.max(0,Math.min(30,Number(b.tax_rate)||0));
  const tax=Math.round((subtotal-discount)*taxRate)/100;
  const fees=Math.max(0,Number(b.fees_amount)||0);
  const total=Math.round((subtotal-discount+tax+fees)*100)/100;
  const advance=Math.max(0,Math.min(total,Number(b.advance_amount)||0));
  const paymentStatus=advance<=0?'Unpaid':advance>=total?'Paid':'Partially paid';
  const status=['Pending','Confirmed','Checked in'].includes(b.booking_status)?b.booking_status:'Confirmed';
  const sources=['Walk-in','Phone','Direct website','Brand website','Booking.com','Expedia','Agoda','Hotels.com','Corporate / group','Travel agent','Other OTA','Other'];
  const source=sources.includes(b.reservation_source)?b.reservation_source:'Other';
  const code=`EX-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random()*90+10)}`;
  const property=db.prepare('SELECT id FROM properties WHERE id=?').get(location.property_id);
  const booking=db.prepare(`INSERT INTO bookings (confirmation_code,property_id,location_id,category_id,room_id,reservation_source,booking_status,payment_status,booking_date,check_in,check_out,guest_name,guest_email,guest_phone,adults,children,room_count,rate_per_night,nights,room_subtotal,discount_amount,tax_rate,tax_amount,fees_amount,total_amount,advance_amount,special_requests) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(code,property.id,location.id,category.id,roomId,source,status, paymentStatus,hotelTodayString(),b.check_in,b.check_out,String(b.guest_name).trim(),b.guest_email||'',b.guest_phone||'',Math.max(1,Number(b.adults)||1),Math.max(0,Number(b.children)||0),roomCount,rate,nights,subtotal,discount,taxRate,tax,fees,total,advance,b.special_requests||'');
  if(advance>0){const method=b.payment_method||'Cash';const channel=['Cash','Card present'].includes(method)?'Offline':'Online';db.prepare('INSERT INTO payment_transactions (location_id,property_id,booking_id,transaction_date,type,method,channel,amount,status,reference,category,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(location.id,property.id,booking.lastInsertRowid,hotelTodayString(),'Receipt',method,channel,advance,'Posted',b.payment_reference||code,'Advance / room payment','Booking advance payment');}
  db.prepare('INSERT INTO activity (action,detail) VALUES (?,?)').run('Booking created',`${code} · ${String(b.guest_name).trim()} · ${location.name}`);
  res.status(201).json({id:Number(booking.lastInsertRowid),confirmation_code:code,nights,subtotal,tax,fees,total,advance,payment_status:paymentStatus});
});
app.patch('/api/bookings/:id', (req,res)=>{
  const id=Number(req.params.id),booking=db.prepare('SELECT * FROM bookings WHERE id=?').get(id);if(!booking)return res.status(404).json({error:'Booking not found.'});
  const {booking_status,room_id,special_requests}=req.body||{};
  if(booking_status&&!['Pending','Confirmed','Checked in','Checked out','Cancelled','No-show'].includes(booking_status))return res.status(400).json({error:'Choose a supported booking status.'});
  if(room_id){const room=db.prepare('SELECT * FROM rooms WHERE id=? AND category_id=?').get(Number(room_id),booking.category_id);if(!room)return res.status(400).json({error:'Room must belong to the booking category.'});const conflict=db.prepare(`SELECT confirmation_code FROM bookings WHERE room_id=? AND id!=? AND booking_status NOT IN ('Cancelled','No-show') AND check_in < ? AND check_out > ?`).get(room.id,id,booking.check_out,booking.check_in);if(conflict)return res.status(409).json({error:`Room is already assigned to ${conflict.confirmation_code} for these dates.`});}
  db.prepare('UPDATE bookings SET booking_status=COALESCE(?,booking_status),room_id=COALESCE(?,room_id),special_requests=COALESCE(?,special_requests) WHERE id=?').run(booking_status||null,room_id?Number(room_id):null,special_requests??null,id);
  if(booking_status)db.prepare('INSERT INTO activity (action,detail) VALUES (?,?)').run(`Booking ${booking_status.toLowerCase()}`,`${booking.confirmation_code} · ${booking.guest_name}`);
  res.json({success:true});
});
app.post('/api/ledger', (req,res)=>{
  const t=req.body||{};const location=db.prepare('SELECT * FROM locations WHERE id=?').get(Number(t.location_id));if(!location)return res.status(400).json({error:'Choose a valid location.'});
  const types=['Receipt','Refund','Expense','Cash deposit','Cash withdrawal','Opening balance','Adjustment'];if(!types.includes(t.type))return res.status(400).json({error:'Choose a supported ledger entry type.'});
  const amount=Number(t.amount);if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:'Enter an amount greater than zero.'});
  const method=t.method||'Cash';const channel=['Cash','Card present'].includes(method)?'Offline':'Online';const propertyId=location.property_id;
  const result=db.prepare('INSERT INTO payment_transactions (location_id,property_id,booking_id,transaction_date,type,method,channel,amount,status,reference,category,note) VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?)').run(location.id,propertyId,t.transaction_date||hotelTodayString(),t.type,method,channel,amount,'Posted',t.reference||'',t.category||'Other',t.note||'');
  res.status(201).json({id:Number(result.lastInsertRowid)});
});
app.get('/api/revenue', (req,res)=>{
  const start=String(req.query.start||hotelTodayString());const end=String(req.query.end||start);const locationId=Number(req.query.locationId||0);const categoryId=Number(req.query.categoryId||0);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||start>end)return res.status(400).json({error:'Choose a valid date range.'});
  const bookingFilter=(locationId?' AND b.location_id=?':'')+(categoryId?' AND b.category_id=?':'');const txnFilter=(locationId?' AND t.location_id=?':'')+(categoryId?' AND b.category_id=?':'');const priorFilter=locationId?' AND location_id=?':'';
  if(categoryId&&!db.prepare('SELECT id FROM room_categories WHERE id=? AND location_id=?').get(categoryId,locationId))return res.status(400).json({error:'Choose a room category within the selected location.'});
  const bookingArgs=[end,start,...(locationId?[locationId]:[]),...(categoryId?[categoryId]:[])];
  const stayBookings=db.prepare(`SELECT b.*,l.name AS location_name,c.name AS category_name,r.room_number FROM bookings b JOIN locations l ON l.id=b.location_id JOIN room_categories c ON c.id=b.category_id LEFT JOIN rooms r ON r.id=b.room_id WHERE b.check_in<=? AND b.check_out>?${bookingFilter} ORDER BY b.check_in,b.confirmation_code`).all(...bookingArgs);
  const transactions=db.prepare(`SELECT t.*,l.name AS location_name,b.confirmation_code,b.guest_name FROM payment_transactions t JOIN locations l ON l.id=t.location_id LEFT JOIN bookings b ON b.id=t.booking_id WHERE t.transaction_date BETWEEN ? AND ?${txnFilter} ORDER BY t.transaction_date DESC,t.id DESC`).all(start,end,...(locationId?[locationId]:[]),...(categoryId?[categoryId]:[]));
  const priorTransactions=db.prepare(`SELECT type,method,channel,amount FROM payment_transactions WHERE transaction_date < ?${priorFilter}`).all(start,...(locationId?[locationId]:[]));
  const openingCash=priorTransactions.reduce((sum,t)=>sum+(t.type==='Opening balance'?t.amount:0)+((t.method==='Cash'&&t.type!=='Opening balance')?cashEffect(t.type,t.amount):0),0);
  const sum=(list,predicate,field='amount')=>list.filter(predicate).reduce((total,item)=>total+Number(item[field]||0),0);
  const transactionTotals={
    receipts:sum(transactions,t=>t.type==='Receipt'), advanceReceipts:sum(transactions,t=>t.type==='Receipt'&&String(t.category).toLowerCase().includes('advance')), refunds:sum(transactions,t=>t.type==='Refund'), expenses:sum(transactions,t=>t.type==='Expense'),
    onlineReceipts:sum(transactions,t=>t.type==='Receipt'&&t.channel==='Online'),offlineReceipts:sum(transactions,t=>t.type==='Receipt'&&t.channel==='Offline'),
    cashReceipts:sum(transactions,t=>t.type==='Receipt'&&t.method==='Cash'),cashRefunds:sum(transactions,t=>t.type==='Refund'&&t.method==='Cash'),
    cashExpenses:sum(transactions,t=>t.type==='Expense'&&t.method==='Cash'),cashDeposits:sum(transactions,t=>t.type==='Cash deposit'&&t.method==='Cash'),
    cashWithdrawals:sum(transactions,t=>t.type==='Cash withdrawal'&&t.method==='Cash'),bankMovements:sum(transactions,t=>t.type==='Cash deposit')
  };
  const cashInHand=openingCash+transactions.filter(t=>t.method==='Cash').reduce((total,t)=>total+cashEffect(t.type,t.amount),0);
  const actualFilter=locationId?' AND b.location_id=?':'';
  const actualCatFilter=categoryId?' AND b.category_id=?':'';const actualStays=db.prepare(`SELECT b.* FROM bookings b WHERE b.booking_status='Checked out' AND b.check_out BETWEEN ? AND ?${actualFilter}${actualCatFilter}`).all(start,end,...(locationId?[locationId]:[]),...(categoryId?[categoryId]:[]));
  const actualBeforeTax=sum(actualStays,()=>true,'room_subtotal')-sum(actualStays,()=>true,'discount_amount');
  const actualTax=sum(actualStays,()=>true,'tax_amount');const actualFees=sum(actualStays,()=>true,'fees_amount');
  const actualGross=actualBeforeTax+actualTax+actualFees;
  const bookingValue=stayBookings.filter(b=>!['Cancelled','No-show'].includes(b.booking_status));
  const bookingStats={count:stayBookings.length,cancelled:stayBookings.filter(b=>b.booking_status==='Cancelled').length,noShows:stayBookings.filter(b=>b.booking_status==='No-show').length,confirmed:stayBookings.filter(b=>['Pending','Confirmed','Checked in'].includes(b.booking_status)).length,bookedBeforeTax:sum(bookingValue,()=>true,'room_subtotal')-sum(bookingValue,()=>true,'discount_amount'),bookedTax:sum(bookingValue,()=>true,'tax_amount'),bookedGross:sum(bookingValue,()=>true,'total_amount'),outstanding:sum(bookingValue,()=>true,'total_amount')-sum(bookingValue,()=>true,'advance_amount')};
  const channelBreakdown={};for(const booking of stayBookings){const row=channelBreakdown[booking.reservation_source]||{bookings:0,roomRevenue:0};row.bookings++;if(!['Cancelled','No-show'].includes(booking.booking_status))row.roomRevenue+=booking.room_subtotal;channelBreakdown[booking.reservation_source]=row;}
  const tenderBreakdown={};for(const txn of transactions){const row=tenderBreakdown[txn.method]||{receipts:0,refunds:0,expenses:0};if(txn.type==='Receipt')row.receipts+=txn.amount;if(txn.type==='Refund')row.refunds+=txn.amount;if(txn.type==='Expense')row.expenses+=txn.amount;tenderBreakdown[txn.method]=row;}
  const locations=db.prepare('SELECT id,name,property_id FROM locations ORDER BY name').all().map(l=>({...l,categories:db.prepare('SELECT c.id,c.name,c.base_price,(SELECT COUNT(*) FROM rooms r WHERE r.category_id=c.id AND r.status=\'Ready\') ready_rooms FROM room_categories c WHERE c.location_id=? ORDER BY c.name').all(l.id)}));
  res.json({start,end,locationId,categoryId,actual:{checkoutCount:actualStays.length,roomRevenueBeforeTax:actualBeforeTax,tax:actualTax,fees:actualFees,grossAfterTax:actualGross,nightlyRoomNights:actualStays.reduce((s,b)=>s+b.nights*b.room_count,0)},bookings:bookingStats,transactions:transactionTotals,openingCash,cashInHand,channelBreakdown,tenderBreakdown,ledger:transactions,stayBookings,locations});
});
app.post('/api/locations', (req, res) => {
  const { property_id, name, address='', city='', state='', postal_code='', country='United States', timezone='America/Chicago', latitude=null, longitude=null, notes='' } = req.body || {};
  if (!db.prepare('SELECT id FROM properties WHERE id=?').get(Number(property_id))) return res.status(400).json({ error: 'Choose a property for this location.' });
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Location name is required.' });
  const result = db.prepare('INSERT INTO locations (property_id,name,address,city,state,postal_code,country,timezone,latitude,longitude,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(Number(property_id),String(name).trim(),address,city,state,postal_code,country,timezone,latitude===''?null:latitude,longitude===''?null:longitude,notes);
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});
app.patch('/api/locations/:id', (req, res) => {
  const id=Number(req.params.id), fields=['name','address','city','state','postal_code','country','timezone','latitude','longitude','notes'];
  const current=db.prepare('SELECT * FROM locations WHERE id=?').get(id); if(!current)return res.status(404).json({error:'Location not found.'});
  const values={...current,...req.body}; const sets=fields.filter(k=>k in req.body).map(k=>`${k}=@${k}`);
  if(!sets.length)return res.json({success:true});
  db.prepare(`UPDATE locations SET ${sets.join(',')} WHERE id=@id`).run({...values,id}); res.json({success:true});
});
app.post('/api/locations/:id/duplicate', (req,res)=>{
  const source=db.prepare('SELECT * FROM locations WHERE id=?').get(Number(req.params.id)); if(!source)return res.status(404).json({error:'Location not found.'});
  const propertyId=Number(req.body?.property_id||source.property_id);
  const result=db.prepare('INSERT INTO locations (property_id,name,address,city,state,postal_code,country,timezone,latitude,longitude,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(propertyId,req.body?.name||`${source.name} copy`,source.address,source.city,source.state,source.postal_code,source.country,source.timezone,source.latitude,source.longitude,source.notes);
  const newId=Number(result.lastInsertRowid); const categories=db.prepare('SELECT * FROM room_categories WHERE location_id=?').all(source.id);
  const insert=db.prepare('INSERT INTO room_categories (location_id,name,tier,room_type,description,base_price,min_rate,max_rate,max_step,bed_type,max_guests,room_size_sqft,amenities) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const copy=db.transaction(()=>categories.map(c=>insert.run(newId,c.name,c.tier,c.room_type,c.description,c.base_price,c.min_rate,c.max_rate,c.max_step,c.bed_type,c.max_guests,c.room_size_sqft,c.amenities)));
  copy(); res.status(201).json({id:newId,categoriesCopied:categories.length,roomsCopied:0});
});
app.post('/api/locations/:id/categories', (req,res)=>{
  const locationId=Number(req.params.id); if(!db.prepare('SELECT id FROM locations WHERE id=?').get(locationId))return res.status(404).json({error:'Location not found.'});
  const c=req.body||{}; if(!String(c.name||'').trim())return res.status(400).json({error:'Room category name is required.'});
  const result=db.prepare('INSERT INTO room_categories (location_id,name,tier,room_type,description,base_price,min_rate,max_rate,max_step,bed_type,max_guests,room_size_sqft,amenities,image_url,image_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(locationId,String(c.name).trim(),c.tier||'Standard',c.room_type||'King',c.description||'',Number(c.base_price)||0,Number(c.min_rate)||0,Number(c.max_rate)||0,Number(c.max_step)||0,c.bed_type||'',Number(c.max_guests)||2,Number(c.room_size_sqft)||0,JSON.stringify(Array.isArray(c.amenities)?c.amenities:[]),c.image_url||'',c.image_source||'');
  res.status(201).json({id:Number(result.lastInsertRowid)});
});
app.patch('/api/categories/:id', (req,res)=>{
  const id=Number(req.params.id), c=req.body||{}; if(!db.prepare('SELECT id FROM room_categories WHERE id=?').get(id))return res.status(404).json({error:'Room category not found.'});
  const allowed=['name','tier','room_type','description','base_price','min_rate','max_rate','max_step','bed_type','max_guests','room_size_sqft','image_url','image_source']; const sets=[]; const values={id};
  for(const key of allowed)if(key in c){sets.push(`${key}=@${key}`);values[key]=['base_price','min_rate','max_rate','max_step','max_guests','room_size_sqft'].includes(key)?Number(c[key]):c[key];}
  if('amenities' in c){sets.push('amenities=@amenities');values.amenities=JSON.stringify(Array.isArray(c.amenities)?c.amenities:[]);}
  if(!sets.length)return res.json({success:true}); db.prepare(`UPDATE room_categories SET ${sets.join(',')} WHERE id=@id`).run(values);res.json({success:true});
});
app.post('/api/categories/:id/duplicate', (req,res)=>{
  const source=db.prepare('SELECT * FROM room_categories WHERE id=?').get(Number(req.params.id)); if(!source)return res.status(404).json({error:'Room category not found.'});
  const c=req.body||{}; const result=db.prepare('INSERT INTO room_categories (location_id,name,tier,room_type,description,base_price,min_rate,max_rate,max_step,bed_type,max_guests,room_size_sqft,amenities,image_url,image_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(Number(c.location_id||source.location_id),c.name||`${source.name} copy`,source.tier,source.room_type,source.description,source.base_price,source.min_rate,source.max_rate,source.max_step,source.bed_type,source.max_guests,source.room_size_sqft,source.amenities,source.image_url,source.image_source);
  res.status(201).json({id:Number(result.lastInsertRowid)});
});
app.post('/api/categories/:id/rooms/bulk', (req,res)=>{
  const categoryId=Number(req.params.id); if(!db.prepare('SELECT id FROM room_categories WHERE id=?').get(categoryId))return res.status(404).json({error:'Room category not found.'});
  const rooms=Array.isArray(req.body?.rooms)?req.body.rooms.map(room=>({number:String(room.number||'').trim(),floor:String(room.floor||'1'),notes:String(room.notes||'')})).filter(room=>room.number):[];
  if(!rooms.length)return res.status(400).json({error:'Add at least one room number.'});
  const insert=db.prepare('INSERT OR IGNORE INTO rooms (category_id,room_number,floor,notes) VALUES (?,?,?,?)'); let added=0;
  const add=db.transaction(()=>{for(const room of rooms)added+=insert.run(categoryId,room.number,room.floor,room.notes).changes;});
  add(); res.status(201).json({added,skipped:rooms.length-added});
});
app.patch('/api/rooms/:id', (req,res)=>{
  const id=Number(req.params.id), {status,floor,notes}=req.body||{}; const room=db.prepare('SELECT id FROM rooms WHERE id=?').get(id);if(!room)return res.status(404).json({error:'Room not found.'});
  if(status&&!['Ready','Out of order','Maintenance','Blocked'].includes(status))return res.status(400).json({error:'Choose a supported room status.'});
  const sets=[],values={id};if(status){sets.push('status=@status');values.status=status;}if(floor!==undefined){sets.push('floor=@floor');values.floor=String(floor);}if(notes!==undefined){sets.push('notes=@notes');values.notes=String(notes);}if(sets.length)db.prepare(`UPDATE rooms SET ${sets.join(',')} WHERE id=@id`).run(values);res.json({success:true});
});
app.delete('/api/rooms/:id', (req,res)=>{const result=db.prepare('DELETE FROM rooms WHERE id=?').run(Number(req.params.id));if(!result.changes)return res.status(404).json({error:'Room not found.'});res.json({success:true});});
app.get('/api/recommendations', (req, res) => {
  const propertyId = Number(req.query.propertyId || 0);
  const rows = propertyId ? db.prepare('SELECT * FROM recommendations WHERE property_id=? ORDER BY stay_date').all(propertyId) : db.prepare('SELECT * FROM recommendations ORDER BY stay_date,property_id').all();
  res.json(rows.map(r => ({ ...r, drivers: JSON.parse(r.drivers), factors: JSON.parse(r.factors || '{}') })));
});
app.post('/api/recommendations/:id/recalculate', (req, res) => {
  const id = Number(req.params.id);
  const rec = db.prepare('SELECT * FROM recommendations WHERE id=?').get(id);
  if (!rec) return res.status(404).json({ error: 'Recommendation not found.' });
  try {
    const submitted = req.body?.factors;
    if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) return res.status(400).json({ error: 'Editable factor values are required.' });
    const result = calculateRecommendation(rec, submitted);
    db.prepare('UPDATE recommendations SET current_rate=?,recommended_rate=?,forecast_occupancy=?,confidence=?,factors=?,drivers=?,status=\'Pending\' WHERE id=?')
      .run(result.currentRate, result.recommendedRate, result.forecastOccupancy, result.confidence, JSON.stringify(result.factors), JSON.stringify(result.drivers), id);
    db.prepare('INSERT INTO activity (action,detail) VALUES (?,?)').run('Rate recalculated', `${rec.day_label} · $${result.currentRate} → $${result.recommendedRate} · owner edited factors`);
    const updated = db.prepare('SELECT * FROM recommendations WHERE id=?').get(id);
    res.json({ ...updated, drivers: JSON.parse(updated.drivers), factors: JSON.parse(updated.factors) });
  } catch (error) { res.status(400).json({ error: error.message || 'Could not recalculate this recommendation.' }); }
});
app.patch('/api/recommendations/:id', (req, res) => {
  const id = Number(req.params.id), { status, rate, reason } = req.body || {};
  if (!['Approved', 'Edited', 'Rejected', 'Pending'].includes(status)) return res.status(400).json({ error: 'Invalid recommendation status.' });
  const rec = db.prepare('SELECT * FROM recommendations WHERE id=?').get(id);
  if (!rec) return res.status(404).json({ error: 'Recommendation not found.' });
  const factors = completeRecommendationFactors(JSON.parse(rec.factors || '{}'), rec);
  const floor = Math.max(1, Number(factors.guardrails.floor || 1), Number(factors.guardrails.parityFloorRate || 0));
  const ceiling = Math.max(floor, Number(factors.guardrails.ceiling || 1000));
  const nextRate = rate === undefined ? rec.recommended_rate : Number(rate);
  if (!Number.isFinite(nextRate)) return res.status(400).json({ error: 'Enter a valid rate before approving.' });
  if (nextRate < floor || nextRate > ceiling) return res.status(400).json({ error: `The approved rate must stay within the $${floor}–$${ceiling} rate guardrails.` });
  db.prepare('UPDATE recommendations SET status=?,recommended_rate=? WHERE id=?').run(status, nextRate, id);
  db.prepare('INSERT INTO activity (action,detail) VALUES (?,?)').run(`Rate ${status.toLowerCase()}`, `${rec.day_label} · $${nextRate} · ${reason || 'Owner review'}`);
  res.json({ success: true });
});

app.get('/api/alerts', (_req, res) => res.json(db.prepare('SELECT a.*,p.name AS property_name FROM alerts a LEFT JOIN properties p ON p.id=a.property_id ORDER BY CASE severity WHEN \'High\' THEN 1 WHEN \'Medium\' THEN 2 ELSE 3 END,id').all()));
app.patch('/api/alerts/:id', (req, res) => {
  db.prepare("UPDATE alerts SET status='Resolved' WHERE id=?").run(Number(req.params.id));
  res.json({ success: true });
});
app.get('/api/metrics', (_req, res) => res.json(db.prepare('SELECT m.*,p.name AS property_name FROM daily_metrics m JOIN properties p ON p.id=m.property_id ORDER BY day,property_id').all()));
app.get('/api/activity', (_req, res) => res.json(db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT 12').all()));

app.post('/api/agent/query', (req, res) => {
  const query = String(req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'Ask a question to search the demo data.' });
  const q = query.toLowerCase();
  const props = db.prepare('SELECT * FROM properties ORDER BY id').all();
  const propertyId=q.includes('travelodge')||q.includes('wyndham')?1:q.includes('quality suites')||q.includes('choice')?2:0;
  const propertyWhere=propertyId?' WHERE property_id=?':'';const propertyParams=propertyId?[propertyId]:[];
  let answer = 'I can answer questions about your two Fargo hotels, their room inventory, pricing suggestions, reservations, payments, alerts, and performance. Choose a suggested question or ask about a hotel by name.';
  let rows = [];
  if ((q.includes('location')||q.includes('hotel'))&&(q.includes('highest')||q.includes('compare')||q.includes('occupancy'))) {
    rows=db.prepare('SELECT name AS location,brand,city,state,rooms,occupancy,adr,revpar,revenue FROM properties ORDER BY occupancy DESC').all();
    const best=rows[0];answer=`Among the seeded Fargo properties, ${best.location} has the higher current occupancy at ${best.occupancy}%. These are property-level demo snapshot figures; they are not live PMS data.`;
  } else if (q.includes('system') || q.includes('franchise') || q.includes('which hotel')) {
    rows = props.map(p => ({ Property: p.name, Franchise: p.franchisor, System: p.system, Rooms: p.rooms }));
    answer = 'The portfolio contains two separate franchise relationships: Travelodge Fargo West Acres is Wyndham / Travelodge, with SynXis and reported RevIQ; Quality Suites Fargo West Acres is Choice Hotels, with ChoiceADVANTAGE. The room totals below are seeded demonstration inventory.';
  } else if (q.includes('alert') || q.includes('issue') || q.includes('reconcil') || q.includes('attention')) {
    const alertWhere=propertyId?' AND property_id=?':'';
    rows = db.prepare(`SELECT title,detail,severity,status,time_label FROM alerts WHERE status='Open'${alertWhere} ORDER BY CASE severity WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,id`).all(...propertyParams);
    const high=rows.filter(r=>r.severity==='High').length;answer=rows.length?`${rows.length} open ${rows.length===1?'item needs':'items need'} attention${propertyId?' for the selected hotel':''}${high?`, including ${high} high-priority item${high===1?'':'s'}`:''}. Review the records below; they are seeded demo alerts.`:'There are no open demo alerts for that hotel.';
  } else if ((q.includes('category') || q.includes('room') || q.includes('inventory') || q.includes('maintenance') || q.includes('ready')) && !q.includes('revenue') && !q.includes('tax') && !q.includes('payment') && !q.includes('advance')) {
    const select=q.includes('quality')||q.includes('choice')?2:q.includes('travelodge')||q.includes('wyndham')?1:0;
    const sql=`SELECT l.name AS location,c.name AS category,c.tier,c.room_type,c.base_price,COUNT(r.id) AS total_rooms,SUM(CASE WHEN r.status='Ready' THEN 1 ELSE 0 END) AS ready_rooms,SUM(CASE WHEN r.status='Maintenance' OR r.status='Out of order' THEN 1 ELSE 0 END) AS unavailable_rooms FROM room_categories c JOIN locations l ON l.id=c.location_id LEFT JOIN rooms r ON r.category_id=c.id ${select?'WHERE l.property_id=?':''} GROUP BY c.id ORDER BY l.name,c.name`;
    rows=select?db.prepare(sql).all(select):db.prepare(sql).all();
    const ready=rows.reduce((n,r)=>n+Number(r.ready_rooms||0),0),unavailable=rows.reduce((n,r)=>n+Number(r.unavailable_rooms||0),0),total=rows.reduce((n,r)=>n+Number(r.total_rooms||0),0);answer=`${total} numbered demo rooms across ${rows.length} room categories${propertyId?' at the selected hotel':''}: ${ready} are marked Ready and ${unavailable} are in Maintenance or Out of order. Category base rates and counts are shown below.`;
  } else if (q.includes('source') || q.includes('channel') || q.includes('booking.com') || /\bota\b/.test(q)) {
    rows=db.prepare(`SELECT b.reservation_source AS source,COUNT(*) AS bookings,SUM(CASE WHEN b.booking_status='Cancelled' THEN 1 ELSE 0 END) AS cancelled,SUM(b.total_amount) AS booked_total FROM bookings b ${propertyId?'WHERE b.property_id=?':''} GROUP BY b.reservation_source ORDER BY bookings DESC`).all(...propertyParams);
    const totalBookings=rows.reduce((n,r)=>n+Number(r.bookings||0),0);answer=`There are ${totalBookings} seeded reservations across ${rows.length} booking sources${propertyId?' for the selected hotel':''}. Booked totals describe reservations; they do not represent settled OTA payouts.`;
  } else if (q.includes('cancel') || q.includes('no-show') || q.includes('no show')) {
    rows=db.prepare(`SELECT l.name AS location,c.name AS category,b.booking_status AS status,COUNT(*) AS bookings FROM bookings b JOIN locations l ON l.id=b.location_id JOIN room_categories c ON c.id=b.category_id WHERE b.booking_status IN ('Cancelled','No-show')${propertyId?' AND b.property_id=?':''} GROUP BY l.id,c.id,b.booking_status ORDER BY l.name,c.name`).all(...propertyParams);
    const totalExceptions=rows.reduce((n,r)=>n+Number(r.bookings||0),0);answer=`${totalExceptions} seeded reservations are cancelled or marked No-show${propertyId?' for the selected hotel':''}. The breakdown below separates hotel, room category, and status.`;
  } else if (q.includes('cash in hand') || q.includes('cash drawer') || q.includes('till balance')) {
    rows=db.prepare("SELECT l.name AS location,ROUND(SUM(CASE WHEN t.type IN ('Opening balance','Receipt','Cash withdrawal','Adjustment') AND (t.type='Opening balance' OR t.method='Cash') THEN t.amount WHEN t.type IN ('Refund','Expense','Cash deposit') AND t.method='Cash' THEN -t.amount ELSE 0 END),2) AS estimated_cash_in_hand FROM payment_transactions t JOIN locations l ON l.id=t.location_id GROUP BY l.id ORDER BY l.name").all();
    const cash=rows.reduce((n,r)=>n+Number(r.estimated_cash_in_hand||0),0),fmt=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);answer=`The seeded cash drawer estimate is ${fmt(cash)} across the listed locations. Each location’s figure includes opening cash plus recorded cash receipts, less refunds, expenses, and deposits. Count and reconcile the physical drawer before relying on it.`;
  } else if (q.includes('online') || q.includes('offline') || q.includes('payment channel')) {
    rows=db.prepare(`SELECT l.name AS location,t.channel,COUNT(*) AS transactions,SUM(CASE WHEN t.type='Receipt' THEN t.amount ELSE 0 END) AS receipts,SUM(CASE WHEN t.type='Refund' THEN t.amount ELSE 0 END) AS refunds FROM payment_transactions t JOIN locations l ON l.id=t.location_id WHERE t.status='Posted'${propertyId?' AND t.property_id=?':''} GROUP BY l.id,t.channel ORDER BY l.name,t.channel`).all(...propertyParams);
    const online=rows.filter(r=>r.channel==='Online').reduce((n,r)=>n+Number(r.receipts||0),0),offline=rows.filter(r=>r.channel==='Offline').reduce((n,r)=>n+Number(r.receipts||0),0),fmt=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);answer=`Seeded payment receipts total ${fmt(online)} online and ${fmt(offline)} offline${propertyId?' for the selected hotel':''}. Refunds and transaction counts are listed by location and channel below; these are demo ledger entries.`;
  } else if (q.includes('advance') || q.includes('payment collected') || q.includes('payment')) {
    rows=db.prepare(`SELECT l.name AS location,c.name AS category,COUNT(*) AS reservations,SUM(b.advance_amount) AS advance_collected,SUM(b.total_amount-b.advance_amount) AS remaining_balance FROM bookings b JOIN locations l ON l.id=b.location_id JOIN room_categories c ON c.id=b.category_id ${propertyId?'WHERE b.property_id=?':''} GROUP BY l.id,c.id ORDER BY l.name,c.name`).all(...propertyParams);
    const advances=rows.reduce((n,r)=>n+Number(r.advance_collected||0),0),balance=rows.reduce((n,r)=>n+Number(r.remaining_balance||0),0);answer=`Seeded bookings show ${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(advances)} in advance payments and ${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(balance)} remaining${propertyId?' for the selected hotel':''}. These are reservation records, not live processor settlements.`;
  } else if (q.includes('tax') || q.includes('revenue')) {
    rows=db.prepare(`SELECT l.name AS location,c.name AS category,COUNT(*) AS reservations,SUM(b.room_subtotal-b.discount_amount) AS room_revenue_before_tax,SUM(b.tax_amount) AS tax,SUM(b.total_amount) AS gross_after_tax FROM bookings b JOIN locations l ON l.id=b.location_id JOIN room_categories c ON c.id=b.category_id WHERE b.booking_status NOT IN ('Cancelled','No-show')${propertyId?' AND b.property_id=?':''} GROUP BY l.id,c.id ORDER BY l.name,c.name`).all(...propertyParams);
    const before=rows.reduce((n,r)=>n+Number(r.room_revenue_before_tax||0),0),tax=rows.reduce((n,r)=>n+Number(r.tax||0),0),gross=rows.reduce((n,r)=>n+Number(r.gross_after_tax||0),0),fmt=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);answer=`For active seeded bookings${propertyId?' at the selected hotel':''}, room revenue before tax is ${fmt(before)}, tax is ${fmt(tax)}, and booked gross is ${fmt(gross)}. This is reservation value, not cash received or a reconciled ledger.`;
  } else if (q.includes('explain') || q.includes('formed') || q.includes('how are rates')) {
    rows=db.prepare('SELECT p.name AS property,r.stay_date,r.current_rate,r.recommended_rate,r.forecast_occupancy,r.confidence,r.factors FROM recommendations r JOIN properties p ON p.id=r.property_id WHERE r.stay_date>=date(\'now\') ORDER BY r.stay_date LIMIT 6').all();
    answer='The demo rate starts from seeded historical ADR and occupancy. Forecast demand, booking pace, day/event context, and illustrative competitor rates provide signals. A selected room category’s base rate and floor/ceiling constrain its displayed suggestion. This is an explainable demo rule set, not a trained or production pricing model.';
  } else if (q.includes('recommend') || q.includes('rate') || q.includes('price') || q.includes('weekend') || q.includes('upcoming')) {
    const select = q.includes('quality') || q.includes('choice') ? 2 : q.includes('travelodge') || q.includes('wyndham') ? 1 : 0;
    const sql = select ? 'SELECT r.*,p.name property_name FROM recommendations r JOIN properties p ON p.id=r.property_id WHERE p.id=? AND stay_date>=date(\'now\') ORDER BY stay_date LIMIT 8' : 'SELECT r.*,p.name property_name FROM recommendations r JOIN properties p ON p.id=r.property_id WHERE stay_date>=date(\'now\') ORDER BY stay_date LIMIT 10';
    rows = select ? db.prepare(sql).all(select) : db.prepare(sql).all();
    answer = 'Here are the next suggested rates in the demo. The recommendation engine uses a transparent demand and inventory baseline, rate guardrails, and sample market context. These are illustrative values, not live pricing advice.';
  } else if (q.includes('revenue') || q.includes('occupancy') || q.includes('adr') || q.includes('performance') || q.includes('revpar')) {
    const selected=propertyId?props.filter(p=>p.id===propertyId):props;rows=selected.map(p=>({Property:p.name,Location:`${p.city}, ${p.state}`,Rooms:p.rooms,Occupancy:`${p.occupancy}%`,ADR:`$${p.adr}`,RevPAR:`$${p.revpar}`,'Yesterday room revenue':`$${p.revenue}`}));
    const totalRooms=selected.reduce((n,p)=>n+p.rooms,0),occupied=selected.reduce((n,p)=>n+p.rooms*p.occupancy/100,0),weightedOcc=totalRooms?occupied/totalRooms*100:0;answer=propertyId?`${selected[0]?.name||'Selected hotel'} has seeded occupancy of ${selected[0]?.occupancy||0}%, ADR of $${selected[0]?.adr||0}, and RevPAR of $${selected[0]?.revpar||0}. These are illustrative property-level demo figures.`:`Across ${selected.length} seeded Fargo hotels, weighted occupancy is ${weightedOcc.toFixed(1)}% across ${totalRooms} stated rooms. The table compares hotel-level occupancy, ADR, RevPAR, and yesterday’s sample room revenue.`;
  }
  db.prepare('INSERT INTO activity (action,detail) VALUES (?,?)').run('Agent data search', query.slice(0, 180));
  res.json({ answer, rows, exportName: 'exora-agent-results.csv', demo: true });
});

app.get('/api/export/:kind', (req, res) => {
  const { kind } = req.params;
  const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  let rows, name;
  if (kind === 'recommendations') {
    rows = db.prepare(`SELECT p.name property,r.stay_date,r.current_rate,r.recommended_rate,r.occupancy,r.forecast_occupancy,r.competitor_rate,r.confidence,r.status FROM recommendations r JOIN properties p ON p.id=r.property_id ORDER BY r.stay_date,r.property_id`).all(); name = 'exora-rate-recommendations.csv';
  } else if (kind === 'alerts') {
    rows = db.prepare('SELECT p.name property,a.severity,a.title,a.detail,a.time_label,a.status FROM alerts a LEFT JOIN properties p ON p.id=a.property_id ORDER BY a.id').all(); name = 'exora-operational-alerts.csv';
  } else if (kind === 'performance') {
    rows = db.prepare('SELECT p.name property,m.day,m.revenue,m.occupancy,m.adr,m.rooms_sold FROM daily_metrics m JOIN properties p ON p.id=m.property_id ORDER BY m.day,p.id').all(); name = 'exora-performance.csv';
  } else return res.status(404).json({ error: 'Export type not found.' });
  const columns = Object.keys(rows[0] || {});
  const csv = [columns.map(escape).join(','), ...rows.map(row => columns.map(c => escape(row[c])).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send('\ufeff' + csv);
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve(__dirname, '../dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const server = app.listen(PORT, () => console.log(`Exora demo API listening at http://localhost:${PORT}`));
server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. If the Exora demo is already running, open http://localhost:5173. Otherwise stop the process using port ${PORT}, or set PORT to another free port and update the Vite proxy.`);
    process.exitCode = 1;
    return;
  }
  console.error('Unable to start the Exora demo API:', error);
  process.exitCode = 1;
});
