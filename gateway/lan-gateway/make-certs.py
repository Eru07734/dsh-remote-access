#!/usr/bin/env python3
"""
Local CA + server certificate generator for the LAN gateway.

Creates:
  certs/ca.crt / ca.key          - local root CA (install ca.crt as trusted root)
  certs/<domain>.crt / .key      - server cert with SAN for every hostname + IP

Idempotent: re-running keeps the existing CA (so already-installed roots stay
valid) and only regenerates the leaf certificate.

Usage:
  python make-certs.py                 # uses defaults below
  python make-certs.py --domains a.home.arpa,b.home.arpa
"""
import argparse
import datetime as dt
import ipaddress
import os
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

HERE = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(HERE, "certs")

# LAN IPs the certificate must be valid for.
#   <home-lan-ip>  physical LAN (WLAN)
#   192.168.10.1   VMware VMnet1 (host-only)
#   192.168.126.1  VMware VMnet8 (NAT)
#   <host-tailnet-ip>  Tailscale (this host)
IPS = ["<home-lan-ip>", "192.168.10.1", "192.168.126.1", "<host-tailnet-ip>",
       "127.0.0.1"]
# Names the certificate must be valid for. The Tailscale MagicDNS name is the
# host's own name: Tailscale peers reach this machine by that name, and a browser
# compares it against the address actually typed, so it has to be in the SAN.
HOSTS = ["dsh.home.arpa", "admin.<tailnet>.ts.net", "localhost"]

CA_DAYS = 3650
LEAF_DAYS = 825  # browsers reject leaf certs valid for longer than 825 days


def _write(path, data: bytes):
    with open(path, "wb") as fh:
        fh.write(data)


def load_or_create_ca():
    ca_crt = os.path.join(CERT_DIR, "ca.crt")
    ca_key = os.path.join(CERT_DIR, "ca.key")

    if os.path.exists(ca_crt) and os.path.exists(ca_key):
        with open(ca_crt, "rb") as fh:
            cert = x509.load_pem_x509_certificate(fh.read())
        with open(ca_key, "rb") as fh:
            key = serialization.load_pem_private_key(fh.read(), password=None)
        print(f"[ca] reusing existing CA: {cert.subject.rfc4514_string()}")
        return cert, key

    print("[ca] generating new root CA (10 years)")
    key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "DSH LAN Gateway Root CA"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "DSH LAN Gateway"),
    ])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=CA_DAYS))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, key_cert_sign=True, crl_sign=True,
                content_commitment=False, key_encipherment=False,
                data_encipherment=False, key_agreement=False,
                encipher_only=False, decipher_only=False,
            ), critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    _write(ca_crt, cert.public_bytes(serialization.Encoding.PEM))
    _write(ca_key, key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
    print(f"[ca] wrote {ca_crt}")
    return cert, key


def make_leaf(ca_cert, ca_key, hosts, ips):
    print(f"[leaf] issuing for hosts={hosts} ips={ips}")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    sans = [x509.DNSName(h) for h in hosts]
    sans += [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]

    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, hosts[0]),
        ]))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=LEAF_DAYS))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None),
                       critical=True)
        .add_extension(x509.SubjectAlternativeName(sans), critical=False)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, key_encipherment=True,
                content_commitment=False, data_encipherment=False,
                key_agreement=False, key_cert_sign=False, crl_sign=False,
                encipher_only=False, decipher_only=False,
            ), critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([x509.ObjectIdentifier("1.3.6.1.5.5.7.3.1")]),
            critical=False,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(
                ca_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )

    base = os.path.join(CERT_DIR, hosts[0])
    _write(base + ".crt", cert.public_bytes(serialization.Encoding.PEM))
    _write(base + ".key", key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
    print(f"[leaf] wrote {base}.crt and {base}.key")
    return base + ".crt", base + ".key"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--domains", default=",".join(HOSTS),
                    help="comma-separated hostnames for the SAN")
    ap.add_argument("--ips", default=",".join(IPS))
    args = ap.parse_args()

    hosts = [h.strip() for h in args.domains.split(",") if h.strip()]
    ips = [i.strip() for i in args.ips.split(",") if i.strip()]

    os.makedirs(CERT_DIR, exist_ok=True)
    ca_cert, ca_key = load_or_create_ca()
    crt, key = make_leaf(ca_cert, ca_key, hosts, ips)

    # Verify the chain we just produced actually validates.
    from cryptography.hazmat.primitives.asymmetric import padding
    ca_pub = ca_cert.public_key()
    with open(crt, "rb") as fh:
        leaf = x509.load_pem_x509_certificate(fh.read())
    ca_pub.verify(
        leaf.signature,
        leaf.tbs_certificate_bytes,
        padding.PKCS1v15(),
        leaf.signature_hash_algorithm,
    )
    print("[verify] leaf signature validated against CA: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
