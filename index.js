const express = require("express");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const twilio = require("twilio");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { createBooking } = require("./googleCalendar");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const sessions = {};

const salonInfo = `
You are an AI receptionist for Nova Salon.

123 Beauty St, New York, NY

Hours of Operation:
- Monday–Wednesday: 10:00 AM – 6:00 PM
- Thursday–Friday: 10:00 AM – 8:00 PM
- Saturday: 9:00 AM – 6:00 PM
- Sunday: 11:00 AM – 4:00 PM

Services and Prices:
- Gel Manicure: $40
- Acrylic Full Set: $55
- Basic Pedicure: $35
- Brow Wax: $15
- Lash Extensions (Classic): $80
- Silk Press: $70
- Box Braids (Medium): $150+
- Kids Braids (Under 10): $85

Policies:
- Cancel/reschedule at least 24 hours in advance.
- Late arrivals over 15 mins may need to reschedule.
- Walk-ins welcome when available.
- No-shows may be charged a cancellation fee.

Holiday Closures:
- New Year's Day, Easter Sunday, July 4th, Thanksgiving, Christmas.
`;

app.post("/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Hi! Welcome to Nova Salon. Please ask your question after the beep, then press the pound key.");
  twiml.record({
    maxLength: 20,
    action: "/process",
    transcribe: false,
    finishOnKey: "#"
  });
  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/process", async (req, res) => {
  const recordingUrl = req.body.RecordingUrl;
  const callId = req.body.CallSid;

  try {
    if (!recordingUrl) throw new Error("No Recording URL found.");

    const fullAudioUrl = `${recordingUrl}.mp3`;
    await new Promise(resolve => setTimeout(resolve, 3000));

    const audioResponse = await axios.get(fullAudioUrl, {
      responseType: "arraybuffer",
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN
      }
    });

    const tempPath = path.join(__dirname, "temp_audio.mp3");
    await fs.promises.writeFile(tempPath, audioResponse.data);

    const transcriptionResult = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1",
      response_format: "text"
    });

    const userInput = typeof transcriptionResult === "string"
      ? transcriptionResult
      : transcriptionResult.text;

    fs.unlink(tempPath, () => {});

    const isSilence =
      !userInput ||
      typeof userInput !== "string" ||
      userInput.trim().length < 2 ||
      /^[\s\p{P}]*$/u.test(userInput);

    if (isSilence) {
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say("I didn’t catch that. Could you please repeat your question after the beep?");
      twiml.redirect("/voice");
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    sessions[callId] ??= {};
    const session = sessions[callId];

    const infoPrompt = [
      {
        role: "system",
        content:
          "Extract booking info in JSON. Format: { service, date, time, email }"
      },
      { role: "user", content: userInput }
    ];

    const infoResponse = await openai.chat.completions.create({
      model: "gpt-4",
      messages: infoPrompt
    });

    try {
      const extracted = JSON.parse(infoResponse.choices[0].message.content);
      if (extracted.service) session.service = extracted.service;
      if (extracted.date) session.date = extracted.date;
      if (extracted.time) session.time = extracted.time;
      if (extracted.email) session.email = extracted.email;
    } catch (err) {
      console.warn("Couldn’t parse booking info:", err.message);
    }

    const chatResponse = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `${salonInfo}\nSession memory:\n${JSON.stringify(session)}`
        },
        { role: "user", content: userInput }
      ]
    });

    let reply = chatResponse.choices[0].message.content || "";
    reply = reply.replace(/[\u{1F600}-\u{1F6FF}]/gu, "").replace(/\n/g, " ").trim();

    if (session.service && session.date && session.time && session.email) {
      try {
        const bookingDetails = {
          service: session.service,
          date: session.date,
          time: session.time,
          email: session.email
        };
        const bookingResponse = await createBooking(bookingDetails);
        console.log("Booking confirmed:", bookingResponse.htmlLink);
        reply += " Your appointment has been booked successfully.";
        delete sessions[callId];
      } catch (error) {
        console.error("Booking error:", error.message);
        reply += " I tried to make the booking, but something went wrong. Please try again later.";
      }
    }

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: "Polly.Joanna" }, reply);
    twiml.pause({ length: 1 });

    const isBookingPrompt = /\b(please (provide|share|tell)|what (date|time|service|name|email)|may I have|could you tell|when would you like|which service)/i.test(reply);
    const isBookingConfirmed = /\b(appointment (has been|is) booked|your appointment is confirmed|confirmation email|booked successfully)/i.test(reply);

    if (isBookingPrompt) {
      twiml.record({
        maxLength: 20,
        action: "/process",
        transcribe: false,
        finishOnKey: "#"
      });
    } else if (isBookingConfirmed) {
      twiml.say("If you have another question, please speak after the beep and press pound. Otherwise, feel free to hang up.");
      twiml.record({
        maxLength: 20,
        action: "/process",
        transcribe: false,
        finishOnKey: "#"
      });
    } else {
      twiml.record({
        maxLength: 20,
        action: "/process",
        transcribe: false,
        finishOnKey: "#"
      });
    }

    res.type("text/xml");
    res.send(twiml.toString());

  } catch (err) {
    console.error("Error:", err.message || err);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Sorry, something went wrong. Please try again later.");
    res.type("text/xml");
    res.send(twiml.toString());
  }
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
