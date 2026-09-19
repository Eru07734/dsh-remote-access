#!/usr/bin/env python3
"""
mDNS responder for the LAN gateway.

Publishes A records so devices on the LAN resolve

    dsh.home.arpa  ->  <this machine's IPv4 addresses>

It answers standard mDNS queries (RFC 6762) sent to 224.0.0.251:5353.
Pure stdlib, no zeroconf dependency.

Design notes that matter in practice:
  * We join the multicast group on EVERY IPv4 interface, not just the default
    one. Windows otherwise only delivers multicast to one adapter and VMware /
    Tailscale clients never see the answer.
  * Unsolicited announcements are sent at startup and periodically, because
    many clients (and every Windows box without Bonjour) never send a query
    for a name until something else asks on their behalf.
  * Answers are sent from a plain ephemeral socket via sendto(); the QU bit is
    honoured so a legacy unicast query gets a unicast reply on the same port.
"""
import argparse
import ipaddress
import os
import socket
import struct
import sys
import threading
import time

MDNS_ADDR = "224.0.0.251"
MDNS_PORT = 5353

TYPE_A = 1
TYPE_PTR = 12
TYPE_TXT = 16
TYPE_AAAA = 28
TYPE_SRV = 33

CLASS_IN = 1
CLASS_QU = 0x8000  # unicast-response bit
CACHE_FLUSH = 0x8000

TTL = 120


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    # The launcher starts us detached with no inherited stdout pipe, so we own
    # our log file. This keeps `gateway.ps1 start` from blocking forever.
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(os.path.join(LOG_DIR, "mdns.out"), "a",
                  encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


def encode_name(name):
    out = b""
    for label in name.rstrip(".").split("."):
        b = label.encode("utf-8")
        if not b:
            continue
        out += bytes([len(b)]) + b
    return out + b"\x00"


def decode_name(data, offset):
    """Decode a possibly-compressed DNS name. Returns (name, new_offset)."""
    labels = []
    jumped = False
    orig = offset
    while True:
        if offset >= len(data):
            break
        length = data[offset]
        if length == 0:
            offset += 1
            break
        if length & 0xC0 == 0xC0:
            ptr = struct.unpack("!H", data[offset:offset + 2])[0] & 0x3FFF
            if not jumped:
                orig = offset + 2
                jumped = True
            offset = ptr
            continue
        labels.append(data[offset + 1:offset + 1 + length].decode("utf-8", "replace"))
        offset += 1 + length
    return ".".join(labels), (orig if jumped else offset)


def read_question(data, offset):
    name, offset = decode_name(data, offset)
    if offset + 4 > len(data):
        return None, offset
    qtype, qclass = struct.unpack("!HH", data[offset:offset + 4])
    return (name, qtype, qclass), offset + 4


def build_record(name, rtype, rdata, ttl=TTL, flush=False):
    cls = CLASS_IN | (CACHE_FLUSH if flush else 0)
    return (encode_name(name) + struct.pack("!HHIH", rtype, cls, ttl, len(rdata))
            + rdata)


def local_ipv4_addresses():
    """Every usable IPv4 address on this host, multicast-capable first."""
    addrs = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None,
                                       socket.AF_INET):
            addrs.add(info[4][0])
    except Exception:
        pass

    # Ask the routing table which source address reaches an off-box target.
    for probe in ("8.8.8.8", "1.1.1.1"):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((probe, 53))
            addrs.add(s.getsockname()[0])
        except Exception:
            pass
        finally:
            s.close()

    out = []
    for a in addrs:
        try:
            ip = ipaddress.IPv4Address(a)
        except Exception:
            continue
        if ip.is_loopback or ip.is_link_local or ip.is_multicast:
            continue
        out.append(str(ip))
    return sorted(out)


def iface_ipv4s():
    """Best-effort enumeration of (ip, netmask-less) bindable IPv4 interfaces."""
    ips = set(local_ipv4_addresses())
    # Probe common private ranges so adapters with no default route (VMware
    # host-only, Tailscale) still get their own socket.
    for target in ("192.168.10.1", "192.168.126.1", "100.64.0.1"):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((target, 1))
            ips.add(s.getsockname()[0])
        except Exception:
            pass
        finally:
            s.close()
    return sorted(ips)


