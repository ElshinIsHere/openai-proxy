const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("OpenAI Realtime Proxy OK");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (clientWs) => {
    console.log("VoxImplant connected");

    let openaiWs = null;
    let jsonQueue = [];
    let sessionReady = false;

    openaiWs = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2025-06-03",
        {
            headers: {
                "Authorization": "Bearer " + OPENAI_API_KEY,
                "OpenAI-Beta": "realtime=v1"
            }
        }
    );

    openaiWs.on("open", () => {
        console.log("OpenAI connected — flushing " + jsonQueue.length + " queued JSON messages");
        jsonQueue.forEach(msg => openaiWs.send(msg));
        jsonQueue = [];
        sessionReady = true;
    });

    // VoxImplant → OpenAI
    clientWs.on("message", (data, isBinary) => {
        if (isBinary) {
            // Audio — only send if OpenAI is ready
            if (sessionReady && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(data, { binary: true });
            }
            // Drop audio if not ready — that's fine, it will catch up
        } else {
            // JSON control message — queue if not ready
            if (sessionReady && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.send(data);
            } else {
                jsonQueue.push(data);
                console.log("Queued JSON, total: " + jsonQueue.length);
            }
        }
    });

    // OpenAI → VoxImplant
    openaiWs.on("message", (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data, { binary: isBinary });
        }
    });

    openaiWs.on("close", (code, reason) => {
        console.log("OpenAI disconnected:", code, reason.toString());
        sessionReady = false;
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    });

    openaiWs.on("error", (err) => {
        console.error("OpenAI error:", err.message);
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    });

    clientWs.on("close", () => {
        console.log("VoxImplant disconnected");
        sessionReady = false;
        if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    });

    clientWs.on("error", (err) => {
        console.error("VoxImplant error:", err.message);
        if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    });
});

server.listen(PORT, () => {
    console.log("Proxy running on port " + PORT);
});
