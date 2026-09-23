# Mainnet Payment Submit Feature Flag

- `FEATURE_MAINNET_PAYMENT_SUBMIT` (boolean, default: false)
  - When `true`, `POST /transactions/fee-bump` requests with `network: "MAINNET"` are submitted to Horizon mainnet as normal.
  - When `false` or unset, MAINNET submissions are rejected with HTTP 403 (Forbidden) and message: "Mainnet payment submission is not available at this time. (Flag: mainnet_payment_submit)". `TESTNET` submissions are unaffected — the flag is only consulted when `network === "MAINNET"`.

Notes:
- Implemented as a kill-switch check inside `FeeBumpService.submitFeeBump` (not the route-level `FeatureFlagGuard`), because the decision depends on the `network` field in the request body rather than being fixed per-route.
- Reuses the existing `FeatureFlagService.isEnabled()` helper and the `FEATURE_<FLAG_NAME>` env var convention (e.g. `FEATURE_MAINNET_PAYMENT_SUBMIT=true`).
- Rejections happen before any wallet key material is decrypted or any call to Horizon is made.

Operational guidance:
- Keep this flag off in production until mainnet payment submission has been reviewed and approved for general availability; flip it on per-environment via env/secret config.

## Testnet Faucet Mainnet Gate (#882)

The testnet faucet is a testnet-only surface. It must never dispense funds on mainnet, and it must fail closed when the configured network is unknown or misconfigured.

- Gate rule: faucet requests are allowed only when the resolved network is `TESTNET`. Any other resolved network — `MAINNET`, unset, or unrecognized — is denied.
- Fail-closed on misconfig: an unknown/absent network is treated as denied, not as testnet. There is no default-allow path.
- Stable error codes: denials return a typed error with a stable code (e.g. `FAUCET_MAINNET_BLOCKED` for mainnet, `FAUCET_NETWORK_UNRESOLVED` for unknown/missing network) plus a correlation id so ops can trace the request without exposing secrets.
- Authz: the gate is enforced server-side after authz (owner/delegate/guardian/API-key/JWT). A caller cannot bypass the gate by presenting a valid credential — authorization and the network gate are independent checks, and both must pass.
- Idempotency: replayed/concurrent faucet requests are deduplicated by request id so a retry cannot double-dispense; the gate decision is evaluated before any dispense side effect.
- Dependency outage: if the network/config source (RPC/DB/Horizon) is unavailable, the gate fails closed and denies the request rather than assuming testnet.
- Observability: emit a metric/log on every gate denial with the stable error code and correlation id; never log raw key material, JWTs, or webhook secrets.
- Rollback: the gate is deny-by-default and requires no flag to be safe; disabling the faucet entirely is the rollback path if a regression is suspected.

Cross-links: see `test/testnet-faucet-mainnet-gate.e2e-spec.ts` for the end-to-end coverage of these invariants.
