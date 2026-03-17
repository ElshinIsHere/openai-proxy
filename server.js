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

  // VoxImplant → OpenAI (с очисткой лишних полей)
  clientWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (sessionReady && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(data, { binary: true });
      }
    } else {
      let cleaned = data;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "session.update" && msg.session) {
          const ALLOWED = [
            "modalities", "instructions", "voice",
            "input_audio_format", "output_audio_format",
            "input_audio_transcription", "turn_detection",
            "temperature", "max_response_output_tokens",
            "tools", "tool_choice"
          ];
          const cleanSession = {};
          for (const key of ALLOWED) {
            if (msg.session[key] !== undefined) cleanSession[key] = msg.session[key];
          }
          msg.session = cleanSession;
          cleaned = JSON.stringify(msg);
          console.log("Cleaned session.update sent to OpenAI");
        }
      } catch(e) {}

      if (sessionReady && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(cleaned);
      } else {
        jsonQueue.push(cleaned);
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
    console.log("OpenAI disconnected", code, reason.toString());
    sessionReady = false;
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI error", err.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on("close", () => {
    console.log("VoxImplant disconnected");
    sessionReady = false;
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  clientWs.on("error", (err) => {
    console.error("VoxImplant error", err.message);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

server.listen(PORT, () => {
  console.log("Proxy running on port " + PORT);
});
