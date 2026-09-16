# Web account API contract

This describes the implemented account and source API, not verification evidence.
Browser mutations reject foreign Origin/Host or cross-site requests. Device ingest
is separate: it uses a machine-scoped bearer token, not a browser session or Origin.
All admin routes require a live admin of the current company, never an org ID
from request JSON. Responses and errors do not return passwords or stored hashes.
Unknown JSON fields are rejected. Request bodies are limited to 16 KiB for account
routes and 512 KiB for ingest; schema validation failures return a safe 422 response.

## Session and authentication

`Session`: `{organization:{id,name,account}, user:{id,login,role:"admin"|"user",must_change_password,legacy_access}, demo:boolean, data_period?:{start,end}, onboarding?:{completed,step}}`.
Demo may have `user:null`. New passwords are 12–128 characters. Account and login
for new registrations are 2–80 character lowercase technical identifiers matching
`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`, not personal names/email addresses. Older company
codes retain their case-sensitive spelling for login, activation and recovery.
The `itles_session` cookie is HttpOnly, SameSite=Strict and Secure by default;
real user sessions last seven days, demo sessions one hour, without sliding renewal.
Activation codes expire after 72 hours; administrator recovery codes after 30 days.

- `POST /api/auth/register`: `{organization_name,account,login,password}` → Session + `recovery_code` (one time). Always creates a new organization; a matching display name never grants access.
- `POST /api/auth/login`: `{account,login,password}` → Session. Legacy callers without login resolve to transitional readonly `legacy`; the formerly shared organization credential MUST NOT gain new admin powers. User payload has `legacy_access:true` for this principal. Trusted server maintenance issues a pending admin activation code only after independently verifying the owner, disabling the legacy principal and sessions. New registrations do not need server assistance.
- `POST /api/auth/activate`: `{account,login,code,password}` → Session, plus a one-time `recovery_code` when activating an administrator. Code single-use and expires.
- `POST /api/auth/recover`: `{account,login,recovery_code,password}` → Session + new `recovery_code`. Invalidates previous sessions and code atomically.
- `POST /api/auth/password`: `{current_password,new_password}` → `{ok:true}`; invalidates all the caller's sessions (UI goes back to login).
- `POST /api/auth/recovery-code`: `{password}` → `{recovery_code}`; admin only, invalidates previous recovery code.
- `POST /api/auth/logout-all`: `{}` → `{ok:true}`; invalidates the caller's sessions only.
- `GET /api/auth/me` → Session, or 401 when expired/revoked/absent.
- `POST /api/auth/logout`: no required body → `{ok:true}`; revokes only the presented session and clears its cookie, including when it has already expired.
- `GET /api/auth/options` → `{demo_enabled,registration_enabled}`; no session required.
- `POST /api/auth/demo`: no required body → demo Session; 404 when disabled, 429 when limited or session capacity is reached, 503 for unavailable storage/scenario. Does not require or create a company account.

Authentication has bounded process-local attempt limits and a shared work budget;
429 is not a reason to disable protection. A deployment with multiple processes
needs a separate shared/proxy limit. See [deployment](deployment.md).

## Company and users

- `GET /api/admin/onboarding` → `{completed,step,machine_added,users_configured,source_configured,data_received,data_reviewed}`. Facts computed from durable data; `step` is a saved screen, not a claim of connection. `step` is `machine`, `users`, `source` or `complete`.
- `PATCH /api/admin/onboarding`: `{step?,users_configured?}` → same shape. `users_configured:true` also supports the explicit "only me for now" choice.
- `PATCH /api/admin/company`: `{name}` → `{organization:{id,name,account}}`.
- `GET /api/admin/users` → `{users:[{id,login,role,status:"active"|"pending"|"revoked",created_at,legacy_access}]}`.
- `POST /api/admin/users`: `{login}` → `{user,activation_code,expires_at}`. Creates read-only user for all machines of own company; no admin-role input.
- `POST /api/admin/users/{id}/reissue`: `{}` → `{user,activation_code,expires_at}`; revokes old code and sessions.
- `DELETE /api/admin/users/{id}` → `{ok:true}`; revokes user, activation code, all sessions. Cannot revoke self/owner admin.
- `POST /api/admin/users/{id}/sessions/revoke`: `{}` → `{ok:true}`. Logs out that user without withdrawing future access.

