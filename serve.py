#!/usr/bin/env python3
"""Serve the app, starting at the requested port and taking the next free one."""
import contextlib
import errno
import http.server
import socket
import sys

ATTEMPTS = 50


class Server(http.server.ThreadingHTTPServer):
    # Listen on IPv4 and IPv6 together, and never share a port with another server.
    address_family = socket.AF_INET6
    allow_reuse_address = False

    def server_bind(self):
        with contextlib.suppress(Exception):
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def answering(port):
    """True if something already accepts connections on this port."""
    for host in ("127.0.0.1", "::1"):
        with contextlib.suppress(OSError), socket.create_connection((host, port), timeout=0.2):
            return True
    return False


def open_server(first):
    for port in range(first, first + ATTEMPTS):
        if not answering(port):
            try:
                return Server(("::", port), http.server.SimpleHTTPRequestHandler)
            except OSError as error:
                if error.errno != errno.EADDRINUSE:
                    raise
        print(f"Port {port} is in use, trying {port + 1}", flush=True)
    sys.exit(f"No free port between {first} and {first + ATTEMPTS - 1}")


def main():
    server = open_server(int(sys.argv[1]) if len(sys.argv) > 1 else 4173)
    print(f"Serving on http://localhost:{server.server_address[1]}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
