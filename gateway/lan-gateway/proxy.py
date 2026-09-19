#!/usr/bin/env python3
"""
LAN gateway reverse proxy:  HTTPS :443  ->  127.0.0.1:3080

Deliberately dependency-free (Python stdlib only) so it cannot break when a
venv is rebuilt. Handles the two things that actually matter here:

  * WebSocket / HTTP Upgrade tunnelling (the DSH GUI is useless without it)
  * HTTP/1.1 keep-alive, chunked bodies, and streaming responses

Routing is a host table, so adding a service later is one line in ROUTES.

Config file: routes.json  (optional)
  { "dsh.home.arpa": {"host":"127.0.0.1","port":3080,"tls":false} }
"""
import json
import os
import socket
import ssl
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(HERE, "certs")
LOG_DIR = os.path.join(HERE, "logs")

LISTEN_PORT = 443
LISTEN_ADDR = "0.0.0.0"

# hostname (lowercase, no port) -> backend
ROUTES = {
    "dsh.home.arpa": {"host": "127.0.0.1", "port": 3080, "tls": False},
    "localhost": {"host": "127.0.0.1", "port": 3080, "tls": False},
}
DEFAULT_ROUTE = "dsh.home.arpa"

BUFSIZE = 65536
CONNECT_TIMEOUT = 10
IDLE_TIMEOUT = 300


def load_routes():
    path = os.path.join(HERE, "routes.json")
    if not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        for k, v in data.items():
            ROUTES[k.lower()] = v
        log(f"[cfg] loaded {len(data)} route(s) from routes.json")
    except Exception as exc:
        log(f"[cfg] routes.json ignored: {exc}")


_lock = threading.Lock()
_logfh = None


def log(msg):
    global _logfh
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    with _lock:
        print(line, flush=True)
        try:
            if _logfh is None:
                os.makedirs(LOG_DIR, exist_ok=True)
                _logfh = open(os.path.join(LOG_DIR, "proxy.log"), "a",
                              encoding="utf-8", buffering=1)
            _logfh.write(line + "\n")
        except Exception:
            pass


def parse_request(head):
    """Return (method, target, version, headers_dict, raw_header_bytes)."""
    try:
        text = head.decode("iso-8859-1")
    except Exception:
        return None
    lines = text.split("\r\n")
    if not lines or not lines[0]:
        return None
    parts = lines[0].split(" ")
    if len(parts) < 3:
        return None
    method, target, version = parts[0], parts[1], parts[2]

    headers = {}
    for ln in lines[1:]:
        if not ln or ":" not in ln:
            continue
        k, v = ln.split(":", 1)
        headers[k.strip().lower()] = v.strip()
    return method, target, version, headers, head


def pump(src, dst, label):
    """Copy bytes until EOF. Shutdown write half so the peer sees EOF."""
    total = 0
    try:
        src.settimeout(IDLE_TIMEOUT)
        while True:
            data = src.recv(BUFSIZE)
            if not data:
                break
            dst.sendall(data)
            total += len(data)
    except (socket.timeout, TimeoutError):
        log(f"[{label}] idle timeout after {total} bytes")
    except OSError as exc:
        if getattr(exc, "errno", None) not in (10053, 10054, 9, 104, 32):
            log(f"[{label}] {type(exc).__name__}: {exc}")
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass
    return total


def select_route(headers):
    host = headers.get("host", "")
    # strip :port, handle IPv6 literal
    if host.startswith("["):
        host = host.split("]")[0].lstrip("[")
    else:
        host = host.split(":")[0]
    host = host.strip().lower().rstrip(".")
    route = ROUTES.get(host)
    if route:
        return host, route
    return host, ROUTES[DEFAULT_ROUTE]


