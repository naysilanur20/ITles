# Web account API contract (implementation target)

This is the shared backend/frontend contract for the product continuation.
It is not verification evidence. All mutations require same-origin checks;
all admin routes require a live admin of the current company, never an org ID
from request JSON. Responses and errors must not contain passwords or stored hashes.

## Session and authentication

`Session`: `{organization:{id,name,account}, user:{id,login,role:"admin"|"user",must_change_password}, demo:boolean, data_period?:{start,end}, onboarding?:{completed,step}}`.
Demo may have `user:null`. New passwords are 12–128 characters. Account and login
are lowercase technical identifiers, not personal names/email addresses.

- `POST /api/auth/register`: `{organization_name,account,login,password}` → Session + `recovery_code` (one time). Always creates a new organization; a matching display name never grants access.
- `POST /api/auth/login`: `{account,login,password}` → Session. Legacy callers without login resolve to transitional readonly `legacy`; the formerly shared organization credential MUST NOT gain new admin powers. User payload has `legacy_access:true` for this principal. Trusted server maintenance issues a pending admin activation code only after independently verifying the owner, disabling the legacy principal and sessions. New registrations do not need server assistance.
- `POST /api/auth/activate`: `{account,login,code,password}` → Session. Code single-use and expires.
- `POST /api/auth/recover`: `{account,login,recovery_code,password}` → Session + new `recovery_code`. Invalidates previous sessions and code atomically.
- `POST /api/auth/password`: `{current_password,new_password}` → `{ok:true}`; invalidates all the caller's sessions (UI goes back to login).
- `POST /api/auth/recovery-code`: `{password}` → `{recovery_code}`; admin only, invalidates previous recovery code.
- `POST /api/auth/logout-all`: `{}` → `{ok:true}`; invalidates the caller's sessions only.
- Existing me/logout/demo/options routes remain; options includes `registration_enabled`.

## Company and users

- `GET /api/admin/onboarding` → `{completed,step,machine_added,users_configured,source_configured}`. Facts computed from durable data; `step` is a saved screen, not a claim of connection.
- `PATCH /api/admin/onboarding`: `{step?,users_configured?}` → same shape. `users_configured:true` also supports the explicit "only me for now" choice.
- `PATCH /api/admin/company`: `{name}` → `{organization:{id,name,account}}`.
- `GET /api/admin/users` → `{users:[{id,login,role,status:"active"|"pending"|"revoked",created_at}]}`.
- `POST /api/admin/users`: `{login}` → `{user,activation_code,expires_at}`. Creates read-only user for all machines of own company; no admin-role input.
- `POST /api/admin/users/{id}/reissue`: `{}` → `{user,activation_code,expires_at}`; revokes old code and sessions.
- `DELETE /api/admin/users/{id}` → `{ok:true}`; revokes user, activation code, all sessions. Cannot revoke self/owner admin.
- `POST /api/admin/users/{id}/sessions/revoke`: `{}` → `{ok:true}`. Logs out that user without withdrawing future access.

## Machines and source

- Existing `GET /api/machines` remains the fleet read. No token secrets in it.
- `POST /api/admin/machines`: `{name,model?,head?,computer?}` → `{machine:{id,name,model,head,computer}}`. Server issues ID; new machine has no device token/packets yet.
- `GET /api/admin/machines/{id}/source` → `{machine,source,connection,tokens}`.
- `PUT /api/admin/machines/{id}/source`: `{model?,computer?,software_version?,source_kind:"unconfigured"|"normalized_json"|"unsupported",export_description?,permission_confirmed:boolean}` → same shape.
- `source`: saved input fields; unknown fields are empty/null, never guessed.
- `connection`: `{state:"added"|"source_unconfigured"|"awaiting_message"|"message_received"|"review_required"|"stale",last_received_at:string|null,last_observed_at:string|null,last_position_at:string|null,reviewed_at:string|null,message_count:number}`.
- `tokens`: `[{id,created_at}]`, only active tokens. ID is an opaque revocation identifier, not a bearer credential.
- `POST /api/admin/machines/{id}/tokens`: `{password}` → `{token,created_at}`; generates a new token, revokes previous ones. Ingest only, current machine only.
- `DELETE /api/admin/machines/{id}/tokens`: `{}` → `{ok:true}`; revokes all tokens for that machine.
- `POST /api/admin/machines/{id}/review`: `{}` → source response; records human comparison to source only when there is accepted data, not a calibration/health assertion.

Source configured / token issued never means machine connected. A fresh arrival
of old observations must not imply fresh measurements. A receipt and a manual
data comparison are distinct facts. Unsupported source never presents an OEM,
CAN, or StanForD adapter as implemented.