class Responder:
    def __init__(self, hostname, addresses, aliases):
        self.hostname = hostname.rstrip(".")
        self.addresses = addresses
        self.aliases = [a.rstrip(".") for a in aliases]
        self.names = [self.hostname] + self.aliases

    def answer_records(self):
        """All records we are authoritative for, as a flat list."""
        recs = []
        for name in self.names:
            for ip in self.addresses:
                recs.append(build_record(name, TYPE_A,
                                         socket.inet_aton(ip), flush=True))
        return recs

    def build_response(self, query, unicast):
        if len(query) < 12:
            return None
        qdcount = struct.unpack("!H", query[4:6])[0]
        offset = 12
        questions = []
        for _ in range(qdcount):
            q, offset = read_question(query, offset)
            if q is None:
                break
            questions.append(q)
        if not questions:
            return None

        wanted = set()
        matched = False
        for name, qtype, qclass in questions:
            lname = name.rstrip(".").lower()
            if lname not in [n.lower() for n in self.names]:
                continue
            matched = True
            if qtype in (TYPE_A, 255):
                wanted.add(TYPE_A)
        if not matched:
            return None

        answers = []
        if TYPE_A in wanted or not wanted:
            for name in self.names:
                for ip in self.addresses:
                    answers.append(build_record(
                        name, TYPE_A, socket.inet_aton(ip), flush=True))

        header_flags = 0x8400  # QR + AA
        resp = struct.pack("!HHHHHH", 0, header_flags, 0, len(answers), 0, 0)
        body = b"".join(answers)
        # Echo the questions for a legacy unicast query.
        if unicast:
            qsec = b""
            off = 12
            for _ in range(qdcount):
                start = off
                _, off = read_question(query, off)
                qsec += query[start:off]
            resp = struct.pack("!HHHHHH", 0, header_flags, qdcount,
                               len(answers), 0, 0)
            body = qsec + body
        return resp + body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="dsh.home.arpa")
    ap.add_argument("--alias", action="append", default=[],
                    help="extra names to publish (repeatable)")
    ap.add_argument("--ip", action="append", default=[],
                    help="override addresses (repeatable)")
    args = ap.parse_args()

    addrs = args.ip if args.ip else iface_ipv4s()
    if not addrs:
        log("[fatal] no IPv4 addresses discovered")
        return 1

    responder = Responder(args.host, addrs, args.alias)
    log(f"[mdns] publishing {responder.names} -> {addrs}")

    # One listener socket joined to the group on every interface, so multicast
    # arrives no matter which adapter the client's traffic came in on.
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, True)
    try:
        sock.bind(("", MDNS_PORT))
    except OSError as exc:
        log(f"[fatal] cannot bind UDP {MDNS_PORT}: {exc}")
        return 1

    joined = []
    for ip in addrs:
        try:
            mreq = socket.inet_aton(MDNS_ADDR) + socket.inet_aton(ip)
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            joined.append(ip)
        except OSError as exc:
            log(f"[mdns] join {ip} failed: {exc}")
    if not joined:
        log("[fatal] could not join the mDNS group on any interface")
        return 1
    log(f"[mdns] joined multicast group on {joined}")

    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)

    # Announcement socket: source port must be 5353 for compliant responders.
    ann = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    ann.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, True)
    ann.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
    try:
        ann.bind(("", MDNS_PORT))
    except OSError:
        pass

    def announce(tag):
        payload = responder.build_announcement()
        sent = 0
        for _ in range(2):
            for ip in joined:
                try:
                    ann.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF,
                                   socket.inet_aton(ip))
                    ann.sendto(payload, (MDNS_ADDR, MDNS_PORT))
                    sent += 1
                except OSError:
                    pass
            time.sleep(0.25)
        log(f"[mdns] {tag} announcement sent on {sent} interface(s)")

    def announce_loop():
        time.sleep(1)
        announce("startup")
        while True:
            time.sleep(60)
            announce("periodic")

    threading.Thread(target=announce_loop, daemon=True).start()

    log("[ready] listening for mDNS queries on 5353")
    while True:
        try:
            data, addr = sock.recvfrom(9000)
        except OSError as exc:
            log(f"[mdns] recv error: {exc}")
            time.sleep(1)
            continue
        if len(data) < 12:
            continue
        flags = struct.unpack("!H", data[2:4])[0]
        if flags & 0x8000:  # a response, not a query
            continue
        # Legacy unicast query: source port != 5353 -> reply unicast.
        unicast = addr[1] != MDNS_PORT
        resp = responder.build_response(data, unicast)
        if not resp:
            continue
        try:
            if unicast:
                sock.sendto(resp, addr)
                log(f"[mdns] unicast answer -> {addr[0]}:{addr[1]}")
            else:
                sock.sendto(resp, (MDNS_ADDR, MDNS_PORT))
                log(f"[mdns] multicast answer -> {addr[0]}")
        except OSError as exc:
            log(f"[mdns] send error: {exc}")
    return 0


def _build_announcement(self):
    answers = self.answer_records()
    header = struct.pack("!HHHHHH", 0, 0x8400, 0, len(answers), 0, 0)
    return header + b"".join(answers)


Responder.build_announcement = _build_announcement


if __name__ == "__main__":
    sys.exit(main())