def handle(client, addr, ctx):
    label = f"{addr[0]}:{addr[1]}"
    backend = None
    try:
        try:
            tls_conn = ctx.wrap_socket(client, server_side=True)
        except (ssl.SSLError, OSError) as exc:
            log(f"[{label}] TLS handshake failed: {exc}")
            client.close()
            return

        tls_conn.settimeout(IDLE_TIMEOUT)
        # Read just the header block, byte by byte until CRLFCRLF.
        head = b""
        while b"\r\n\r\n" not in head and len(head) < 65536:
            chunk = tls_conn.recv(1)
            if not chunk:
                tls_conn.close()
                return
            head += chunk

        parsed = parse_request(head)
        if not parsed:
            tls_conn.close()
            return
        method, target, version, headers, raw_head = parsed

        host, route = select_route(headers)
        is_upgrade = ("upgrade" in headers.get("connection", "").lower()
                      or "upgrade" in headers.get("proxy-connection", "").lower())

        log(f"[{label}] {method} {target} host={host} "
            f"-> {route['host']}:{route['port']}{' [WS]' if is_upgrade else ''}")

        backend = socket.create_connection(
            (route["host"], route["port"]), timeout=CONNECT_TIMEOUT)
        backend.settimeout(IDLE_TIMEOUT)

        if route.get("tls"):
            bctx = ssl.create_default_context()
            bctx.check_hostname = False
            bctx.verify_mode = ssl.CERT_NONE
            backend = bctx.wrap_socket(
                backend, server_hostname=route.get("sni") or route["host"])

        # Forward the request verbatim, but make sure the backend can build
        # correct absolute URLs and knows the original scheme.
        hdrs = dict(headers)
        hdrs.setdefault("x-forwarded-proto", "https")
        hdrs["x-forwarded-for"] = addr[0]
        hdrs["x-forwarded-host"] = headers.get("host", host)

        rebuilt = [f"{method} {target} {version}"]
        skip = {"x-forwarded-proto", "x-forwarded-for", "x-forwarded-host"}
        for ln in raw_head.decode("iso-8859-1").split("\r\n")[1:]:
            if not ln:
                continue
            k = ln.split(":", 1)[0].strip().lower()
            if k in skip:
                continue
            rebuilt.append(ln)
        rebuilt.append("X-Forwarded-Proto: https")
        rebuilt.append(f"X-Forwarded-For: {addr[0]}")
        rebuilt.append(f"X-Forwarded-Host: {headers.get('host', host)}")
        backend.sendall(("\r\n".join(rebuilt) + "\r\n\r\n").encode("iso-8859-1"))

        # Byte-pump both directions. This is what carries HTTP bodies AND
        # WebSocket frames; for HTTP/1.1 the client closing keeps it bounded.
        t1 = threading.Thread(target=pump, args=(tls_conn, backend, f"{label} up"),
                              daemon=True)
        t1.start()
        up = pump(backend, tls_conn, f"{label} down")
        t1.join(timeout=IDLE_TIMEOUT)
        log(f"[{label}] closed ({up} bytes down)")
    except Exception as exc:
        log(f"[{label}] ERROR {type(exc).__name__}: {exc}")
    finally:
        for s in (backend, client):
            try:
                if s:
                    s.close()
            except Exception:
                pass


def main():
    crt = os.path.join(CERT_DIR, "dsh.home.arpa.crt")
    key = os.path.join(CERT_DIR, "dsh.home.arpa.key")
    if not (os.path.exists(crt) and os.path.exists(key)):
        log(f"[fatal] missing cert/key in {CERT_DIR}; run make-certs.py first")
        return 1

    # Loaded here, not at import time, so the route table is logged after the
    # logger is usable and the operator can see what was actually registered.
    load_routes()

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(crt, key)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        ctx.set_alpn_protocols(["http/1.1"])
    except NotImplementedError:
        pass

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, True)
    try:
        srv.bind((LISTEN_ADDR, LISTEN_PORT))
    except OSError as exc:
        log(f"[fatal] cannot bind {LISTEN_ADDR}:{LISTEN_PORT} -> {exc}")
        return 1
    srv.listen(128)

    for h, r in ROUTES.items():
        log(f"[route] https://{h}  ->  {r['host']}:{r['port']}")
    log(f"[ready] listening on https://{LISTEN_ADDR}:{LISTEN_PORT}")
    # Flush the log to disk now so a failed start is diagnosable.
    try:
        if _logfh is not None:
            _logfh.flush()
    except Exception:
        pass
    try:
        while True:
            client, addr = srv.accept()
            threading.Thread(target=handle, args=(client, addr, ctx),
                             daemon=True).start()
    except KeyboardInterrupt:
        log("[stop] interrupted")
    finally:
        srv.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
