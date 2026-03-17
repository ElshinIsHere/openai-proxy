const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OpenAI Realtime Proxy OK");
});

const wss = new WebSocketServer({ server });

function downsample24to16(buffer) {
  const inputSamples = buffer.length / 2;
  const outputSamples = Math.floor(inputSamples * 2 / 3);
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const srcIndex = Math.floor(i * 3 / 2);
    const sample = buffer.readInt16LE(srcIndex * 2);
    output.writeInt16LE(sample, i * 2);
  }
  return output;
}

function cleanSessionUpdate(raw) {
  try {
    const msg = JSON.parse(raw.toString());
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
      console.log("Cleaned session.update");
      return JSON.stringify(msg);
    }
  } catch(e) {}
  return raw;
}

wss.on("connection", (clientWs) => {
  console.log("VoxImplant connected");

  let openaiWs = null;
  let jsonQueue = [];
  let sessionReady = false;

  openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  openaiWs.on("open", () => {
    console.log("OpenAI connected — flushing " + jsonQueue.length + " queued JSON messages");
    jsonQueue.forEach(raw => {
      openaiWs.send(cleanSessionUpdate(raw));
    });
    jsonQueue = [];
    sessionReady = true;
  });

  clientWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (sessionReady && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(data, { binary: true });
      }
      return;
    }

    const str = data.toString();

    try {
      const msg = JSON.parse(str);

      if (msg.event === "media" && msg.media && msg.media.payload) {
        if (sessionReady && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload
          }));
        }
        return;
      }

      if (!msg.type) {
        console.log("Dropping unknown message, keys: " + Object.keys(msg).join(", "));
        return;
      }

      console.log("VOX → OPENAI type: " + msg.type);

      if (msg.type === "input_audio_buffer.append") {
        if (sessionReady && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(str);
        }
        return;
      }

    } catch(e) {
      console.log("Non-JSON dropped");
      return;
    }

    const cleaned = cleanSessionUpdate(data);
    if (sessionReady && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(cleaned);
    } else {
      jsonQueue.push(cleaned);
      console.log("Queued JSON, total: " + jsonQueue.length);
    }
  });

  openaiWs.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        console.log("OPENAI → VOX type: " + msg.type);

        if (msg.type === "session.updated") {
          console.log("Session updated — sending response.create from proxy");
          openaiWs.send(JSON.stringify({ type: "response.create" }));
        }

        if (msg.type === "response.audio.delta" && msg.delta) {
          if (clientWs.readyState === WebSocket.OPEN) {
            const pcm24 = Buffer.from(msg.delta, "base64");
            const pcm16 = downsample24to16(pcm24);
            clientWs.send(pcm16, { binary: true });
          }
          return;
        }

      } catch(e) {}

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data);
      }
    } else {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: true });
      }
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
