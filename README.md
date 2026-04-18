# Celestial Forge Engine v1

Node.js + Express + SQLite implementation of a deterministic Celestial Forge backend.

## Run

```bash
npm install
npm start
```

Server starts on `http://localhost:3000`.

## Implemented endpoints

- Sessions
  - `POST /session/create`
  - `GET /session/list`
  - `POST /session/select`
  - `POST /session/duplicate`
- Sheet
  - `GET /sheet/full`
  - `GET /sheet/summary`
- Turn
  - `POST /turn/finalize`
- Perks
  - `POST /perk/roll`
  - `POST /perk/buy`
  - `GET /perk/:id`
  - `POST /perk/generate`
- XP
  - `POST /xp/add`
- Resources
  - `POST /resource/modify`
  - `POST /resource/set`

## Notes

- Mechanics are deterministic and resolved by the engine.
- AI integration is represented as a validated `POST /perk/generate` flow in v1.
- State is isolated per session; a selected session pointer is tracked in `app_state`.
