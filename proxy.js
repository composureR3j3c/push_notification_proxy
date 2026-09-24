const http = require("http");
const https = require("https");
const http2 = require("http2");

const PORT = 8084;

const ALLOWED_HOSTS = new Set([
    "fcm.googleapis.com",
    "oauth2.googleapis.com",
    "accounts.google.com",
    "www.googleapis.com",
    "securetoken.googleapis.com"
]);

const MAX_LOGGED_BODY_BYTES = 2000;

function isAllowedHost(host) {

    // Allow any Apple Push Notification host
    if (host.endsWith(".push.apple.com")) {
        return true;
    }

    // Allow specific Google hosts
    return ALLOWED_HOSTS.has(host);
}

function getTargetHost(hostHeader) {

    if (!hostHeader) {
        return null;
    }

    return hostHeader
        .toLowerCase()
        .replace(/:\d+$/, "");
}

function sendError(res, status, message) {

    if (!res.headersSent) {
        res.writeHead(status, {
            "Content-Type": "application/json"
        });
    }

    res.end(JSON.stringify({
        error: message
    }));
}


// Bearer tokens for FCM/APNs pass through this header; never write them
// to logs in full.
function maskAuthValue(value) {

    const str = Array.isArray(value) ? value.join(", ") : String(value);

    if (str.length <= 12) {
        return "***redacted***";
    }

    return `${str.slice(0, 10)}...***redacted***`;
}

function redactHeaders(headers) {

    const redacted = {};

    for (const [key, value] of Object.entries(headers || {})) {

        redacted[key] = key.toLowerCase() === "authorization" ?
            maskAuthValue(value) :
            value;
    }

    return redacted;
}


// Tees a stream's body into a Buffer for logging without disturbing
// whatever else (pipe, etc.) also consumes it. Resolves on error too,
// with whatever was read so far, so logging never hangs a request.
function collectBody(stream) {

    return new Promise((resolve) => {

        const chunks = [];

        stream.on("data", (chunk) => {
            chunks.push(chunk);
        });

        stream.on("end", () => {
            resolve(Buffer.concat(chunks));
        });

        stream.on("error", () => {
            resolve(Buffer.concat(chunks));
        });
    });
}

function describeBody(buffer) {

    return {
        body: buffer.slice(0, MAX_LOGGED_BODY_BYTES).toString("utf8"),
        body_size: buffer.length,
        body_truncated: buffer.length > MAX_LOGGED_BODY_BYTES
    };
}

// Emits one structured JSON line per transaction (request + response +
// latency), Kong access-log-plugin style, instead of several free-text
// console.log calls per request.
function emitLog(entry) {
    console.log(JSON.stringify(entry));
}

// Builds a logger bound to one request. Call the returned function
// exactly once, whichever way the request finishes (success, rejected,
// or upstream error), to emit the access-log line for it.
function createRequestLogger(req) {

    const startedAt = Date.now();
    const clientIp = req.socket.remoteAddress;
    const requestBodyPromise = collectBody(req);

    let logged = false;

    return function logAndFinish(fields) {

        if (logged) {
            return;
        }

        logged = true;

        requestBodyPromise.then((reqBodyBuffer) => {

            emitLog({
                client_ip: clientIp,
                started_at: new Date(startedAt).toISOString(),
                latencies: {
                    proxy_ms: Date.now() - startedAt
                },
                request: {
                    method: req.method,
                    uri: req.url,
                    headers: redactHeaders(req.headers),
                    ...describeBody(reqBodyBuffer)
                },
                response: fields.response,
                upstream_uri: fields.upstreamUri || null
            });
        });
    };
}

function emptyResponseLog(status, message) {

    return {
        status,
        headers: {},
        body: message,
        body_size: Buffer.byteLength(message),
        body_truncated: false
    };
}


