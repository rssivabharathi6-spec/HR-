# PeoplePulse HR Portal: Backend and Database

Node.js + Express API with a SQLite database. Login uses JWT tokens and bcrypt-hashed passwords, with role-based access (HR / Manager / Employee).

## Run it
```bash
npm install
npm start          # open http://localhost:3000 for the portal (database is created and seeded on first run)
npm test           # smoke tests: logins, role blocks, leave rules, WFH limit
```
Demo logins (change before real use): `hr@company.com / hr123`, `manager@company.com / mgr123`, `employee@company.com / emp123`.

## Database tables
`users` (login, role, manager, salary), `departments`, `leave_balances`, `leave_requests`, `work_plan`, `goals`, `feedback`, `candidates`, `onboarding_tasks`, `pulse_responses` (anonymous), `policies`, `policy_acks`, `compliance_items`, `tickets`, `exits`, `audit_log`. See `schema.sql`.

## API (send header `Authorization: Bearer <token>` on everything except login)
| Method and path | Who | What |
|---|---|---|
| POST `/api/auth/login` | anyone | `{email,password}` returns `{token,user}` |
| GET `/api/me` | all | current user |
| GET `/api/leave/balance`, `/api/leave/mine` | all | own balances and requests |
| POST `/api/leave` | all | apply `{type,days,reason}` (checks balance) |
| GET `/api/leave/pending` | Manager, HR | requests from your team |
| PATCH `/api/leave/:id` | Manager, HR | `{status:"Approved"/"Rejected"}`; no self-approval; deducts balance |
| GET/PUT `/api/workplan` | all | own Office/WFH plan; max 3 WFH per week |
| GET `/api/team/today` | Manager, HR | who is where today |
| GET/POST `/api/goals`, PATCH `/api/goals/:id` | all | own goals and progress |
| POST/GET `/api/feedback` | all | send / receive feedback |
| GET/POST `/api/candidates`, PATCH `/api/candidates/:id` | HR | hiring pipeline |
| GET `/api/onboarding`, PATCH `/api/onboarding/:id` | all (scoped) | checklist |
| POST `/api/pulse` | all | anonymous mood 1-4 |
| GET `/api/pulse/summary` | HR | score by department (hidden if under 3 answers) |
| GET `/api/compliance`, PATCH `/api/compliance/:id` | all / HR | obligations tracker |
| GET `/api/policies`, POST `/api/policies/:id/ack` | all | policy acknowledgement |
| GET/POST `/api/tickets`, PATCH `/api/tickets/:id` | all / HR to update | helpdesk |
| POST `/api/chat` | all | simple keyword assistant |
| GET `/api/analytics/overview` | HR | headcount, attrition %, time to fill, engagement |
| GET `/api/analytics/attrition-risk` | HR | risk score and reasons per employee |
| POST `/api/analytics/simulate` | HR | what-if: raise, promotion, manager change, flexible work, learning |
| GET `/api/audit`, `/api/users` | HR | audit trail, user list |

## The portal page (already connected)
`public/index.html` is the portal. The server serves it at `/`, so the page and API share one address and no CORS setup is needed. It logs in through `/api/auth/login`, keeps the token for the browser session, and every tab loads and saves through the API. Tabs: Overview, Attrition risk (with what-if simulator), Hiring, Leave, Hybrid work, Performance, Onboarding, Engagement, Compliance, Helpdesk.

Not yet in the connected page: Succession (9-box), Career growth, payslips, sending feedback to a colleague. The backend has no data for these yet.

## Connecting a different frontend
Replace the sample arrays in the portal page with `fetch()` calls, for example:
```js
const r = await fetch(API + '/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email, password})});
const {token, user} = await r.json();
const bal = await (await fetch(API + '/leave/balance', {headers:{Authorization:'Bearer ' + token}})).json();
```

## Before real use (checklist)
1. Set a long random `JWT_SECRET`; the server refuses to start in production without it.
2. Delete or change all demo users and passwords in `db.js`.
3. Serve over **HTTPS only**, and set `CORS_ORIGIN` to your frontend address.
4. Put `hr.db` on a persistent disk and **back it up daily**. Encrypt backups: the database holds salaries.
5. For more than a few hundred users or several servers, move to PostgreSQL.
6. Add what is not built yet: password reset, two-factor login, account lockout, user management screens, payroll calculation, file uploads (documents, payslip PDFs).
7. Get a legal review for India's DPDP Act (consent, retention, who can see salary data) and your labour-law obligations.

## Known limits of this version
- The attrition risk score is a simple rule-based formula (promotion gap, pay gap, team mood, tenure), not a trained model.
- Payslips are not generated; payroll needs your payroll system's data.
- The chat assistant matches keywords only.
