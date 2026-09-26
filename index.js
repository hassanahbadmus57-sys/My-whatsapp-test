require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// Optional: restrict who can reach your Twilio webhook by checking the
// signature Twilio sends. Left off by default to keep the sandbox setup
// simple, but recommended once you go to production.

if (!GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is not set. Replies will fail until you set it.');
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Very simple in-memory chat history, keyed by WhatsApp number.
// NOTE: this resets whenever the Render service restarts/redeploys/sleeps.
// That's fine for testing; swap in a real DB (e.g. Redis, Postgres) for
// anything you need to persist.
const conversations = new Map();
const MAX_TURNS = 6; // how many back-and-forth exchanges to remember per user

const SYSTEM_INSTRUCTION =
  'You are a helpful, concise WhatsApp assistant. Keep replies short and ' +
  'friendly, suitable for a chat window. Avoid markdown formatting like ' +
  'asterisks or headers since WhatsApp renders them oddly.';

async function getGeminiReply(userId, userMessage) {
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: SYSTEM_INSTRUCTION,
  });

  const history = conversations.get(userId) || [];

  const chat = model.startChat({
    history,
    generationConfig: { maxOutputTokens: 500 },
  });

  const result = await chat.sendMessage(userMessage);
  const replyText = result.response.text().trim();

  history.push({ role: 'user', parts: [{ text: userMessage }] });
  history.push({ role: 'model', parts: [{ text: replyText }] });

  while (history.length > MAX_TURNS * 2) {
    history.shift();
  }
  conversations.set(userId, history);

  return replyText;
}

// Health check — also handy as a Render "is it awake" ping target
app.get('/', (req, res) => {
  res.send('WhatsApp Gemini bot is running.');
});

// Twilio calls this URL whenever someone messages your WhatsApp sandbox number
app.post('/whatsapp', async (req, res) => {
  const incomingMsg = (req.body.Body || '').trim();
  const fromNumber = req.body.From; // e.g. "whatsapp:+2348012345678"

  const twiml = new twilio.twiml.MessagingResponse();

  if (!incomingMsg) {
    twiml.message('Sorry, I did not receive any text.');
    res.type('text/xml').send(twiml.toString());
    return;
  }

  try {
    const replyText = await getGeminiReply(fromNumber, incomingMsg);
    twiml.message(replyText || "Sorry, I couldn't come up with a reply.");
  } catch (err) {
    console.error('Gemini error:', err);
    twiml.message('Sorry, something went wrong on my end. Please try again in a moment.');
  }

  res.type('text/xml').send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
