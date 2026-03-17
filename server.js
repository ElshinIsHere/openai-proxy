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
    let messageQueue = [];
    let openaiReady = false;

    // Connect to OpenAI
    openaiWs = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
        {
            headers: {
                "Authorization": "Bearer " + OPENAI_API_KEY,
                "OpenAI-Beta": "realtime=v1"
            }
        }
    );

    openaiWs.on("open", () => {
        console.log("OpenAI connected — flushing " + messageQueue.length + " queued messages");
        openaiReady = true;
        // Flush buffered messages
        messageQueue.forEach(msg => openaiWs.send(msg));
        messageQueue = [];
    });

    // VoxImplant → OpenAI
    clientWs.on("message", (data) => {
        if (openaiReady && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(data);
        } else {
            // Buffer until OpenAI is ready
            messageQueue.push(data);
            console.log("Queued message, total: " + messageQueue.length);
        }
    });

    // OpenAI → VoxImplant
    openaiWs.on("message", (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data);
        }
    });

    openaiWs.on("close", (code, reason) => {
        console.log("OpenAI disconnected:", code, reason.toString());
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    });

    openaiWs.on("error", (err) => {
        console.error("OpenAI error:", err.message);
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    });

    clientWs.on("close", () => {
        console.log("VoxImplant disconnected");
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
