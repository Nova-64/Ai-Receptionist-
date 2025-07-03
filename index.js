const express = require("express");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const twilio = require("twilio");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { createBooking } = require("./googlecalendar");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const salonInfo = `
You are an AI receptionist for Nova Salon.

📍 123 Beauty St, New York, NY

🕐 Hours:
Mon–Wed: 10 AM – 6 PM
Thu–Fri: 10 AM – 8 PM
Sat: 9 AM – 6 PM
Sun: 11 AM – 4 PM

💅 Services:
Gel Manicure ($40), Acrylic Full Set ($55), Pedicure ($35), Brow Wax ($15),
Lash Extensions ($80), Silk Press ($70), Box Braids ($150+), Kids Braids ($85)

📋 Policies:
Cancel 24 hrs ahead. Late (>15 mins) may be rescheduled. Walk-ins allowed. No-shows may incur fees.

🛑 Holiday Closures:
New Year's Day, Easter, July 4th, Thanksgiving, Christmas.
`;

function isBookingIntent(input) {
  const bookingKeywords = /book|appointment|schedule|reserve/i;
  return bookingKeywords.test(input);
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

    const userInput = typeof transcriptionResult === "string" ? transcriptionResult : transcriptionResult.text;
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
            "Extract salon booking details as JSON: { service, startTime, endTime, email }. Assume America/New_York timezone. Use best guess if time or email isn't provided."
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
    twiml.pause({ length: 1 });
    twiml.say("Would you like to ask another question? If yes, speak after the beep and press pound.");
    twiml.record({
      maxLength: 20,
      action: "/process",
      transcribe: false,
      finishOnKey: "#"
    });

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