`completed` records initial setup for at least one permitted JSON source with a
token and a recorded comparison, plus the explicit user-access decision. It does
not mean that every machine is configured or that later data has been reviewed.
Use each machine's current `connection` for that decision. Employee reissue/revoke
routes do not allow changing the owner administrator or acting across companies.

## Machines and source

- Existing `GET /api/machines` remains the fleet read. No token secrets in it.
- `POST /api/admin/machines`: `{name,model?,head?,computer?}` → `{machine:{id,name,model,head,computer}}`. Server issues ID; new machine has no device token/packets yet.
- `GET /api/admin/machines/{id}/source` → `{machine,source,connection,tokens,onboarding}`.
- `PUT /api/admin/machines/{id}/source`: `{model?,computer?,software_version?,source_kind:"unconfigured"|"normalized_json"|"unsupported",export_description?,permission_confirmed:boolean}` → same shape.
- `source`: saved input fields; unknown fields are empty/null, never guessed.
- `connection`: `{state:"added"|"source_unconfigured"|"awaiting_message"|"message_received"|"review_required"|"stale",last_received_at:string|null,last_observed_at:string|null,last_position_at:string|null,reviewed_at:string|null,message_count:number}`.
- `tokens`: `[{id,created_at}]`, only active tokens. ID is an opaque revocation identifier, not a bearer credential.
- `POST /api/admin/machines/{id}/tokens`: `{password}` → `{token,created_at}`; requires a permitted `normalized_json` source, generates a new token and revokes previous ones. Ingest only, current machine only. Tokens have no automatic expiry; rotate and revoke them explicitly.
- `DELETE /api/admin/machines/{id}/tokens`: `{}` → `{ok:true}`; revokes all tokens for that machine.
- `POST /api/admin/machines/{id}/review`: `{message_count:number}` → source response; requires a positive integer equal to the current accepted event count and a permitted JSON source. Returns 409 if new events arrived since the displayed snapshot. Records human comparison, not calibration/health.

`connection.message_count` counts accepted **events**, not HTTP packets. Duplicate
delivery can update `last_received_at`, but not `last_observed_at` or event count.
An unreviewed fresh event yields `review_required`; `message_received` means the
current count was compared. `stale` takes precedence when the latest observation
or receipt is older than two hours. `reviewed_at` remains the historical comparison
time; it does not certify newer events. Changing source metadata clears that
comparison. Changing away from permitted JSON also revokes device tokens.

Source configured / token issued never means machine connected. A fresh arrival
of old observations must not imply fresh measurements. A receipt and a manual
data comparison are distinct facts. Unsupported source never presents an OEM,
CAN, or StanForD adapter as implemented.

## Read API, ingest and diagnostics

- Session-scoped reads: `GET /api/machines`, `/api/fleet`, `/api/machines/{id}`,
  `/api/quality`, `/api/methodology`, `/api/exports/ledger.csv`. A foreign machine
  ID returns 404. Employee access covers the whole company, not selected machines.
- Fleet, machine detail and CSV accept `start`/`end` dates in `YYYY-MM-DD`, inclusive
  in UTC. Latest readings/position are independent of the selected journal period.
  Missing records are not zero output; volume bases remain separate.
- `POST /api/ingest` retains payload `schema_version:1`; account API v2 does not
  change the telemetry schema. See [`backend/schemas.py`](../backend/schemas.py)
  and `/openapi.json`. The batch has 1–500 events; stable IDs make retries idempotent,
  while changed content under an existing ID returns 409 atomically.
- `GET /api/health` → `{status:"ok"}` after a database query. `X-ITles-Version: 2.0`
  is the API version, not a build SHA; `X-Request-ID` is a per-request diagnostic ID.
  Record the deployed commit/image identity separately.
- The full server exposes `/api/documents` and its allowlisted generated downloads
  without a session. These are public project documents, not company exports;
  never include customer data or secrets in their generator inputs.