const server = http.createServer((req, res) => {

    const logAndFinish = createRequestLogger(req);

    const match = req.url.match(/^\/proxy(\/.*)?$/);

    if (!match) {
        logAndFinish({
            response: emptyResponseLog(400, "Invalid proxy URL")
        });
        return sendError(res, 400, "Invalid proxy URL");
    }

    const targetHost = getTargetHost(req.headers.host);
    const targetPath = match[1] || "/";

    if (!targetHost) {
        logAndFinish({
            response: emptyResponseLog(400, "Host header is required")
        });
        return sendError(res, 400, "Host header is required");
    }

    if (!isAllowedHost(targetHost)) {
        logAndFinish({
            upstreamUri: `${targetHost}${targetPath}`,
            response: emptyResponseLog(403, "Destination not allowed")
        });
        return sendError(res, 403, "Destination not allowed");
    }

    const upstreamUri = `https://${targetHost}${targetPath}`;


    /*
     * ============================================================
     * APPLE APNS
     * HTTP/2
     * ============================================================
     */

    if (targetHost.endsWith(".push.apple.com")) {

        const client = http2.connect(
            `https://${targetHost}:443`,
            {
                servername: targetHost
            }
        );

        client.on("error", (err) => {

            logAndFinish({
                upstreamUri,
                response: emptyResponseLog(502, err.message)
            });

            if (!res.headersSent) {
                sendError(res, 502, err.message);
            }
        });


        const headers = {};

        for (const [key, value] of Object.entries(req.headers)) {

            const lower = key.toLowerCase();

            if (
                lower === "host" ||
                lower === "connection" ||
                lower === "content-length"
            ) {
                continue;
            }

            headers[lower] = value;
        }

        headers[":method"] = req.method;
        headers[":path"] = targetPath;
        headers[":authority"] = targetHost;


        const stream = client.request(headers);


        stream.on("response", (responseHeaders) => {

            const status = responseHeaders[":status"];

            const cleanHeaders = {};

            for (const [key, value] of Object.entries(responseHeaders)) {

                if (key.startsWith(":")) {
                    continue;
                }

                cleanHeaders[key] = value;
            }

            const responseBodyPromise = collectBody(stream);

            responseBodyPromise.then((resBodyBuffer) => {
                logAndFinish({
                    upstreamUri,
                    response: {
                        status,
                        headers: redactHeaders(cleanHeaders),
                        ...describeBody(resBodyBuffer)
                    }
                });
            });

            res.writeHead(
                status,
                cleanHeaders
            );

            stream.pipe(res);
        });


        stream.on("error", (err) => {

            logAndFinish({
                upstreamUri,
                response: emptyResponseLog(502, err.message)
            });

            if (!res.headersSent) {
                sendError(res, 502, err.message);
            }
        });


        /*
         * req.pipe(stream) automatically ends the stream
         * when the incoming request finishes.
         *
         * Do NOT call stream.end() separately.
         */
        req.pipe(stream);


        res.on("close", () => {

            try {
                client.close();
            } catch (e) {
                // Ignore
            }

        });

        return;
    }


    /*
     * ============================================================
     * GOOGLE
     * HTTP/1.1
     * ============================================================
     */

    const options = {

        hostname: targetHost,

        port: 443,

        path: targetPath,

        method: req.method,

        headers: {
            ...req.headers,
            host: targetHost,
            connection: "close"
        },

        servername: targetHost,

        timeout: 30000
    };


    delete options.headers["proxy-connection"];


    const upstream = https.request(
        options,
        (upstreamRes) => {

            const responseBodyPromise = collectBody(upstreamRes);

            responseBodyPromise.then((resBodyBuffer) => {
                logAndFinish({
                    upstreamUri,
                    response: {
                        status: upstreamRes.statusCode,
                        headers: redactHeaders(upstreamRes.headers),
                        ...describeBody(resBodyBuffer)
                    }
                });
            });

            res.writeHead(
                upstreamRes.statusCode,
                upstreamRes.headers
            );

            upstreamRes.pipe(res);
        }
    );


    upstream.on("timeout", () => {

        upstream.destroy();

        logAndFinish({
            upstreamUri,
            response: emptyResponseLog(504, "Upstream timeout")
        });

        if (!res.headersSent) {
            sendError(res, 504, "Upstream timeout");
        }

    });


    upstream.on("error", (err) => {

        logAndFinish({
            upstreamUri,
            response: emptyResponseLog(502, err.message)
        });

        if (!res.headersSent) {
            sendError(res, 502, err.message);
        }

    });


    req.pipe(upstream);

});


server.listen(
    PORT,
    "127.0.0.1",
    () => {

        console.log(
            `Outbound proxy listening on 127.0.0.1:${PORT}`
        );

    }
);
