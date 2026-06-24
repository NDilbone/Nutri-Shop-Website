# Security Policy

## Reporting a vulnerability
Email security reports privately to the repository owner. Do not open a public
issue for security problems. You will receive an acknowledgement within a few days.

## Scope
This is a private application. Secrets are never committed; the public anon key is
gated by Postgres Row Level Security. Report any case where one user's data is
reachable by another, or where a secret appears in the repo or client bundle.
