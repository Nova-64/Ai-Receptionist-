const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");

// Setup auth
const auth = new GoogleAuth({
  keyFile: "credentials.json", // Replace with your actual credentials file
  scopes: ["https://www.googleapis.com/auth/calendar"],
});

const calendar = google.calendar({ version: "v3", auth });

async function createBooking({ summary, description, startTime, endTime, email }) {
  const event = {
    summary,
    description,
    start: { dateTime: startTime, timeZone: "America/New_York" },
    end: { dateTime: endTime, timeZone: "America/New_York" },
    attendees: [{ email }],
  };

  try {
    const response = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
    });
    console.log("✅ Booking created:", response.data.htmlLink);
    return response.data;
  } catch (error) {
    console.error("❌ Error creating booking:", error);
    throw error;
  }
}

module.exports = { createBooking };
