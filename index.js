const express = require("express");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const twilio = require("twilio");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { createBooking } = require("./googlecalendar"); // Make sure path is correct

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const salonInfo = `
You are an AI receptionist for Nova Salon.

📍 123 Beauty St, New York, NY

🕐 Hours of Operation:
- Monday–Wednesday: 10:00 AM – 6:00 PM
- Thursday–Friday: 10:00 AM – 8:00 PM
- Saturday: 9:00 AM – 6:00 PM
- Sunday: 11:00 AM – 4:00 PM

💅 Services and Prices:
- Gel Manicure: $40
- Acrylic Full Set: $55
- Basic Pedicure: $35
- Brow Wax: $15
- Lash Extensions (Classic): $80
- Silk Press: $70
- Box Braids (Medium): $150+
- Kids Braids (Under 10): $85

📋 Policies:
- Cancel/reschedule at least 24 hours in advance.
- Late arrivals over 15 mins may need to reschedule.
- Walk-ins welcome when available.
- No-shows may be charged a cancellation fee.

🛑 Holiday Closures:
- New Year's Day, Easter Sunday, July 4th, Thanksgiving, Christmas.
`;

function isBookingIntent(input) {
  const bookingKeywords = /book|appointment|schedule|reserve/i;
  return bookingKeywords.test(input);
}

function isExitIntent(input) {
  const phrases = [
    "no thanks", "that's all", "no that’s all", "nothing else", "i’m good",
    "goodbye", "thanks goodbye", "no i'm good", "thank you", "bye"
  ];
  return phrases.some(p => input.toLowerCase().includes(p));
}

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

    fs.unlink(tempPath, err => {
      if (err) console.warn("⚠️ Temp file cleanup failed:", err.message);
    });

    const isSilence = !userInput || userInput.trim().length < 2 || /^[\s\p{P}]*$/u.test(userInput);
    if (isSilence) {
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say("I didn’t catch that. Please try again after the beep.");
      twiml.redirect("/voice");
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    let reply = "";

    if (isBookingIntent(userInput)) {
      const intentPrompt = [
        {
          role: "system",
          content:
            "Extract salon booking details as JSON: { summary, description, startTime, endTime, email }. Assume America/New_York timezone. Use best guess if time or email isn't provided."
        },
        { role: "user", content: userInput }
      ];

      const intentResponse = await openai.chat.completions.create({
        model: "gpt-4",
        messages: intentPrompt
      });

      let bookingDetails = {};

      try {
        bookingDetails = JSON.parse(intentResponse.choices[0].message.content);

        // Fill fallback summary/description if needed
        bookingDetails.summary ??= `${bookingDetails.service} Appointment`;
        bookingDetails.description ??= `Booking for ${bookingDetails.service} at Nova Salon`;

        await createBooking(bookingDetails);
        reply = `You're all set! I’ve booked your ${bookingDetails.service} on ${bookingDetails.startTime}. A confirmation will be emailed to you.`;
      } catch (bookingErr) {
        console.error("🛑 Booking error:", bookingErr.message || bookingErr);
        reply = "I tried to make the booking, but there was a problem. Please try again or speak with our staff directly.";
      }
    } else {
      const chatResponse = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          { role: "system", content: salonInfo },
          { role: "user", content: userInput }
        ]
      });

      reply = chatResponse.choices[0].message.content || "";
    }

    reply = reply.replace(/[\u{1F600}-\u{1F6FF}]/gu, "").replace(/\n/g, " ").trim();

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: "Polly.Joanna" }, reply);

    if (isExitIntent(userInput)) {
      twiml.say("Thank you for calling Nova Salon. Have a wonderful day!");
    } else {
      twiml.pause({ length: 1 });
      twiml.say("If you'd like to ask something else, speak after the beep and press pound. Otherwise, feel free to hang up.");
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
    console.error("❌ Error:", err.message || err);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Sorry, something went wrong. Please try again later.");
    res.type("text/xml");
    res.send(twiml.toString());
  }
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});

