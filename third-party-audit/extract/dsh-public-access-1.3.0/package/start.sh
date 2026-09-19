#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== DeepSeek Harness Public Access Mode ==="

# Plugin auth (username/password) configuration. The dsh launch token printed
# below is an alternative auth path; either logging in via the login page or
# opening the token URL grants access.
export DSH_AUTH_USER="${DSH_AUTH_USER:-admin}"
export DSH_AUTH_PASS="${DSH_AUTH_PASS:-admin}"
echo "Auth user: $DSH_AUTH_USER"

# Detect public IP
PUBLIC_IP=$(curl -s --connect-timeout 3 ifconfig.me 2>/dev/null || echo "")
echo "Public IP: ${PUBLIC_IP:-unknown}"

# Detect LAN IPs
LAN_IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' || echo "")
echo "LAN IPs: $LAN_IPS"

PORT="${DSH_PORT:-3080}"

# Build --trusted-host args. dsh always trusts loopback and auto-derives LAN
# IPv4 literals when binding 0.0.0.0, so only the public IP strictly needs
# declaring; LAN entries are added explicitly as a harmless belt-and-suspenders.
TRUSTED_HOST_ARGS=""
add_trusted() {
    TRUSTED_HOST_ARGS="$TRUSTED_HOST_ARGS --trusted-host $1"
}
[ -n "$PUBLIC_IP" ] && add_trusted "$PUBLIC_IP"
for ip in $LAN_IPS; do
    add_trusted "$ip"
done

echo "Port: $PORT"
echo "============================================="

# Bind all interfaces (the plugin's web-startup lifts dsh's 0.0.0.0 safety
# rejection) and gate access through dsh-public-access auth.
exec dsh --profile web --no-open --host 0.0.0.0 --port "$PORT" $TRUSTED_HOST_ARGS "$@"
