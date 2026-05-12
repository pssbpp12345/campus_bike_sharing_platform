# ERD — Campus Bike Sharing Platform

Textual ERD matching the Mermaid diagram in your SRS report, extended with the four optional modules you selected (maintenance, audit, ratings, payments).

## Entities & keys

```
users(id PK, full_name, email UK, password_hash, role, phone,
      is_active, email_verified, last_login_at, created_at, updated_at)

stations(id PK, station_name, latitude, longitude, capacity,
         campus_zone, address, is_active, created_at, updated_at)

bikes(id PK, bike_code UK, model, status, station_id FK→stations,
      total_rides, last_maintenance_at, created_at, updated_at)

bookings(id PK,
         user_id FK→users,
         bike_id FK→bikes,
         pickup_station_id FK→stations,
         return_station_id FK→stations (nullable),
         start_time, end_time, status, expires_at,
         duration_minutes, fee_amount, notes,
         created_at, updated_at)

maintenance_logs(id PK,
                 bike_id FK→bikes,
                 reported_by_user_id FK→users (nullable),
                 resolved_by_admin_id FK→users (nullable),
                 issue_type, description, severity, status,
                 reported_at, resolved_at, resolution_notes,
                 created_at, updated_at)

admin_audit_log(id PK,
                admin_id FK→users (nullable),
                action, entity_type, entity_id,
                details JSONB, ip_address, user_agent, created_at)

bike_ratings(id PK,
             booking_id FK→bookings UK,
             user_id FK→users,
             bike_id FK→bikes,
             rating 1–5, comment, created_at)

payments(id PK,
         booking_id FK→bookings,
         user_id FK→users,
         amount, currency, payment_method, status,
         transaction_reference, paid_at, created_at, updated_at)

system_settings(key PK, value, description, updated_by FK→users, updated_at)
```

## Relationships (cardinality)

| Parent | Child | Cardinality | Meaning |
|--------|-------|-------------|---------|
| users | bookings | 1 : N | One user makes many bookings |
| bikes | bookings | 1 : N | One bike is used across many bookings |
| stations | bookings (pickup) | 1 : N | Each booking picks up from exactly one station |
| stations | bookings (return) | 0..1 : N | Return station may be null until returned |
| stations | bikes | 1 : N | A station docks many bikes |
| bikes | maintenance_logs | 1 : N | A bike may have several maintenance events |
| users | maintenance_logs (reporter) | 0..1 : N | User who reported (may be null if system) |
| users | maintenance_logs (admin) | 0..1 : N | Admin who resolved |
| users | admin_audit_log | 1 : N | All actions by a given admin |
| bookings | bike_ratings | 1 : 0..1 | Optional rating per completed booking |
| bookings | payments | 1 : N | Refunds can add additional rows |
| users | payments | 1 : N | Payer history |

## Integrity rules enforced at schema level

1. Email uniqueness is case-insensitive (`UNIQUE INDEX ON LOWER(email)`).
2. One active booking per user (`UNIQUE INDEX ... WHERE status IN ('pending','active')`).
3. One active booking per bike (same pattern on `bike_id`).
4. `bookings.end_time > start_time` when both are set.
5. A bike with `status='in_use'` cannot be docked (`station_id` must be NULL).
6. A booking with `status='completed'` must have `end_time` and `return_station_id`.
7. Latitude in [-90, 90], longitude in [-180, 180].
8. Station capacity > 0.
9. Rating in [1, 5].
10. Payment amount >= 0.

## Status state machines

### bike_status
```
available ──book──▶ in_use ──return──▶ available
   │                   │
   └─flag─▶ maintenance ─resolve─▶ available
                │
                └─retire─▶ retired   (terminal)
```

### booking_status
```
pending ──confirm──▶ active ──return──▶ completed     (terminal)
   │                   │
   └─cancel──▶ cancelled (terminal)
                       │
                       └─timeout──▶ expired            (terminal)
```

### maintenance_status
```
reported ──pickup──▶ in_progress ──fix──▶ resolved ──archive──▶ closed
```
