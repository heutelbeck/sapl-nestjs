#!/usr/bin/env bash
# Regenerate the TLS test fixture certs. Run from this directory.
# Output: ca.pem, ca.key, server.pem, server.key (10-year validity).
# Test code reads ca.pem as the client trust anchor; the SAPL Node
# container mounts server.pem / server.key as its keystore PEM bundle.

set -euo pipefail
cd "$(dirname "$0")"

openssl req -x509 -newkey rsa:2048 -keyout ca.key -out ca.pem \
  -days 3650 -nodes -config ca.cnf -extensions v3_ca
openssl req -newkey rsa:2048 -keyout server.key -out server.csr \
  -nodes -config server.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key \
  -CAcreateserial -out server.pem -days 3650 \
  -extensions v3_req -extfile server.cnf
rm -f server.csr ca.srl

echo "Regenerated TLS fixture certs. Expiry: $(openssl x509 -enddate -noout -in server.pem)"
