const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OpenAI Realtime Proxy OK");
});

const wss = new WebSocketServer({ server });

// Даунсемплинг PCM16 с 24kHz до 16kHz (каждый 3й сэмпл из 2)
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
