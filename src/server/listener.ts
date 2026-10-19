/**
 * The listening server: plain HTTP/1.1, or, given a certificate, HTTP/2 over TLS with HTTP/1.1 for older clients.
 * HTTP/2 multiplexes every request of a browser over one connection, so open event streams (one per tab) no longer
 * use up the browser's six HTTP/1.1 connections per address while images and API calls wait behind them.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { constants, createSecureServer, type Http2SecureServer } from "node:http2";
import type { Socket } from "node:net";

export type Listener = Server | Http2SecureServer;

export type Tls = { cert: Buffer; key: Buffer };

/** Read the PEM certificate chain and private key named on the command line, failing with a readable reason. */
export function readTls(
    certFile: string | undefined,
    keyFile: string | undefined,
): Tls | undefined {
    if (certFile === undefined && keyFile === undefined) {
        return undefined;
    }

    if (certFile === undefined || keyFile === undefined) {
        throw new Error("--tls-cert and --tls-key go together");
    }

    const read = (file: string, what: string) => {
        try {
            return readFileSync(file);
        } catch (error) {
            throw new Error(`Could not read the TLS ${what} ${file}: ${(error as Error).message}`);
        }
    };

    return { cert: read(certFile, "certificate"), key: read(keyFile, "key") };
}

/**
 * The server for `handle`. The handler is written against the HTTP/1.1 request and response; Node's HTTP/2
 * compatibility objects implement the parts it uses (headers, status, streaming bodies, `close`). Connection-level
 * headers such as `connection: keep-alive` must not be sent over HTTP/2: callers check `httpVersionMajor`.
 */
export function createListener(
    handle: (request: IncomingMessage, response: ServerResponse) => void,
    tls?: Tls,
): { server: Listener; closeAll(): void } {
    // Entire upload within 15 minutes, with one minute to deliver HTTP/1.1 headers. HTTP/2 header blocks are
    // bounded by Node's HTTP/2 implementation; its body deadline is tracked separately below.
    const timeouts = { requestTimeout: 15 * 60_000, headersTimeout: 60_000 };

    if (tls === undefined) {
        const server = createServer(timeouts, handle);

        return { server, closeAll: () => server.closeAllConnections() };
    }

    const server = createSecureServer(
        { ...timeouts, cert: tls.cert, key: tls.key, allowHTTP1: true },
        handle as unknown as Parameters<typeof createSecureServer>[1],
    );
    // Every connection, HTTP/2 or the HTTP/1.1 fallback, so stopping does not wait for open event streams.
    const sockets = new Set<Socket>();

    server.on("connection", (socket: Socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    server.on("stream", (stream, _headers, flags) => {
        if ((flags & constants.NGHTTP2_FLAG_END_STREAM) !== 0) {
            return;
        }

        // An HTTP/2 body can otherwise trickle indefinitely. Do not put a deadline on the response: event streams
        // and long polls are intentionally long-lived. Cancel incomplete uploads, letting pipeline clean up.
        const timer = setTimeout(
            () => stream.close(constants.NGHTTP2_CANCEL),
            timeouts.requestTimeout,
        );
        const clear = () => clearTimeout(timer);

        timer.unref();
        stream.once("end", clear);
        stream.once("close", clear);
    });

    return {
        server,
        closeAll: () => {
            for (const socket of sockets) {
                socket.destroy();
            }
        },
    };
}
