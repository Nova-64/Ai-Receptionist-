const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");

const auth = new GoogleAuth({
  keyFile: "credentials.json",
  scopes: ["https://www.googleapis.com/auth/calendar"],
});

const calendar = google.calendar({ version: "v3", auth });

function estimateEndTime(startTime) {
  const start = new Date(startTime);
  const end = new Date(start.getTime() + 60 * 60 * 1000); // default to 1 hour later
  return end.toISOString();
}

async function createBooking({ service, date, time, email }) {
  if (!service || !date || !time || !email) {
    throw new Error("Missing required booking details");
  }

  const startTimeISO = new Date(`${date} ${time}`).toISOString();
  const endTimeISO = estimateEndTime(startTimeISO);

  const event = {
    summary: `${service} Appointment`,
    description: `Booking for ${service} at Nova Salon`,
    start: { dateTime: startTimeISO, timeZone: "America/New_York" },
    end: { dateTime: endTimeISO, timeZone: "America/New_York" },
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
    console.error("❌ Error creating booking:", error.message || error);
    throw error;
  }
}

module.exports = { createBooking };

